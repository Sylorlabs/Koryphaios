/**
 * CheckpointStore — Git-based checkpoint system for time travel / undo.
 *
 * Creates "ghost commits" (dangling, unreachable commits via `git commit-tree`)
 * that capture repository state after AI agent changes. Checkpoints are stored
 * in `refs/kory/checkpoints/` with metadata in git notes, and a per-session
 * manifest ref (`refs/kory/manifests/`) enables O(1) timeline reads.
 *
 * Design:
 * - All git ops go through GitExecutor (mutex-serialized, timeout-protected).
 * - Per-session AsyncMutex serializes checkpoint creation so the manifest
 *   read-modify-write is atomic and cursor ordering is deterministic.
 * - Monotonic sequence numbers per session prevent cursor races.
 * - Temp index dirs live under .koryphaios/tmp/ (not OS tmpdir) and are
 *   swept on startup to prevent leak-on-crash. Only dirs older than the
 *   process start time are swept, so concurrent constructions don't race.
 * - Metadata attachment failures are surfaced, not silently swallowed.
 * - Backward compatible: reads metadata from both the new notes ref and the
 *   legacy `refs/notes/shadow-logger` ref so existing checkpoints survive upgrade.
 */

import { koryLog, serverLog } from '../logger';
import { AsyncMutex } from './git-mutex';
import { GitExecutor } from './git-executor';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface CheckpointFileChange {
  path: string;
  operation: 'create' | 'edit' | 'delete';
}

export interface GhostCommitMetadata {
  /** Unique ID for this ghost commit */
  id: string;
  /** Monotonic sequence number per session (prevents cursor races). */
  sequence?: number;
  /** Model name used (e.g., "claude-sonnet-4-5") */
  model?: string;
  /** The prompt/task that generated these changes */
  prompt?: string;
  /** SHA-256 of the complete prompt. New checkpoints do not retain prompt text. */
  promptHash?: string;
  /** Cost in USD for this operation */
  cost?: number;
  /** Tokens consumed */
  tokensIn?: number;
  /** Tokens generated */
  tokensOut?: number;
  /** Agent/session ID that created this */
  agentId?: string;
  /** The ID of the last session message when this checkpoint was created */
  messageId?: string;
  /** The type of checkpoint (e.g., 'turn_end', 'user_manual') */
  checkpointType?: 'turn_end' | 'user_manual' | 'auto_save' | 'recovery_backup';
  /** Repo-relative files attributed to this session. */
  changedFiles?: CheckpointFileChange[];
  /** Timestamp */
  timestamp: number;
}

export interface GhostCommit {
  /** The git hash of the ghost commit */
  hash: string;
  /** Parent commit hash */
  parent: string;
  /** Commit message */
  message: string;
  /** When the commit was created */
  date: Date;
  /** Associated metadata from git notes */
  metadata?: GhostCommitMetadata;
  /** File changes summary */
  filesChanged?: Array<{ path: string; status: string }>;
}

export interface TimelineEntry {
  /** Ghost commit hash */
  hash: string;
  /** Human-readable description */
  description: string;
  /** When this state was captured */
  timestamp: number;
  /** Model that made the change */
  model?: string;
  /** Cost of the operation */
  cost?: number;
  /** Can we recover to this state */
  recoverable: boolean;
  /** Linked message ID */
  messageId?: string;
  /** Type of checkpoint */
  checkpointType?: string;
  /** Monotonic sequence number */
  sequence?: number;
}

/** Manifest stored in a git ref for O(1) timeline reads. */
interface CheckpointManifest {
  version: 1;
  nextSequence: number;
  entries: Array<{
    hash: string;
    sequence: number;
    timestamp: number;
    id: string;
    model?: string;
    cost?: number;
    messageId?: string;
    checkpointType?: string;
    description: string;
    agentId?: string;
  }>;
}

/**
 * Maximum number of session locks to retain. When this limit is exceeded,
 * the oldest locks (by last-acquire time) are evicted. This prevents
 * unbounded memory growth in long-running processes with many sessions.
 */
const MAX_SESSION_LOCKS = 128;

export class CheckpointStore {
  private readonly GHOST_PREFIX = '[GHOST]';
  /** New notes ref — used for all new metadata writes. */
  private readonly NOTES_REF = 'refs/notes/checkpoint-store';
  /** Legacy notes ref from the pre-rename ShadowLogger. Read-only fallback
   *  so checkpoints created before the rename still have accessible metadata. */
  private readonly LEGACY_NOTES_REF = 'refs/notes/shadow-logger';
  private readonly CHECKPOINT_REF_ROOT = 'refs/kory/checkpoints';
  private readonly CURSOR_REF_ROOT = 'refs/kory/cursors';
  private readonly MANIFEST_REF_ROOT = 'refs/kory/manifests';

  private git: GitExecutor;
  /** Per-session mutexes serialize checkpoint creation for deterministic ordering. */
  private sessionLocks: Map<string, { mutex: AsyncMutex; lastUsed: number }> = new Map();
  private tempDir: string;
  /** Process start time — used to avoid sweeping temp dirs created by a
   *  concurrent CheckpointStore construction in the same process. */
  private readonly processStartTime: number;

  constructor(private workingDirectory: string) {
    this.git = new GitExecutor(workingDirectory);
    this.tempDir = join(workingDirectory, '.koryphaios', 'tmp', 'checkpoints');
    // Use a slightly earlier threshold so dirs created in the last few seconds
    // of the previous process lifetime aren't falsely considered "ours."
    this.processStartTime = Date.now() - 5_000;
    this.sweepTempDirs();
  }

  /**
   * Sweep orphaned temp index directories from a previous crash.
   * Called on construction to prevent unbounded accumulation in .koryphaios/tmp/.
   *
   * Only removes directories whose modification time is older than this process's
   * start time (minus a 5s safety margin). This prevents a race where two
   * CheckpointStore instances are constructed concurrently and the second
   * sweep deletes the first one's in-progress temp index directory.
   */
  private sweepTempDirs(): void {
    try {
      if (!existsSync(this.tempDir)) return;
      for (const entry of readdirSync(this.tempDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(this.tempDir, entry.name);
        try {
          const stat = statSync(dirPath);
          // Only sweep dirs that existed before this process started.
          if (stat.mtimeMs > this.processStartTime) continue;
          rmSync(dirPath, { recursive: true, force: true });
        } catch {
          // best-effort — a dir may be in use by a concurrent process
        }
      }
    } catch {
      // best-effort
    }
  }

  private getSessionLock(agentId: string): AsyncMutex {
    let entry = this.sessionLocks.get(agentId);
    if (!entry) {
      // Evict oldest lock if we've hit the cap. This bounds memory: a session
      // whose lock was evicted will simply get a fresh mutex on next use —
      // safe because the old session is no longer active.
      if (this.sessionLocks.size >= MAX_SESSION_LOCKS) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [key, val] of this.sessionLocks) {
          if (val.lastUsed < oldestTime) {
            oldestTime = val.lastUsed;
            oldestKey = key;
          }
        }
        if (oldestKey) this.sessionLocks.delete(oldestKey);
      }
      entry = { mutex: new AsyncMutex(), lastUsed: Date.now() };
      this.sessionLocks.set(agentId, entry);
    }
    entry.lastUsed = Date.now();
    return entry.mutex;
  }

  /**
   * Create an immutable checkpoint from the working tree using a private index.
   *
   * The user's index, HEAD, branch and ordinary git log are never modified.
   * Per-session locking ensures the manifest and cursor are updated atomically.
   *
   * @param message Description of what changed
   * @param metadata Optional metadata about the AI operation
   * @returns The ghost commit hash, or null if failed
   */
  async createGhostCommit(
    message: string,
    metadata?: Omit<GhostCommitMetadata, 'id' | 'timestamp' | 'sequence'>,
  ): Promise<string | null> {
    const agentId = metadata?.agentId ?? 'unscoped';
    const session = this.sanitizeRefPart(agentId);

    // Serialize per-session so manifest read-modify-write and cursor update are atomic.
    const release = await this.getSessionLock(session).acquire();
    try {
      const parentResult = await this.git.execCombined(['rev-parse', 'HEAD']);
      if (!parentResult.success) {
        koryLog.error('Failed to get HEAD for ghost commit');
        return null;
      }
      const parent = parentResult.output.trim();

      // Allocate sequence number from manifest
      const manifest = await this.readManifest(session);
      const sequence = manifest.nextSequence;

      const { prompt, changedFiles, ...metadataWithoutPrompt } = metadata ?? {};
      const checkpointMetadata: GhostCommitMetadata = {
        ...metadataWithoutPrompt,
        promptHash: prompt
          ? createHash('sha256').update(prompt).digest('hex')
          : metadataWithoutPrompt.promptHash,
        changedFiles: this.normalizeChangedFiles(changedFiles),
        id: this.generateId(),
        sequence,
        timestamp: Date.now(),
      };

      // Create temp index dir under .koryphaios/tmp/ (not OS tmpdir) so
      // a crash doesn't leak dirs into /tmp that never get swept.
      if (!existsSync(this.tempDir)) mkdirSync(this.tempDir, { recursive: true });
      const privateIndexDirectory = mkdtempSync(join(this.tempDir, 'index-'));
      const privateIndex = join(privateIndexDirectory, 'index');
      const indexEnv = { GIT_INDEX_FILE: privateIndex };
      let tree: string;
      try {
        const readTree = await this.git.exec(['read-tree', parent], { env: indexEnv });
        if (!readTree.success) throw new Error(readTree.stderr);
        const addResult = await this.git.exec(['add', '-A', '--', '.'], { env: indexEnv });
        if (!addResult.success) throw new Error(addResult.stderr);
        const treeResult = await this.git.exec(['write-tree'], { env: indexEnv });
        if (!treeResult.success) throw new Error(treeResult.stderr);
        tree = treeResult.stdout.trim();
      } catch (error) {
        koryLog.error({ error }, 'Failed to create private checkpoint tree');
        return null;
      } finally {
        rmSync(privateIndexDirectory, { recursive: true, force: true });
      }

      // Create the ghost commit using commit-tree (creates dangling commit)
      const ghostMessage = `${this.GHOST_PREFIX} ${message}`;
      const commitResult = await this.git.execCombined([
        'commit-tree', tree, '-p', parent, '-m', ghostMessage,
        '-m', `Kory-Checkpoint-ID: ${checkpointMetadata.id}`,
      ]);

      if (!commitResult.success) {
        koryLog.error({ output: commitResult.output }, 'Failed to create ghost commit');
        return null;
      }

      const ghostHash = commitResult.output.trim();

      // Attach metadata — surface failures instead of silently swallowing.
      const metadataOk = await this.attachMetadata(ghostHash, checkpointMetadata);
      if (!metadataOk) {
        koryLog.warn(
          { ghostHash },
          'Checkpoint created but metadata attachment failed — timeline will show limited info',
        );
      }

      // Store checkpoint ref
      const checkpointRef = `${this.CHECKPOINT_REF_ROOT}/${session}/${checkpointMetadata.timestamp}-${this.sanitizeRefPart(checkpointMetadata.id)}`;
      const refResult = await this.git.execCombined(['update-ref', checkpointRef, ghostHash]);
      if (!refResult.success) {
        koryLog.error({ checkpointRef, output: refResult.output }, 'Failed to retain checkpoint ref');
        return null;
      }

      // Update manifest (atomic within session lock)
      manifest.entries.push({
        hash: ghostHash,
        sequence,
        timestamp: checkpointMetadata.timestamp,
        id: checkpointMetadata.id,
        model: checkpointMetadata.model,
        cost: checkpointMetadata.cost,
        messageId: checkpointMetadata.messageId,
        checkpointType: checkpointMetadata.checkpointType,
        description: message,
        agentId: metadata?.agentId,
      });
      manifest.nextSequence = sequence + 1;
      await this.writeManifest(session, manifest);

      // Update cursor — only if this checkpoint is newer than the current cursor
      await this.setCursorIfNewer(agentId, ghostHash, sequence);

      koryLog.info({ ghostHash, checkpointRef, message, sequence }, 'Checkpoint created');

      return ghostHash;
    } finally {
      release();
    }
  }

  async getCursor(agentId: string): Promise<string | null> {
    const result = await this.git.execCombined([
      'rev-parse', '--verify', `${this.CURSOR_REF_ROOT}/${this.sanitizeRefPart(agentId)}`,
    ]);
    return result.success ? result.output.trim() : null;
  }

  async setCursor(agentId: string | undefined, hash: string): Promise<boolean> {
    if (!agentId) return false;
    return (
      await this.git.execCombined([
        'update-ref', `${this.CURSOR_REF_ROOT}/${this.sanitizeRefPart(agentId)}`, hash,
      ])
    ).success;
  }

  /**
   * Set cursor only if the new checkpoint's sequence is higher than the
   * current cursor's sequence. Prevents last-wins races across concurrent
   * checkpoint creators.
   */
  private async setCursorIfNewer(agentId: string, hash: string, sequence: number): Promise<void> {
    const currentHash = await this.getCursor(agentId);
    if (currentHash) {
      const currentMeta = await this.getMetadata(currentHash);
      if (currentMeta?.sequence !== undefined && currentMeta.sequence >= sequence) {
        return; // current cursor is newer or equal — don't regress
      }
    }
    await this.setCursor(agentId, hash);
  }

  async isOwnedCheckpoint(hash: string, agentId: string): Promise<boolean> {
    if ((await this.getMetadata(hash))?.agentId !== agentId) return false;
    const refs = await this.git.execCombined([
      'for-each-ref', '--format=%(objectname)',
      `${this.CHECKPOINT_REF_ROOT}/${this.sanitizeRefPart(agentId)}`,
    ]);
    return refs.success && refs.output.split('\n').includes(hash);
  }

  async worktreePathMatches(hash: string, path: string): Promise<boolean> {
    const normalized = this.normalizeChangedFiles([{ path, operation: 'edit' }])?.[0]?.path;
    if (!normalized) return false;
    const expected = await this.git.execCombined(['rev-parse', `${hash}:${normalized}`]);
    const absolute = resolve(this.workingDirectory, normalized);
    if (!expected.success) return !existsSync(absolute);
    if (!existsSync(absolute)) return false;
    const actual = await this.git.execCombined(['hash-object', '--', normalized]);
    return actual.success && actual.output.trim() === expected.output.trim();
  }

  /**
   * Attach metadata to a ghost commit using git notes.
   * @returns true on success, false on failure (surfaced to caller).
   */
  private async attachMetadata(hash: string, metadata: GhostCommitMetadata): Promise<boolean> {
    const notesContent = JSON.stringify(metadata, null, 2);

    const result = await this.git.execCombined([
      'notes', '--ref', this.NOTES_REF, 'add', '-f', '-m', notesContent, hash,
    ]);

    if (!result.success) {
      koryLog.warn({ hash, output: result.output }, 'Failed to attach metadata to checkpoint');
      return false;
    }
    return true;
  }

  /**
   * Get metadata attached to a commit.
   *
   * Tries the new notes ref first, then falls back to the legacy
   * `refs/notes/shadow-logger` ref so checkpoints created before the
   * rename still have accessible metadata after upgrade.
   */
  async getMetadata(hash: string): Promise<GhostCommitMetadata | undefined> {
    // Try the current notes ref first.
    const result = await this.git.execCombined(['notes', '--ref', this.NOTES_REF, 'show', hash]);
    if (result.success) {
      try {
        return JSON.parse(result.output) as GhostCommitMetadata;
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to parse checkpoint metadata from git notes');
      }
    }

    // Fall back to the legacy notes ref for pre-rename checkpoints.
    const legacyResult = await this.git.execCombined([
      'notes', '--ref', this.LEGACY_NOTES_REF, 'show', hash,
    ]);
    if (legacyResult.success) {
      try {
        return JSON.parse(legacyResult.output) as GhostCommitMetadata;
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to parse legacy checkpoint metadata from git notes');
      }
    }

    return undefined;
  }

  /**
   * Get the timeline of checkpoints — O(1) via the manifest ref.
   *
   * Falls back to the legacy for-each-ref + git-notes approach (and builds
   * the manifest) if no manifest exists yet (first read after upgrade).
   *
   * @param limit Maximum number of entries to return (default: 50)
   * @returns Array of timeline entries, newest first
   */
  async getTimeline(limit = 50, filterAgentId?: string): Promise<TimelineEntry[]> {
    const session = filterAgentId ? this.sanitizeRefPart(filterAgentId) : undefined;

    // Try manifest first (O(1))
    if (session) {
      const manifest = await this.readManifest(session);
      // If the manifest exists (has been built before), use it — even if empty.
      // An empty manifest means all checkpoints were pruned; falling back to
      // the legacy path would re-discover them via reflog and rebuild a stale
      // manifest. We only fall back when the manifest has never been built
      // (entries.length === 0 AND nextSequence === 0 — the initial state).
      if (manifest.entries.length > 0 || manifest.nextSequence > 0) {
        return manifest.entries
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit)
          .map((e) => ({
            hash: e.hash,
            description: e.description,
            timestamp: e.timestamp,
            model: e.model,
            cost: e.cost,
            recoverable: true,
            messageId: e.messageId,
            checkpointType: e.checkpointType,
            sequence: e.sequence,
          }));
      }
    }

    // Legacy fallback: build timeline from refs + git notes (and populate manifest)
    return this.getTimelineLegacy(limit, filterAgentId);
  }

  /**
   * Legacy timeline building — scans checkpoint refs and reflog, fetches
   * metadata via git notes (N+1). Also builds the manifest for future O(1) reads.
   */
  private async getTimelineLegacy(limit: number, filterAgentId?: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    const seenHashes = new Set<string>();
    const refsResult = await this.git.execCombined([
      'for-each-ref', '--sort=-creatordate',
      '--format=%(objectname)|%(refname)|%(creatordate:unix)|%(subject)',
      this.CHECKPOINT_REF_ROOT,
    ]);

    // Track entries by session for manifest building
    const manifestUpdates: Map<string, CheckpointManifest> = new Map();

    if (refsResult.success) {
      for (const line of refsResult.output.split('\n').filter(Boolean)) {
        const [hash, ref, timestamp, subject] = line.split('|');
        if (!hash || seenHashes.has(hash)) continue;
        const metadata = await this.getMetadata(hash);
        if (filterAgentId && metadata?.agentId !== filterAgentId) continue;
        seenHashes.add(hash);
        entries.push({
          hash,
          description: this.formatDescription(subject ?? '', metadata),
          timestamp: metadata?.timestamp ?? (timestamp ? parseInt(timestamp) * 1000 : Date.now()),
          model: metadata?.model,
          cost: metadata?.cost,
          recoverable: true,
          messageId: metadata?.messageId,
          checkpointType: metadata?.checkpointType,
          sequence: metadata?.sequence,
        });

        // Collect for manifest building
        if (metadata?.agentId) {
          const session = this.sanitizeRefPart(metadata.agentId);
          let m = manifestUpdates.get(session);
          if (!m) {
            m = { version: 1, nextSequence: 0, entries: [] };
            manifestUpdates.set(session, m);
          }
          m.entries.push({
            hash,
            sequence: metadata.sequence ?? 0,
            timestamp: metadata.timestamp,
            id: metadata.id,
            model: metadata.model,
            cost: metadata.cost,
            messageId: metadata.messageId,
            checkpointType: metadata.checkpointType,
            description: this.formatDescription(subject ?? '', metadata),
            agentId: metadata.agentId,
          });
          m.nextSequence = Math.max(m.nextSequence, (metadata.sequence ?? 0) + 1);
        }
      }
    }

    // Backward compatibility: reflog discovery for pre-ref checkpoints
    const reflogResult = await this.git.execCombined([
      'reflog', 'show', 'HEAD', '--format=%H|%gd|%gs|%ct', '-n', String(limit * 5),
    ]);

    if (reflogResult.success) {
      for (const line of reflogResult.output.split('\n').filter(Boolean)) {
        const [hash, _reflogSelector, subject, timestamp] = line.split('|');
        if (!hash || seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        const isGhost = subject?.includes(this.GHOST_PREFIX) || subject?.startsWith('ghost:');
        const metadata = await this.getMetadata(hash);
        if (filterAgentId && metadata?.agentId !== filterAgentId) continue;
        if (isGhost || metadata) {
          entries.push({
            hash,
            description: this.formatDescription(subject, metadata),
            timestamp: timestamp ? parseInt(timestamp) * 1000 : Date.now(),
            model: metadata?.model,
            cost: metadata?.cost,
            recoverable: true,
            messageId: metadata?.messageId,
            checkpointType: metadata?.checkpointType,
            sequence: metadata?.sequence,
          });
        }
        if (entries.length >= limit) break;
      }
    }

    // Build manifests from legacy data for future O(1) reads
    for (const [session, manifest] of manifestUpdates) {
      await this.writeManifest(session, manifest);
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * Get detailed ghost commit information
   */
  async getGhostCommit(hash: string): Promise<GhostCommit | null> {
    const catResult = await this.git.execCombined(['cat-file', '-t', hash]);
    if (!catResult.success || catResult.output !== 'commit') {
      return null;
    }

    const showResult = await this.git.execCombined(['show', hash, '--format=%H|%P|%s|%ct', '--no-patch']);
    if (!showResult.success) return null;

    const [commitHash, parent, subject, timestamp] = showResult.output.split('|');

    const diffResult = await this.git.execCombined([
      'diff-tree', '--no-commit-id', '--name-status', '-r', hash,
    ]);

    const filesChanged = diffResult.success
      ? diffResult.output
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [status, path] = line.split('\t');
            return { path: path || '', status: status || '' };
          })
      : [];

    return {
      hash: commitHash || hash,
      parent: parent?.split(' ')[0] || '',
      message: subject || '',
      date: new Date(parseInt(timestamp || '0') * 1000),
      metadata: await this.getMetadata(hash),
      filesChanged,
    };
  }

  /**
   * Recover to a specific ghost commit state
   *
   * Restores the checkpoint into the index/worktree without moving HEAD or the branch.
   */
  async recover(
    ghostHash: string,
    options: { agentId: string; changedFiles: CheckpointFileChange[] },
  ): Promise<{ success: boolean; message: string; previousHash?: string }> {
    const ghost = await this.getGhostCommit(ghostHash);
    if (!ghost) {
      return { success: false, message: 'Ghost commit not found' };
    }
    if (!(await this.isOwnedCheckpoint(ghostHash, options.agentId))) {
      return { success: false, message: 'Checkpoint does not belong to this session' };
    }
    const previousCursor = (await this.getCursor(options.agentId)) ?? undefined;
    const changes = this.normalizeChangedFiles(options.changedFiles) ?? [];
    const paths = changes.map((change) => change.path);
    if (paths.length === 0) {
      await this.setCursor(options.agentId, ghostHash);
      return {
        success: true,
        message: `Recovered conversation checkpoint: ${ghost.message.slice(0, 50)}`,
        previousHash: previousCursor,
      };
    }

    // Create a recovery point before we reset (safety net)
    let recoveryBackup: string | undefined;
    if (previousCursor) {
      recoveryBackup =
        (await this.createGhostCommit('Auto-save before recovery', {
          agentId: options.agentId,
          prompt: 'Automatic checkpoint before time travel recovery',
          checkpointType: 'recovery_backup',
          changedFiles: changes,
        })) ?? undefined;
    }

    const existingAtTarget: string[] = [];
    const absentAtTarget: string[] = [];
    for (const path of paths) {
      const exists = await this.git.execCombined(['cat-file', '-e', `${ghostHash}:${path}`]);
      (exists.success ? existingAtTarget : absentAtTarget).push(path);
    }
    if (existingAtTarget.length > 0) {
      const restored = await this.git.execCombined([
        'restore', '--source', ghostHash, '--staged', '--worktree', '--', ...existingAtTarget,
      ]);
      if (!restored.success) {
        koryLog.error({ ghostHash, output: restored.output }, 'Recovery failed');
        return { success: false, message: 'Restore failed: ' + restored.output };
      }
    }
    for (const path of absentAtTarget) {
      await this.git.execCombined(['rm', '-f', '--ignore-unmatch', '--', path]);
      const absolute = resolve(this.workingDirectory, path);
      const rel = relative(resolve(this.workingDirectory), absolute);
      if (rel && rel !== '..' && !rel.startsWith('../')) rmSync(absolute, { force: true });
    }
    await this.setCursor(options.agentId, ghostHash);

    koryLog.info({ ghostHash, previousHash: recoveryBackup }, 'Recovered session checkpoint');

    return {
      success: true,
      message: `Recovered to state: ${ghost.message.slice(0, 50)}`,
      previousHash: recoveryBackup,
    };
  }

  /**
   * Compare current state with a ghost commit
   */
  async compareWithGhost(ghostHash: string): Promise<string> {
    const result = await this.git.execCombined(['diff', ghostHash, 'HEAD']);
    return result.success ? result.output : '';
  }

  /**
   * Clean up old checkpoints — removes refs older than the specified days.
   * Also cleans up the corresponding manifest entries.
   *
   * @param olderThanDays Remove checkpoints older than this many days
   * @returns Number of entries removed
   */
  async prune(olderThanDays = 30): Promise<{ removed: number; message: string }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const refs = await this.git.execCombined([
      'for-each-ref', '--format=%(refname)|%(creatordate:unix)', this.CHECKPOINT_REF_ROOT,
    ]);
    if (!refs.success) return { removed: 0, message: 'Failed to list checkpoints' };

    let removed = 0;
    const sessionsWithRemovals = new Set<string>();

    for (const line of refs.output.split('\n').filter(Boolean)) {
      const [ref, timestamp] = line.split('|');
      if (ref && Number(timestamp) * 1000 < cutoffDate.getTime()) {
        const deleted = await this.git.execCombined(['update-ref', '-d', ref]);
        if (deleted.success) {
          removed++;
          // Extract session from ref path: refs/kory/checkpoints/{session}/...
          // parts[0]=refs, [1]=kory, [2]=checkpoints, [3]=session
          const parts = ref.split('/');
          if (parts.length >= 4) sessionsWithRemovals.add(parts[3]);
        }
      }
    }

    // Rebuild manifests for affected sessions
    for (const session of sessionsWithRemovals) {
      await this.rebuildManifest(session);
    }

    koryLog.info({ olderThanDays, removed }, 'Pruned old checkpoints');

    return {
      removed,
      message: `Pruned ${removed} checkpoints older than ${olderThanDays} days`,
    };
  }

  /**
   * Get statistics about checkpoints
   */
  async getStats(): Promise<{
    totalGhosts: number;
    totalCost: number;
    modelsUsed: string[];
    oldestGhost?: Date;
    newestGhost?: Date;
  }> {
    const timeline = await this.getTimeline(1000);
    const ghosts = timeline.filter((e) => e.recoverable);

    const costs = ghosts.map((g) => g.cost || 0);
    const totalCost = costs.reduce((a, b) => a + b, 0);

    const models = new Set(ghosts.map((g) => g.model).filter(Boolean) as string[]);

    const timestamps = ghosts.map((g) => g.timestamp).sort((a, b) => a - b);

    return {
      totalGhosts: ghosts.length,
      totalCost,
      modelsUsed: Array.from(models),
      oldestGhost: timestamps.length > 0 ? new Date(timestamps[0]) : undefined,
      newestGhost: timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]) : undefined,
    };
  }

  // ─── Manifest Management ──────────────────────────────────────────────────

  private async readManifest(session: string): Promise<CheckpointManifest> {
    const ref = `${this.MANIFEST_REF_ROOT}/${session}`;
    const result = await this.git.execCombined(['cat-file', 'blob', ref]);
    if (!result.success) {
      return { version: 1, nextSequence: 0, entries: [] };
    }
    try {
      return JSON.parse(result.output) as CheckpointManifest;
    } catch {
      return { version: 1, nextSequence: 0, entries: [] };
    }
  }

  private async writeManifest(session: string, manifest: CheckpointManifest): Promise<void> {
    const content = JSON.stringify(manifest);
    // Use stdin to pipe content to `git hash-object --stdin -w` — no temp file needed.
    const result = await this.git.exec(['hash-object', '-w', '--stdin'], { stdin: content });
    if (!result.success || !result.stdout.trim()) {
      koryLog.warn({ session, stderr: result.stderr }, 'Failed to write manifest blob — timeline will use legacy path');
      return;
    }
    const blobSha = result.stdout.trim();

    const ref = `${this.MANIFEST_REF_ROOT}/${session}`;
    await this.git.execCombined(['update-ref', ref, blobSha]);
  }

  /** Rebuild manifest from checkpoint refs + git notes (after pruning). */
  private async rebuildManifest(session: string): Promise<void> {
    const refs = await this.git.execCombined([
      'for-each-ref', '--sort=creatordate',
      '--format=%(objectname)|%(refname)|%(creatordate:unix)|%(subject)',
      `${this.CHECKPOINT_REF_ROOT}/${session}`,
    ]);

    // Start with nextSequence = 1 so an empty manifest (all pruned) is still
    // distinguishable from "never built" (nextSequence = 0). This prevents
    // getTimeline from falling back to the legacy path and re-discovering
    // pruned checkpoints via reflog.
    const manifest: CheckpointManifest = { version: 1, nextSequence: 1, entries: [] };

    if (refs.success) {
      for (const line of refs.output.split('\n').filter(Boolean)) {
        const [hash, _ref, timestamp, subject] = line.split('|');
        if (!hash) continue;
        const metadata = await this.getMetadata(hash);
        manifest.entries.push({
          hash,
          sequence: metadata?.sequence ?? 0,
          timestamp: metadata?.timestamp ?? (timestamp ? parseInt(timestamp) * 1000 : Date.now()),
          id: metadata?.id ?? `legacy_${hash.slice(0, 8)}`,
          model: metadata?.model,
          cost: metadata?.cost,
          messageId: metadata?.messageId,
          checkpointType: metadata?.checkpointType,
          description: this.formatDescription(subject ?? '', metadata),
          agentId: metadata?.agentId,
        });
        manifest.nextSequence = Math.max(manifest.nextSequence, (metadata?.sequence ?? 0) + 1);
      }
    }

    await this.writeManifest(session, manifest);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private generateId(): string {
    return `ghost_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private sanitizeRefPart(value: string): string {
    const sanitized = value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+|\.+$/g, '')
      .replace(/\.\.+/g, '.')
      .slice(0, 80);
    return sanitized || 'unscoped';
  }

  private normalizeChangedFiles(
    changes?: CheckpointFileChange[],
  ): CheckpointFileChange[] | undefined {
    if (!changes) return undefined;
    const root = resolve(this.workingDirectory);
    const normalized = new Map<string, CheckpointFileChange['operation']>();
    for (const change of changes) {
      const path = relative(root, resolve(root, change.path)).replaceAll('\\', '/');
      if (!path || path === '..' || path.startsWith('../')) continue;
      normalized.set(path, change.operation);
    }
    return Array.from(normalized, ([path, operation]) => ({ path, operation }));
  }

  private formatDescription(subject: string, metadata?: GhostCommitMetadata): string {
    let desc = subject
      .replace(new RegExp(`^${this.GHOST_PREFIX}\\s*`), '')
      .replace(/^ghost:\s*/, '');

    if (metadata?.prompt) {
      desc = metadata.prompt.slice(0, 60) + (metadata.prompt.length > 60 ? '...' : '');
    }

    return desc || 'Unnamed state';
  }
}

export class CheckpointStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointStoreError';
  }
}
