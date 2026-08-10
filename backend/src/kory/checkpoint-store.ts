/**
 * CheckpointStore — Git-based checkpoint system for time travel / undo.
 *
 * Creates "ghost commits" via `git commit-tree`
 * that capture repository state after AI agent changes. Checkpoints are stored
 * in `refs/kory/checkpoints/` with metadata in dedicated blob refs, and a per-session
 * manifest ref (`refs/kory/manifests/`) enables O(1) timeline reads.
 *
 * Design:
 * - All git ops go through GitExecutor (mutex-serialized, timeout-protected).
 * - A common-Git directory lock serializes complete multi-command
 *   transactions across CheckpointStore instances, processes, and worktrees.
 * - Per-store session mutexes preserve caller order without serving as the
 *   authoritative durability boundary.
 * - Monotonic sequence numbers per session prevent cursor races.
 * - Temp index dirs live under the common Git directory (not OS tmpdir) and are
 *   swept under the repository lock before creation to prevent leak-on-crash.
 * - Constructors are side-effect free; initialization is lazy, coalesced,
 *   repairable, and fail-closed.
 * - Metadata attachment failures are surfaced, not silently swallowed.
 * - Backward compatible: reads metadata from both the new notes ref and the
 *   legacy `refs/notes/shadow-logger` ref so existing checkpoints survive upgrade.
 */

import { koryLog, serverLog } from '../logger';
import { AsyncMutex } from './git-mutex';
import { GitExecutor } from './git-executor';
import { ShadowRepo } from './shadow-repo';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { redactSecretsInText } from '../security';

/** Operational logs never receive raw Git output or error objects. This
 *  preserves a bounded, redacted diagnostic without copying checkpoint data,
 *  remote credentials, or arbitrarily large hook output into log sinks. */
export function checkpointLogPreview(value: unknown, maxLength = 1_200): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  return redactSecretsInText(text, maxLength);
}

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
  /** Main-repository HEAD used to seed this standalone root snapshot. */
  baseHead?: string;
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
  /** The type of checkpoint */
  checkpointType?:
    | 'turn_end'
    | 'user_manual'
    | 'auto_save'
    | 'recovery_backup'
    | 'goal_checkpoint'
    | 'agent_manual';
  /** Repo-relative files attributed to this session. */
  changedFiles?: CheckpointFileChange[];
  /** Timestamp */
  timestamp: number;

  // ─── Rich instrumentation (lightweight by default) ──────────────────────

  /** Summary line shown in collapsed view — like a git commit subject.
   *  Currently derived from the prompt; will be LLM-chosen in a follow-up. */
  summary?: string;

  /** Tool calls executed during this turn. Previews are truncated to keep
   *  the git notes blob small. Full tool call history lives in the session
   *  transcript (MessageStore). */
  toolCalls?: Array<{
    name: string;
    inputPreview?: string;
    resultPreview?: string;
    durationMs?: number;
    isError?: boolean;
  }>;

  /** Shell commands run during this turn. */
  commands?: Array<{
    command: string;
    exitCode?: number | null;
    durationMs?: number;
  }>;

  /** File edits with before/after line counts. */
  fileEdits?: Array<{
    path: string;
    operation: 'create' | 'edit' | 'delete';
    linesAdded?: number;
    linesDeleted?: number;
  }>;

  /** Conversation transcript for this turn. Stores previews and pointers —
   *  the full transcript is in MessageStore, keyed by `messageIds`. */
  transcript?: {
    userMessagePreview?: string;
    assistantResponsePreview?: string;
    reasoningPreview?: string;
    messageIds?: string[];
    messageCount?: number;
  };

  /** Provider name (e.g., "anthropic", "openai") */
  provider?: string;
  /** Reasoning level used for this turn */
  reasoningLevel?: string;

  /** Counts are captured before bounded previews are sliced, so the timeline
   * remains truthful even when a very large turn stores only representative
   * evidence rows. */
  evidenceCounts?: {
    toolCalls: number;
    commands: number;
    fileEdits: number;
    messages: number;
  };
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
  /** Human-readable description (summary or prompt-derived) */
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
  /** LLM-chosen or derived summary (the "relevant name") */
  summary?: string;
  /** Number of tool calls (lightweight indicator, no detail) */
  toolCallCount?: number;
  /** Number of shell commands (lightweight indicator) */
  commandCount?: number;
  /** Number of file edits (lightweight indicator) */
  fileEditCount?: number;
  /** Whether expandable rich metadata exists */
  hasRichMetadata?: boolean;
}

/** Receipt for compensating a successfully applied workspace recovery if a
 * later participant (for example the conversation database) cannot commit. */
export interface CheckpointRecoveryReceipt {
  agentId: string;
  targetHash: string;
  previousCursor: string;
  recoveryBackupHash?: string;
  changedFiles: CheckpointFileChange[];
  /** Durable cross-resource operation journal, when Time Travel coordinates
   * the workspace with a retained conversation boundary. */
  operationId?: string;
}

export interface CheckpointRecoveryResult {
  success: boolean;
  message: string;
  /** Previous public session cursor. Retained for API compatibility. */
  previousHash?: string;
  recoveryBackupHash?: string;
  receipt?: CheckpointRecoveryReceipt;
}

export type RecoveryOperationPhase = 'prepared' | 'backup_ready' | 'workspace_applied';

/** Durable two-phase journal stored in the private shadow repository. It is
 * intentionally structural: message identifiers and bounded path ownership,
 * never prompt or transcript content. */
export interface RecoveryOperation {
  version: 1;
  id: string;
  agentId: string;
  previousCursor: string;
  targetHash: string;
  previousMessageId: string | null;
  targetMessageId: string | null;
  changedFiles: CheckpointFileChange[];
  phase: RecoveryOperationPhase;
  recoveryBackupHash?: string;
  createdAt: number;
  updatedAt: number;
}

interface RecoveryOperationState {
  operation: RecoveryOperation;
  oid: string;
  ref: string;
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
    summary?: string;
    toolCallCount?: number;
    commandCount?: number;
    fileEditCount?: number;
    hasRichMetadata?: boolean;
  }>;
}

interface ManifestState {
  manifest: CheckpointManifest;
  manifestOid: string | null;
  highWaterOid: string | null;
  needsRepair: boolean;
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
  private readonly METADATA_REF_ROOT = 'refs/kory/metadata';
  private readonly HIGH_WATER_REF_ROOT = 'refs/kory/high-water';
  private readonly RECOVERY_BACKUP_REF_ROOT = 'refs/kory/recovery-backups';
  private readonly RECOVERY_OPERATION_REF_ROOT = 'refs/kory/recovery-operations';
  private readonly RECOVERY_HOLD_REF_ROOT = 'refs/kory/recovery-holds';

  /** Main-repo executor — for HEAD, index, and worktree operations. */
  private git: GitExecutor;
  /** Shadow-repo executor — for ghost commit objects, refs, notes, manifests. */
  private shadowGit: GitExecutor;
  /** Per-session mutexes preserve caller ordering inside this store. The
   * ShadowRepo filesystem lock is the authoritative cross-store/process
   * transaction boundary. */
  private sessionLocks: Map<string, { mutex: AsyncMutex; lastUsed: number; users: number }> =
    new Map();
  private tempDir: string;
  /** Lazily cached initialization. Constructors are side-effect free, which
   * prevents abandoned stores from racing teardown or another initializer. */
  private shadowReady?: Promise<void>;

  constructor(private workingDirectory: string) {
    this.git = new GitExecutor(workingDirectory);
    this.shadowGit = new GitExecutor(workingDirectory, ShadowRepo.shadowEnv(workingDirectory));
    this.tempDir = join(dirname(ShadowRepo.shadowPath(workingDirectory)), 'tmp', 'checkpoints');
  }

  /**
   * Sweep orphaned temp index directories from a previous crash.
   * Called before checkpoint creation to prevent unbounded accumulation in
   * .koryphaios/tmp/.
   *
   * Called only while holding ShadowRepo's cross-process exclusive lock, so
   * every directory here is from an interrupted earlier operation rather than
   * a concurrent live checkpoint.
   */
  private sweepTempDirs(): void {
    try {
      if (!existsSync(this.tempDir)) return;
      for (const entry of readdirSync(this.tempDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(this.tempDir, entry.name);
        try {
          statSync(dirPath);
          rmSync(dirPath, { recursive: true, force: true });
        } catch {
          // best-effort — an entry may disappear during external cleanup
        }
      }
    } catch {
      // best-effort
    }
  }

  /**
   * Ensure the shadow repo is initialized before any shadow git operation.
   * The first real operation starts initialization. A rejected initialization
   * is not cached permanently, allowing an operator to repair a corrupt path
   * and retry without reconstructing every service.
   */
  private async ensureShadowReady(): Promise<void> {
    if (!this.shadowReady) {
      const pending = ShadowRepo.ensure(this.workingDirectory).then(() => undefined);
      this.shadowReady = pending.catch((error) => {
        this.shadowReady = undefined;
        throw error;
      });
    }
    await this.shadowReady;
  }

  private async acquireSessionLock(agentId: string): Promise<() => void> {
    let entry = this.sessionLocks.get(agentId);
    if (!entry) {
      // Evict only an idle entry. Evicting a held mutex lets a later caller
      // create a second mutex for the same session and breaks serialization.
      if (this.sessionLocks.size >= MAX_SESSION_LOCKS) {
        const idle = Array.from(this.sessionLocks.entries())
          .filter(([, value]) => value.users === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (idle) this.sessionLocks.delete(idle[0]);
      }
      entry = { mutex: new AsyncMutex(), lastUsed: Date.now(), users: 0 };
      this.sessionLocks.set(agentId, entry);
    }

    entry.users++;
    entry.lastUsed = Date.now();
    const releaseMutex = await entry.mutex.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseMutex();
      entry!.users--;
      entry!.lastUsed = Date.now();
    };
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
    const agentId = this.validateAgentId(metadata?.agentId ?? 'unscoped') ?? 'unscoped';
    const session = this.sessionRefKey(agentId);

    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        () => this.createGhostCommitLocked(message, metadata, agentId, session, 'checkpoint'),
        `checkpoint publication for ${session}`,
      );
    } finally {
      release();
    }
  }

  private async createGhostCommitLocked(
    message: string,
    metadata: Omit<GhostCommitMetadata, 'id' | 'timestamp' | 'sequence'> | undefined,
    agentId: string,
    session: string,
    publicationMode: 'checkpoint' | 'recovery-backup',
  ): Promise<string | null> {
    this.sweepTempDirs();
    await this.migrateLegacySessionLocked(agentId);

    const headResult = await this.git.exec(['rev-parse', '--verify', 'HEAD']);
    if (!headResult.success || !this.sanitizeObjectId(headResult.stdout.trim())) {
      koryLog.error(
        { output: checkpointLogPreview(headResult.output) },
        'Failed to get HEAD for checkpoint',
      );
      return null;
    }
    const baseHead = headResult.stdout.trim().toLowerCase();
    const state = await this.readManifestState(session, agentId);
    const sequence = state.manifest.nextSequence;
    const timestamp = Date.now();
    const safeMessage = this.sanitizePreview(message, 160) || 'Checkpoint';
    const { prompt, changedFiles, ...metadataWithoutPrompt } = metadata ?? {};
    let checkpointMetadata: GhostCommitMetadata;
    try {
      checkpointMetadata = this.sanitizeMetadata({
        ...metadataWithoutPrompt,
        agentId,
        baseHead,
        promptHash: prompt
          ? createHash('sha256').update(prompt).digest('hex')
          : metadataWithoutPrompt.promptHash,
        changedFiles: this.normalizeChangedFiles(changedFiles),
        id: this.generateId(),
        sequence,
        timestamp,
      });
    } catch (error) {
      koryLog.error(
        { error: checkpointLogPreview(error) },
        'Checkpoint metadata was rejected at the persistence boundary',
      );
      return null;
    }

    if (!existsSync(this.tempDir)) mkdirSync(this.tempDir, { recursive: true });
    const privateIndexDirectory = mkdtempSync(join(this.tempDir, 'index-'));
    const privateIndex = join(privateIndexDirectory, 'index');
    const indexEnv = { GIT_INDEX_FILE: privateIndex };
    let tree: string;
    try {
      const readTree = await this.shadowGit.exec(['read-tree', baseHead], { env: indexEnv });
      if (!readTree.success) throw new Error(readTree.stderr || readTree.stdout);
      // Stage tracked edits/deletions separately from untracked files. Passing
      // the repository root to `git add -A` with a private index can make Git
      // reject an ignored top-level `.koryphaios/` even when an exclusion
      // pathspec is present. Enumerating exact non-ignored untracked paths is
      // both quieter and a stronger persistence boundary.
      const updateTracked = await this.shadowGit.exec(['add', '-u', '--', '.'], {
        env: indexEnv,
      });
      if (!updateTracked.success) throw new Error(updateTracked.stderr || updateTracked.stdout);
      const untracked = await this.shadowGit.exec(
        ['ls-files', '--others', '--exclude-standard', '-z'],
        { env: indexEnv },
      );
      if (!untracked.success) throw new Error(untracked.stderr || untracked.stdout);
      const untrackedPaths = untracked.stdout
        .split('\0')
        .filter((path) => path && path !== '.koryphaios' && !path.startsWith('.koryphaios/'));
      if (untrackedPaths.length > 0) {
        const addUntracked = await this.shadowGit.exec(
          ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { env: indexEnv, stdin: `${untrackedPaths.join('\0')}\0` },
        );
        if (!addUntracked.success) throw new Error(addUntracked.stderr || addUntracked.stdout);
      }
      // Pathspec exclusion prevents new ingestion, while this explicit cached
      // removal also strips tracked internals inherited from the base tree.
      const removeInternals = await this.shadowGit.exec(
        ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', '.koryphaios'],
        { env: indexEnv },
      );
      if (!removeInternals.success)
        throw new Error(removeInternals.stderr || removeInternals.stdout);
      const treeResult = await this.shadowGit.exec(['write-tree'], { env: indexEnv });
      if (!treeResult.success || !this.sanitizeObjectId(treeResult.stdout.trim())) {
        throw new Error(treeResult.stderr || treeResult.stdout);
      }
      tree = treeResult.stdout.trim();
    } catch (error) {
      koryLog.error(
        { error: checkpointLogPreview(error) },
        'Failed to create private checkpoint tree',
      );
      return null;
    } finally {
      rmSync(privateIndexDirectory, { recursive: true, force: true });
    }

    const identity = await this.resolveCommitIdentity();
    const ghostMessage = `${this.GHOST_PREFIX} ${safeMessage}`;
    const commitResult = await this.shadowGit.exec(
      [
        'commit-tree',
        tree,
        '-m',
        ghostMessage,
        '-m',
        `Kory-Checkpoint-ID: ${checkpointMetadata.id}`,
      ],
      { env: identity },
    );
    if (!commitResult.success || !this.sanitizeObjectId(commitResult.stdout.trim())) {
      koryLog.error(
        { output: checkpointLogPreview(commitResult.output) },
        'Failed to create standalone checkpoint commit',
      );
      return null;
    }
    const ghostHash = commitResult.stdout.trim().toLowerCase();

    const durable = await this.shadowGit.exec([
      'for-each-ref',
      '--format=%(objectname)',
      this.CHECKPOINT_REF_ROOT,
      this.RECOVERY_BACKUP_REF_ROOT,
    ]);
    if (!durable.success) {
      koryLog.error(
        { output: checkpointLogPreview(durable.output) },
        'Failed to enumerate durable checkpoint roots',
      );
      return null;
    }
    try {
      await ShadowRepo.internalizeSnapshot(
        this.workingDirectory,
        ghostHash,
        durable.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch (error) {
      koryLog.error(
        { error: checkpointLogPreview(error) },
        'Failed to internalize checkpoint snapshot',
      );
      return null;
    }

    if (publicationMode === 'recovery-backup') {
      const metadataOid = await this.hashJsonBlob(checkpointMetadata);
      const zero = await this.zeroObjectId();
      if (!metadataOid || !zero) return null;
      const backupRef = `${this.RECOVERY_BACKUP_REF_ROOT}/${session}/${timestamp}-${checkpointMetadata.id}`;
      const metadataRef = `${this.METADATA_REF_ROOT}/${ghostHash}`;
      const transaction = [
        'start',
        `update ${backupRef} ${ghostHash} ${zero}`,
        `update ${metadataRef} ${metadataOid} ${zero}`,
        'prepare',
        'commit',
        '',
      ].join('\n');
      const published = await this.shadowGit.exec(['update-ref', '--stdin'], {
        stdin: transaction,
      });
      if (!published.success) {
        koryLog.error(
          { output: checkpointLogPreview(published.output) },
          'Recovery backup publication failed',
        );
        return null;
      }
      return ghostHash;
    }

    const manifest: CheckpointManifest = {
      ...state.manifest,
      entries: [
        ...state.manifest.entries,
        this.manifestEntry(ghostHash, checkpointMetadata, safeMessage),
      ],
      nextSequence: sequence + 1,
    };
    const metadataOid = await this.hashJsonBlob(checkpointMetadata);
    const manifestOid = await this.hashJsonBlob(manifest);
    const highWaterOid = await this.hashJsonBlob({ version: 1, nextSequence: sequence + 1 });
    if (!metadataOid || !manifestOid || !highWaterOid) return null;

    const zero = await this.zeroObjectId();
    if (!zero) return null;
    const checkpointLeaf = `${timestamp}-${createHash('sha256').update(checkpointMetadata.id).digest('hex')}`;
    const checkpointRef = `${this.CHECKPOINT_REF_ROOT}/${session}/${checkpointLeaf}`;
    const metadataRef = `${this.METADATA_REF_ROOT}/${ghostHash}`;
    const manifestRef = `${this.MANIFEST_REF_ROOT}/${session}`;
    const highWaterRef = `${this.HIGH_WATER_REF_ROOT}/${session}`;
    const cursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
    const currentCursor = await this.resolveRef(cursorRef);
    const transaction = [
      'start',
      `update ${checkpointRef} ${ghostHash} ${zero}`,
      `update ${metadataRef} ${metadataOid} ${zero}`,
      `update ${manifestRef} ${manifestOid} ${state.manifestOid ?? zero}`,
      `update ${highWaterRef} ${highWaterOid} ${state.highWaterOid ?? zero}`,
      `update ${cursorRef} ${ghostHash} ${currentCursor ?? zero}`,
      'prepare',
      'commit',
      '',
    ].join('\n');
    const published = await this.shadowGit.exec(['update-ref', '--stdin'], { stdin: transaction });
    if (!published.success) {
      koryLog.error(
        { checkpointRef, output: checkpointLogPreview(published.output) },
        'Atomic checkpoint publication failed; no checkpoint refs were advanced',
      );
      return null;
    }

    koryLog.info(
      { ghostHash, checkpointRef, message: checkpointLogPreview(safeMessage, 160), sequence },
      'Checkpoint created',
    );
    return ghostHash;
  }

  private manifestEntry(
    hash: string,
    metadata: GhostCommitMetadata,
    description: string,
  ): CheckpointManifest['entries'][number] {
    return {
      hash,
      sequence: metadata.sequence ?? 0,
      timestamp: metadata.timestamp,
      id: metadata.id,
      model: metadata.model,
      cost: metadata.cost,
      messageId: metadata.messageId,
      checkpointType: metadata.checkpointType,
      description,
      agentId: metadata.agentId,
      summary: metadata.summary,
      toolCallCount: metadata.evidenceCounts?.toolCalls,
      commandCount: metadata.evidenceCounts?.commands,
      fileEditCount: metadata.evidenceCounts?.fileEdits,
      hasRichMetadata: Boolean(
        metadata.toolCalls?.length ||
        metadata.commands?.length ||
        metadata.fileEdits?.length ||
        metadata.transcript,
      ),
    };
  }

  private async resolveCommitIdentity(): Promise<Record<string, string>> {
    const [nameResult, emailResult] = await Promise.all([
      this.git.exec(['config', '--get', 'user.name']),
      this.git.exec(['config', '--get', 'user.email']),
    ]);
    const clean = (value: string, fallback: string): string => {
      const bounded = value
        .trim()
        .replace(/[\0\r\n]/g, ' ')
        .slice(0, 160);
      return bounded || fallback;
    };
    const name = clean(nameResult.success ? nameResult.stdout : '', 'Koryphaios Checkpoint');
    const email = clean(
      emailResult.success ? emailResult.stdout : '',
      'checkpoint@koryphaios.local',
    );
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }

  private async hashJsonBlob(value: unknown): Promise<string | null> {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content, 'utf-8') > 256 * 1024) {
      koryLog.error('Checkpoint reference blob exceeds the 256 KiB persistence limit');
      return null;
    }
    const result = await this.shadowGit.exec(['hash-object', '-w', '--stdin'], { stdin: content });
    const oid = result.stdout.trim();
    if (!result.success || !this.sanitizeObjectId(oid)) {
      koryLog.error(
        { output: checkpointLogPreview(result.output) },
        'Failed to persist checkpoint reference blob',
      );
      return null;
    }
    return oid.toLowerCase();
  }

  private async zeroObjectId(): Promise<string | null> {
    const result = await this.shadowGit.exec(['rev-parse', '--show-object-format']);
    if (!result.success) return null;
    if (result.stdout.trim() === 'sha1') return '0'.repeat(40);
    if (result.stdout.trim() === 'sha256') return '0'.repeat(64);
    return null;
  }

  private async resolveRef(ref: string): Promise<string | null> {
    const result = await this.shadowGit.exec(['rev-parse', '--verify', '--quiet', ref]);
    if (!result.success) return null;
    return this.sanitizeObjectId(result.stdout.trim()) ?? null;
  }

  private sanitizeMessageBoundary(value: string | null): string | null {
    if (value === null) return null;
    return value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value) ? value : null;
  }

  private changedFilesEqual(left: CheckpointFileChange[], right: CheckpointFileChange[]): boolean {
    const canonical = (values: CheckpointFileChange[]) =>
      values
        .map((value) => `${value.operation}\0${value.path}`)
        .sort()
        .join('\n');
    return canonical(left) === canonical(right);
  }

  private recoveryOperationRef(session: string, operationId: string): string {
    return `${this.RECOVERY_OPERATION_REF_ROOT}/${session}/${operationId}`;
  }

  private recoveryHoldRef(
    session: string,
    operationId: string,
    kind: 'previous' | 'target',
  ): string {
    return `${this.RECOVERY_HOLD_REF_ROOT}/${session}/${operationId}/${kind}`;
  }

  private async readRecoveryOperation(
    session: string,
    operationId: string,
  ): Promise<RecoveryOperationState | null> {
    if (!/^[0-9a-f]{32}$/.test(operationId)) return null;
    const ref = this.recoveryOperationRef(session, operationId);
    const oid = await this.resolveRef(ref);
    return oid ? this.readRecoveryOperationRef(ref, oid) : null;
  }

  private async readRecoveryOperationRef(
    ref: string,
    oid: string,
  ): Promise<RecoveryOperationState | null> {
    const blob = await this.shadowGit.exec(['cat-file', 'blob', oid]);
    if (!blob.success) return null;
    try {
      const value = JSON.parse(blob.stdout) as unknown;
      if (!this.isRecoveryOperation(value)) return null;
      const refOperationId = ref.slice(ref.lastIndexOf('/') + 1);
      if (refOperationId !== value.id) return null;
      return { operation: value, oid, ref };
    } catch {
      return null;
    }
  }

  private isRecoveryOperation(value: unknown): value is RecoveryOperation {
    if (!value || typeof value !== 'object') return false;
    const operation = value as Partial<RecoveryOperation>;
    if (
      operation.version !== 1 ||
      typeof operation.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(operation.id) ||
      typeof operation.agentId !== 'string' ||
      !operation.agentId ||
      operation.agentId.length > 512 ||
      /[\0-\x1f\x7f]/.test(operation.agentId) ||
      !this.sanitizeObjectId(operation.previousCursor) ||
      !this.sanitizeObjectId(operation.targetHash) ||
      !['prepared', 'backup_ready', 'workspace_applied'].includes(String(operation.phase)) ||
      !Number.isSafeInteger(operation.createdAt) ||
      !Number.isSafeInteger(operation.updatedAt) ||
      !Array.isArray(operation.changedFiles)
    )
      return false;
    if (
      !Object.prototype.hasOwnProperty.call(operation, 'previousMessageId') ||
      !Object.prototype.hasOwnProperty.call(operation, 'targetMessageId') ||
      operation.createdAt! < 0 ||
      operation.updatedAt! < operation.createdAt!
    )
      return false;
    if (
      this.sanitizeMessageBoundary(operation.previousMessageId ?? null) !==
        (operation.previousMessageId ?? null) ||
      this.sanitizeMessageBoundary(operation.targetMessageId ?? null) !==
        (operation.targetMessageId ?? null)
    )
      return false;
    const normalized = this.normalizeChangedFiles(operation.changedFiles) ?? [];
    if (normalized.length !== operation.changedFiles.length || normalized.length > 500)
      return false;
    if (
      operation.recoveryBackupHash !== undefined &&
      !this.sanitizeObjectId(operation.recoveryBackupHash)
    )
      return false;
    if (
      operation.phase === 'prepared'
        ? operation.recoveryBackupHash !== undefined
        : !this.sanitizeObjectId(operation.recoveryBackupHash)
    )
      return false;
    return true;
  }

  private async updateRecoveryOperationLocked(
    state: RecoveryOperationState,
    patch: Pick<RecoveryOperation, 'phase'> &
      Pick<Partial<RecoveryOperation>, 'recoveryBackupHash'>,
  ): Promise<RecoveryOperationState | null> {
    const operation: RecoveryOperation = {
      ...state.operation,
      ...patch,
      updatedAt: Date.now(),
    };
    const oid = await this.hashJsonBlob(operation);
    if (!oid) return null;
    const updated = await this.shadowGit.exec(['update-ref', state.ref, oid, state.oid]);
    if (!updated.success) {
      koryLog.error(
        { operationId: operation.id, output: checkpointLogPreview(updated.output) },
        'Could not advance durable recovery journal phase',
      );
      return null;
    }
    return { operation, oid, ref: state.ref };
  }

  private async deleteRecoveryOperationLocked(
    session: string,
    state: RecoveryOperationState,
  ): Promise<{ success: boolean; message: string }> {
    const previousHold = this.recoveryHoldRef(session, state.operation.id, 'previous');
    const targetHold = this.recoveryHoldRef(session, state.operation.id, 'target');
    const [previousOid, targetOid] = await Promise.all([
      this.resolveRef(previousHold),
      this.resolveRef(targetHold),
    ]);
    if (
      previousOid !== state.operation.previousCursor ||
      targetOid !== state.operation.targetHash
    ) {
      return { success: false, message: 'Recovery object holds are missing or corrupt' };
    }
    const recoveryBackupDeletes: string[] = [];
    if (state.operation.recoveryBackupHash) {
      const backupRefs = await this.shadowGit.exec([
        'for-each-ref',
        '--format=%(refname)|%(objectname)',
        `${this.RECOVERY_BACKUP_REF_ROOT}/${session}`,
      ]);
      if (!backupRefs.success) {
        return {
          success: false,
          message: `Could not inspect recovery backups: ${backupRefs.output}`,
        };
      }
      for (const line of backupRefs.stdout.split('\n').filter(Boolean)) {
        const [ref, oid] = line.split('|');
        if (ref && oid === state.operation.recoveryBackupHash) {
          recoveryBackupDeletes.push(`delete ${ref} ${oid}`);
        }
      }
      const metadataRef = `${this.METADATA_REF_ROOT}/${state.operation.recoveryBackupHash}`;
      const metadataOid = await this.resolveRef(metadataRef);
      if (metadataOid) recoveryBackupDeletes.push(`delete ${metadataRef} ${metadataOid}`);
    }
    const deleted = await this.shadowGit.exec(['update-ref', '--stdin'], {
      stdin: [
        'start',
        `delete ${state.ref} ${state.oid}`,
        `delete ${previousHold} ${previousOid}`,
        `delete ${targetHold} ${targetOid}`,
        ...recoveryBackupDeletes,
        'prepare',
        'commit',
        '',
      ].join('\n'),
    });
    return deleted.success
      ? { success: true, message: 'Recovery journal completed' }
      : { success: false, message: `Could not complete recovery journal: ${deleted.output}` };
  }

  private async readManifestState(session: string, agentId: string): Promise<ManifestState> {
    const manifestRef = `${this.MANIFEST_REF_ROOT}/${session}`;
    const highWaterRef = `${this.HIGH_WATER_REF_ROOT}/${session}`;
    const manifestOid = await this.resolveRef(manifestRef);
    const highWaterOid = await this.resolveRef(highWaterRef);
    let highWater = 0;
    if (highWaterOid) {
      const highWaterResult = await this.shadowGit.exec(['cat-file', 'blob', highWaterOid]);
      if (!highWaterResult.success) {
        throw new CheckpointStoreError(
          `Checkpoint sequence high-water is unreadable for ${session}`,
        );
      }
      try {
        const parsed = JSON.parse(highWaterResult.stdout) as {
          version?: unknown;
          nextSequence?: unknown;
        };
        if (
          parsed.version !== 1 ||
          !Number.isSafeInteger(parsed.nextSequence) ||
          Number(parsed.nextSequence) < 0
        ) {
          throw new Error('invalid high-water schema');
        }
        highWater = Number(parsed.nextSequence);
      } catch (error) {
        throw new CheckpointStoreError(
          `Checkpoint sequence high-water is corrupt for ${session}: ${String(error)}`,
        );
      }
    }

    if (manifestOid) {
      const result = await this.shadowGit.exec(['cat-file', 'blob', manifestOid]);
      if (result.success) {
        try {
          const parsed = JSON.parse(result.stdout) as unknown;
          if (this.isCheckpointManifest(parsed, agentId)) {
            parsed.nextSequence = Math.max(parsed.nextSequence, highWater);
            return { manifest: parsed, manifestOid, highWaterOid, needsRepair: false };
          }
        } catch {
          // Reconcile from authoritative refs below.
        }
      }
    }

    const rebuilt = await this.rebuildManifestInMemory(session, agentId, highWater);
    if (manifestOid && rebuilt.entries.length === 0 && highWaterOid === null) {
      throw new CheckpointStoreError(
        `Checkpoint manifest is corrupt and has no authoritative refs or high-water for ${session}`,
      );
    }
    return { manifest: rebuilt, manifestOid, highWaterOid, needsRepair: true };
  }

  private isCheckpointManifest(value: unknown, agentId: string): value is CheckpointManifest {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<CheckpointManifest>;
    if (
      candidate.version !== 1 ||
      !Number.isSafeInteger(candidate.nextSequence) ||
      Number(candidate.nextSequence) < 0 ||
      !Array.isArray(candidate.entries)
    )
      return false;
    return candidate.entries.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as CheckpointManifest['entries'][number];
      return Boolean(
        this.sanitizeObjectId(item.hash) &&
        Number.isSafeInteger(item.sequence) &&
        item.sequence >= 0 &&
        Number.isFinite(item.timestamp) &&
        typeof item.id === 'string' &&
        typeof item.description === 'string' &&
        item.agentId === agentId,
      );
    });
  }

  private async rebuildManifestInMemory(
    session: string,
    agentId: string,
    highWater: number,
  ): Promise<CheckpointManifest> {
    const refs = await this.shadowGit.exec([
      'for-each-ref',
      '--sort=creatordate',
      '--format=%(objectname)|%(creatordate:unix)|%(subject)',
      `${this.CHECKPOINT_REF_ROOT}/${session}`,
    ]);
    if (!refs.success) {
      throw new CheckpointStoreError(`Failed to reconcile checkpoint manifest: ${refs.output}`);
    }
    const manifest: CheckpointManifest = { version: 1, nextSequence: highWater, entries: [] };
    for (const line of refs.stdout.split('\n').filter(Boolean)) {
      const [hash, timestamp, ...subjectParts] = line.split('|');
      if (!this.sanitizeObjectId(hash)) continue;
      const metadata = await this.getMetadata(hash);
      if (!metadata || metadata.agentId !== agentId) continue;
      const description = this.formatDescription(subjectParts.join('|'), metadata);
      manifest.entries.push(this.manifestEntry(hash, metadata, description));
      manifest.nextSequence = Math.max(manifest.nextSequence, (metadata.sequence ?? 0) + 1);
      if (!metadata.timestamp && timestamp) metadata.timestamp = Number(timestamp) * 1000;
    }
    return manifest;
  }

  /** Migrate a lossy pre-v2 session namespace only after direct metadata proves
   * exact ownership. Mixed legacy namespaces are split safely by agent ID. */
  private async migrateLegacySessionLocked(agentId: string): Promise<void> {
    const legacySession = this.sanitizeRefPart(agentId);
    const session = this.sessionRefKey(agentId);
    const allRefs = await this.shadowGit.exec([
      'for-each-ref',
      '--format=%(refname)|%(objectname)',
      this.CHECKPOINT_REF_ROOT,
    ]);
    if (!allRefs.success) {
      throw new CheckpointStoreError(`Could not inspect legacy checkpoint refs: ${allRefs.output}`);
    }
    const legacyPrefix = `${this.CHECKPOINT_REF_ROOT}/${legacySession}/`;
    const candidates: Array<{
      oldRef: string;
      newRef: string;
      hash: string;
      metadata: GhostCommitMetadata;
    }> = [];
    for (const line of allRefs.stdout.split('\n').filter(Boolean)) {
      const [ref, hash] = line.split('|');
      if (!ref?.startsWith(legacyPrefix) || !this.sanitizeObjectId(hash)) continue;
      const metadata = await this.getMetadata(hash);
      if (metadata?.agentId !== agentId) continue;
      candidates.push({
        oldRef: ref,
        newRef: `${this.CHECKPOINT_REF_ROOT}/${session}/${ref.slice(legacyPrefix.length)}`,
        hash,
        metadata,
      });
    }
    if (candidates.length === 0) return;

    const zero = await this.zeroObjectId();
    if (!zero) throw new CheckpointStoreError('Could not determine object format for migration');
    const state = await this.readManifestState(session, agentId);
    const entries = [...state.manifest.entries];
    const transaction = ['start'];
    for (const candidate of candidates) {
      const existing = await this.resolveRef(candidate.newRef);
      if (existing && existing !== candidate.hash) {
        throw new CheckpointStoreError(`Checkpoint migration conflict at ${candidate.newRef}`);
      }
      if (!existing) transaction.push(`update ${candidate.newRef} ${candidate.hash} ${zero}`);
      transaction.push(`delete ${candidate.oldRef} ${candidate.hash}`);

      const sanitized = this.sanitizeMetadata({
        ...candidate.metadata,
        promptHash:
          candidate.metadata.promptHash ??
          (candidate.metadata.prompt
            ? createHash('sha256').update(candidate.metadata.prompt).digest('hex')
            : undefined),
        prompt: undefined,
        agentId,
        id: candidate.metadata.id || `legacy_${candidate.hash.slice(0, 12)}`,
        timestamp: Number.isFinite(candidate.metadata.timestamp)
          ? candidate.metadata.timestamp
          : Date.now(),
      });
      const metadataRef = `${this.METADATA_REF_ROOT}/${candidate.hash}`;
      if (!(await this.resolveRef(metadataRef))) {
        const metadataOid = await this.hashJsonBlob(sanitized);
        if (!metadataOid) throw new CheckpointStoreError('Could not prepare migrated metadata');
        transaction.push(`update ${metadataRef} ${metadataOid} ${zero}`);
      }
      if (!entries.some((entry) => entry.hash === candidate.hash)) {
        const subject = await this.shadowGit.exec(['show', '-s', '--format=%s', candidate.hash]);
        entries.push(
          this.manifestEntry(
            candidate.hash,
            sanitized,
            this.formatDescription(subject.stdout, sanitized),
          ),
        );
      }
    }

    const nextSequence = Math.max(
      state.manifest.nextSequence,
      ...entries.map((entry) => entry.sequence + 1),
    );
    const manifest: CheckpointManifest = { version: 1, nextSequence, entries };
    const manifestOid = await this.hashJsonBlob(manifest);
    const highWaterOid = await this.hashJsonBlob({ version: 1, nextSequence });
    if (!manifestOid || !highWaterOid)
      throw new CheckpointStoreError('Could not prepare migrated manifest');
    transaction.push(
      `update ${this.MANIFEST_REF_ROOT}/${session} ${manifestOid} ${state.manifestOid ?? zero}`,
      `update ${this.HIGH_WATER_REF_ROOT}/${session} ${highWaterOid} ${state.highWaterOid ?? zero}`,
    );

    const oldCursorRef = `${this.CURSOR_REF_ROOT}/${legacySession}`;
    const oldCursor = await this.resolveRef(oldCursorRef);
    const cursorTarget =
      oldCursor && candidates.some((candidate) => candidate.hash === oldCursor)
        ? oldCursor
        : [...entries].sort((a, b) => b.sequence - a.sequence || b.timestamp - a.timestamp)[0]
            ?.hash;
    const newCursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
    const newCursor = await this.resolveRef(newCursorRef);
    if (cursorTarget && !newCursor)
      transaction.push(`update ${newCursorRef} ${cursorTarget} ${zero}`);
    transaction.push('prepare', 'commit', '');
    const migrated = await this.shadowGit.exec(['update-ref', '--stdin'], {
      stdin: transaction.join('\n'),
    });
    if (!migrated.success) {
      throw new CheckpointStoreError(`Legacy session migration failed: ${migrated.output}`);
    }
    koryLog.info({ agentId, migrated: candidates.length }, 'Migrated legacy checkpoint namespace');
  }

  private async migrateAllLegacySessionsLocked(): Promise<void> {
    const refs = await this.shadowGit.exec([
      'for-each-ref',
      '--format=%(objectname)',
      this.CHECKPOINT_REF_ROOT,
    ]);
    if (!refs.success)
      throw new CheckpointStoreError(`Could not inspect checkpoint ownership: ${refs.output}`);
    const agentIds = new Set<string>();
    for (const hash of refs.stdout.split('\n').filter(Boolean)) {
      const metadata = await this.getMetadata(hash);
      if (metadata?.agentId) agentIds.add(metadata.agentId);
    }
    for (const agentId of agentIds) await this.migrateLegacySessionLocked(agentId);
  }

  async getCursor(agentId: string): Promise<string | null> {
    await this.ensureShadowReady();
    return await ShadowRepo.withExclusiveLock(
      this.workingDirectory,
      async () => {
        await this.migrateLegacySessionLocked(agentId);
        return this.resolveRef(`${this.CURSOR_REF_ROOT}/${this.sessionRefKey(agentId)}`);
      },
      `read checkpoint cursor for ${this.sessionRefKey(agentId)}`,
    );
  }

  async setCursor(agentId: string | undefined, hash: string): Promise<boolean> {
    if (!agentId) return false;
    await this.ensureShadowReady();
    return (
      await this.shadowGit.execCombined([
        'update-ref',
        `${this.CURSOR_REF_ROOT}/${this.sessionRefKey(agentId)}`,
        hash,
      ])
    ).success;
  }

  async isOwnedCheckpoint(hash: string, agentId: string): Promise<boolean> {
    if ((await this.getMetadata(hash))?.agentId !== agentId) return false;
    await this.ensureShadowReady();
    const refs = await this.shadowGit.execCombined([
      'for-each-ref',
      '--format=%(objectname)',
      this.CHECKPOINT_REF_ROOT,
    ]);
    return refs.success && refs.output.split('\n').includes(hash);
  }

  async worktreePathMatches(hash: string, path: string): Promise<boolean> {
    const normalized = this.normalizeChangedFiles([{ path, operation: 'edit' }])?.[0]?.path;
    if (!normalized || !this.isSafeRecoveryPath(normalized)) return false;
    await this.ensureShadowReady();
    const expected = await this.shadowGit.exec(['ls-tree', hash, '--', normalized]);
    const absolute = resolve(this.workingDirectory, normalized);
    if (!expected.success || !expected.stdout.trim()) return !existsSync(absolute);
    if (!existsSync(absolute)) return false;
    const match = expected.stdout.trim().match(/^([0-9]{6})\s+\w+\s+([0-9a-f]+)\t/);
    if (!match) return false;
    const [, expectedMode, expectedOid] = match;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      if (expectedMode !== '120000') return false;
      const actual = await this.shadowGit.exec(['hash-object', '--stdin'], {
        stdin: readlinkSync(absolute),
      });
      return actual.success && actual.stdout.trim() === expectedOid;
    }
    if (!stat.isFile()) return false;
    const actualMode = (stat.mode & 0o111) !== 0 ? '100755' : '100644';
    if (expectedMode !== actualMode) return false;
    const actual = await this.shadowGit.exec(['hash-object', '--no-filters', '--', normalized]);
    return actual.success && actual.stdout.trim() === expectedOid;
  }

  /**
   * Attach metadata to a ghost commit using git notes.
   * @returns true on success, false on failure (surfaced to caller).
   */
  private async attachMetadata(hash: string, metadata: GhostCommitMetadata): Promise<boolean> {
    const notesContent = JSON.stringify(metadata, null, 2);

    const result = await this.shadowGit.execCombined([
      'notes',
      '--ref',
      this.NOTES_REF,
      'add',
      '-f',
      '-m',
      notesContent,
      hash,
    ]);

    if (!result.success) {
      koryLog.warn(
        { hash, output: checkpointLogPreview(result.output) },
        'Failed to attach metadata to checkpoint',
      );
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
    await this.ensureShadowReady();
    const direct = await this.shadowGit.execCombined([
      'cat-file',
      'blob',
      `${this.METADATA_REF_ROOT}/${hash}`,
    ]);
    if (direct.success) {
      try {
        const parsed = JSON.parse(direct.output) as GhostCommitMetadata;
        if (
          parsed &&
          typeof parsed.id === 'string' &&
          Number.isFinite(parsed.timestamp) &&
          this.sanitizeObjectId(hash)
        )
          return parsed;
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to parse direct checkpoint metadata',
        );
      }
    }
    // Try the current notes ref first.
    const result = await this.shadowGit.execCombined([
      'notes',
      '--ref',
      this.NOTES_REF,
      'show',
      hash,
    ]);
    if (result.success) {
      try {
        return JSON.parse(result.output) as GhostCommitMetadata;
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to parse checkpoint metadata from git notes',
        );
      }
    }

    // Fall back to the legacy notes ref for pre-rename checkpoints.
    const legacyResult = await this.shadowGit.execCombined([
      'notes',
      '--ref',
      this.LEGACY_NOTES_REF,
      'show',
      hash,
    ]);
    if (legacyResult.success) {
      try {
        return JSON.parse(legacyResult.output) as GhostCommitMetadata;
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to parse legacy checkpoint metadata from git notes',
        );
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
    await this.ensureShadowReady();
    return await ShadowRepo.withExclusiveLock(this.workingDirectory, async () => {
      const session = filterAgentId ? this.sessionRefKey(filterAgentId) : undefined;
      if (filterAgentId) await this.migrateLegacySessionLocked(filterAgentId);

      // Try the validated manifest first. Corruption is reconciled from
      // authoritative checkpoint refs instead of being treated as empty.
      if (session && filterAgentId) {
        const state = await this.readManifestState(session, filterAgentId);
        const manifest = state.manifest;
        if (state.needsRepair && (manifest.entries.length > 0 || state.manifestOid)) {
          await this.persistManifestRepair(session, state);
        }
        // If the manifest exists (has been built before), use it — even if empty.
        // An empty manifest means all checkpoints were pruned; falling back to
        // the legacy path would re-discover them via reflog and rebuild a stale
        // manifest. We only fall back when the manifest has never been built
        // (entries.length === 0 AND nextSequence === 0 — the initial state).
        if (manifest.entries.length > 0 || manifest.nextSequence > 0) {
          const refs = await this.shadowGit.exec([
            'for-each-ref',
            '--format=%(objectname)',
            `${this.CHECKPOINT_REF_ROOT}/${session}`,
          ]);
          if (!refs.success)
            throw new CheckpointStoreError(`Failed to validate timeline refs: ${refs.output}`);
          const retained = new Set(refs.stdout.split('\n').filter(Boolean));
          return manifest.entries
            .filter((entry) => entry.agentId === filterAgentId)
            .sort(
              (a, b) =>
                b.sequence - a.sequence ||
                b.timestamp - a.timestamp ||
                b.hash.localeCompare(a.hash),
            )
            .slice(0, limit)
            .map((e) => ({
              hash: e.hash,
              description: e.description,
              timestamp: e.timestamp,
              model: e.model,
              cost: e.cost,
              recoverable: retained.has(e.hash),
              messageId: e.messageId,
              checkpointType: e.checkpointType,
              sequence: e.sequence,
              summary: e.summary,
              toolCallCount: e.toolCallCount,
              commandCount: e.commandCount,
              fileEditCount: e.fileEditCount,
              hasRichMetadata: e.hasRichMetadata,
            }));
        }
      }

      // Legacy fallback: build timeline from refs + git notes (and populate manifest)
      return this.getTimelineLegacy(limit, filterAgentId);
    });
  }

  /**
   * Legacy timeline building — scans checkpoint refs and reflog and fetches
   * metadata via legacy git notes (N+1). It does not publish new manifests;
   * migration happens only after ownership can be proven without collisions.
   */
  private async getTimelineLegacy(limit: number, filterAgentId?: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    const seenHashes = new Set<string>();
    // SHADOW context: scan checkpoint refs in the shadow repo.
    const refsResult = await this.shadowGit.execCombined([
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(objectname)|%(refname)|%(creatordate:unix)|%(subject)',
      this.CHECKPOINT_REF_ROOT,
    ]);

    if (refsResult.success) {
      for (const line of refsResult.output.split('\n').filter(Boolean)) {
        const [hash, _ref, timestamp, subject] = line.split('|');
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
          summary: metadata?.summary,
          toolCallCount: metadata?.evidenceCounts?.toolCalls ?? metadata?.toolCalls?.length,
          commandCount: metadata?.evidenceCounts?.commands ?? metadata?.commands?.length,
          fileEditCount: metadata?.evidenceCounts?.fileEdits ?? metadata?.fileEdits?.length,
          hasRichMetadata: Boolean(
            metadata?.toolCalls?.length ||
            metadata?.commands?.length ||
            metadata?.fileEdits?.length ||
            metadata?.transcript,
          ),
        });
      }
    }

    // Backward compatibility: reflog discovery for pre-ref checkpoints.
    // MAIN context: reads the main repo's HEAD reflog (legacy checkpoints
    // created before refs were used may only be discoverable here).
    const reflogResult = await this.git.execCombined([
      'reflog',
      'show',
      'HEAD',
      '--format=%H|%gd|%gs|%ct',
      '-n',
      String(limit * 5),
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
            summary: metadata?.summary,
            toolCallCount: metadata?.evidenceCounts?.toolCalls ?? metadata?.toolCalls?.length,
            commandCount: metadata?.evidenceCounts?.commands ?? metadata?.commands?.length,
            fileEditCount: metadata?.evidenceCounts?.fileEdits ?? metadata?.fileEdits?.length,
            hasRichMetadata: Boolean(
              metadata?.toolCalls?.length ||
              metadata?.commands?.length ||
              metadata?.fileEdits?.length ||
              metadata?.transcript,
            ),
          });
        }
        if (entries.length >= limit) break;
      }
    }

    return entries
      .sort(
        (a, b) =>
          (b.sequence ?? -1) - (a.sequence ?? -1) ||
          b.timestamp - a.timestamp ||
          b.hash.localeCompare(a.hash),
      )
      .slice(0, limit);
  }

  /**
   * Get detailed ghost commit information
   */
  async getGhostCommit(hash: string): Promise<GhostCommit | null> {
    await this.ensureShadowReady();
    // SHADOW context: ghost commit objects live in the shadow repo.
    const catResult = await this.shadowGit.execCombined(['cat-file', '-t', hash]);
    if (!catResult.success || catResult.output !== 'commit') {
      return null;
    }

    const showResult = await this.shadowGit.execCombined([
      'show',
      hash,
      '--format=%H|%P|%s|%ct',
      '--no-patch',
    ]);
    if (!showResult.success) return null;

    const [commitHash, parent, subject, timestamp] = showResult.output.split('|');

    const diffResult = await this.shadowGit.execCombined([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-status',
      '-r',
      hash,
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

  /** Persist the intent to move workspace and conversation state before either
   * participant changes. Object hold refs keep both snapshots alive if the
   * process crashes and pruning runs before the next session open. */
  async prepareRecoveryOperation(options: {
    agentId: string;
    targetHash: string;
    expectedCurrentHash: string;
    previousMessageId: string | null;
    targetMessageId: string | null;
    changedFiles: CheckpointFileChange[];
  }): Promise<{ success: boolean; message: string; operation?: RecoveryOperation }> {
    const agentId = this.validateAgentId(options.agentId);
    const targetHash = this.sanitizeObjectId(options.targetHash);
    const expectedCurrentHash = this.sanitizeObjectId(options.expectedCurrentHash);
    if (!agentId || !targetHash || !expectedCurrentHash) {
      return { success: false, message: 'Recovery operation identifiers are invalid' };
    }
    const changes = this.normalizeChangedFiles(options.changedFiles) ?? [];
    if (changes.length !== options.changedFiles.length || changes.length > 500) {
      return { success: false, message: 'Recovery operation contains unsafe paths' };
    }
    const previousMessageId = this.sanitizeMessageBoundary(options.previousMessageId);
    const targetMessageId = this.sanitizeMessageBoundary(options.targetMessageId);
    if (
      previousMessageId !== options.previousMessageId ||
      targetMessageId !== options.targetMessageId
    ) {
      return { success: false, message: 'Recovery conversation boundary is invalid' };
    }

    const session = this.sessionRefKey(agentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          await this.migrateLegacySessionLocked(agentId);
          const cursor = await this.resolveRef(`${this.CURSOR_REF_ROOT}/${session}`);
          if (cursor !== expectedCurrentHash) {
            return {
              success: false,
              message: 'The session changed after preview. Review it again.',
            };
          }
          if (
            !(await this.isOwnedCheckpoint(targetHash, agentId)) ||
            !(await this.isOwnedCheckpoint(expectedCurrentHash, agentId))
          ) {
            return {
              success: false,
              message: 'Recovery checkpoints are unavailable or not session-owned',
            };
          }
          const pending = await this.shadowGit.exec([
            'for-each-ref',
            '--format=%(refname)',
            `${this.RECOVERY_OPERATION_REF_ROOT}/${session}`,
          ]);
          if (!pending.success) {
            return {
              success: false,
              message: `Could not inspect recovery journal: ${pending.output}`,
            };
          }
          if (pending.stdout.trim()) {
            return {
              success: false,
              message: 'A previous interrupted recovery must be reconciled before another rewind',
            };
          }
          for (const change of changes) {
            if (
              !this.isSafeRecoveryPath(change.path) ||
              !(await this.worktreePathMatches(expectedCurrentHash, change.path))
            ) {
              return {
                success: false,
                message: `Workspace changed after preview: ${change.path}. Preserve or checkpoint it before rewinding.`,
              };
            }
          }

          const now = Date.now();
          const operation: RecoveryOperation = {
            version: 1,
            id: randomUUID().replaceAll('-', ''),
            agentId,
            previousCursor: expectedCurrentHash,
            targetHash,
            previousMessageId,
            targetMessageId,
            changedFiles: changes,
            phase: 'prepared',
            createdAt: now,
            updatedAt: now,
          };
          const operationOid = await this.hashJsonBlob(operation);
          const zero = await this.zeroObjectId();
          if (!operationOid || !zero) {
            return { success: false, message: 'Could not persist the recovery journal' };
          }
          const operationRef = this.recoveryOperationRef(session, operation.id);
          const previousHold = this.recoveryHoldRef(session, operation.id, 'previous');
          const targetHold = this.recoveryHoldRef(session, operation.id, 'target');
          const published = await this.shadowGit.exec(['update-ref', '--stdin'], {
            stdin: [
              'start',
              `update ${operationRef} ${operationOid} ${zero}`,
              `update ${previousHold} ${expectedCurrentHash} ${zero}`,
              `update ${targetHold} ${targetHash} ${zero}`,
              'prepare',
              'commit',
              '',
            ].join('\n'),
          });
          return published.success
            ? { success: true, message: 'Recovery journal prepared', operation }
            : {
                success: false,
                message: `Could not publish the recovery journal: ${published.output}`,
              };
        },
        `prepare recovery operation for ${session}`,
      );
    } finally {
      release();
    }
  }

  /** Return validated pending recovery journals for one exact session. */
  async getPendingRecoveryOperations(agentId: string): Promise<RecoveryOperation[]> {
    const validatedAgentId = this.validateAgentId(agentId);
    if (!validatedAgentId) return [];
    const session = this.sessionRefKey(validatedAgentId);
    await this.ensureShadowReady();
    return await ShadowRepo.withExclusiveLock(
      this.workingDirectory,
      async () => {
        const refs = await this.shadowGit.exec([
          'for-each-ref',
          '--format=%(refname)|%(objectname)',
          `${this.RECOVERY_OPERATION_REF_ROOT}/${session}`,
        ]);
        if (!refs.success) {
          throw new CheckpointStoreError(`Could not read recovery journal: ${refs.output}`);
        }
        const operations: RecoveryOperation[] = [];
        for (const line of refs.stdout.split('\n').filter(Boolean)) {
          const [ref, oid] = line.split('|');
          if (!ref || !this.sanitizeObjectId(oid)) continue;
          const state = await this.readRecoveryOperationRef(ref, oid);
          if (!state || state.operation.agentId !== validatedAgentId) {
            throw new CheckpointStoreError(`Recovery journal ownership is invalid at ${ref}`);
          }
          operations.push(state.operation);
        }
        return operations.sort((a, b) => a.createdAt - b.createdAt);
      },
      `read recovery operations for ${session}`,
    );
  }

  /** Mark a coordinated recovery complete and atomically release its object
   * holds. This is safe to retry after a crash. */
  async completeRecoveryOperation(
    agentId: string,
    operationId: string,
  ): Promise<{ success: boolean; message: string }> {
    const validatedAgentId = this.validateAgentId(agentId);
    if (!validatedAgentId) return { success: false, message: 'A valid session is required' };
    const session = this.sessionRefKey(validatedAgentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          const state = await this.readRecoveryOperation(session, operationId);
          if (!state) return { success: true, message: 'Recovery journal already complete' };
          if (state.operation.agentId !== validatedAgentId) {
            return { success: false, message: 'Recovery journal does not belong to this session' };
          }
          return await this.deleteRecoveryOperationLocked(session, state);
        },
        `complete recovery operation for ${session}`,
      );
    } finally {
      release();
    }
  }

  /**
   * Recover to a specific ghost commit state
   *
   * Restores the checkpoint into the index/worktree without moving HEAD or the branch.
   */
  async recover(
    ghostHash: string,
    options: {
      agentId: string;
      changedFiles: CheckpointFileChange[];
      expectedCurrentHash?: string | null;
      operationId?: string;
    },
  ): Promise<CheckpointRecoveryResult> {
    const agentId = this.validateAgentId(options.agentId);
    if (!agentId) return { success: false, message: 'A valid session is required' };
    const session = this.sessionRefKey(agentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          const ghost = await this.getGhostCommit(ghostHash);
          if (!ghost || !(await this.isOwnedCheckpoint(ghostHash, agentId))) {
            return { success: false, message: 'Checkpoint does not belong to this session' };
          }
          const cursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
          const previousCursor = await this.resolveRef(cursorRef);
          if (!previousCursor) {
            return { success: false, message: 'Cannot determine the current session checkpoint' };
          }
          if (options.expectedCurrentHash && options.expectedCurrentHash !== previousCursor) {
            return {
              success: false,
              message: 'The session changed after preview. Review it again.',
            };
          }

          const changes = this.normalizeChangedFiles(options.changedFiles) ?? [];
          if (changes.length !== options.changedFiles.length) {
            return { success: false, message: 'Recovery includes an unsafe or reserved path' };
          }
          const paths = changes.map((change) => change.path);
          if (paths.length > 500 || paths.some((path) => !this.isSafeRecoveryPath(path))) {
            return { success: false, message: 'Recovery path validation failed' };
          }
          let recoveryOperation: RecoveryOperationState | null = null;
          if (options.operationId) {
            recoveryOperation = await this.readRecoveryOperation(session, options.operationId);
            if (
              !recoveryOperation ||
              recoveryOperation.operation.agentId !== agentId ||
              recoveryOperation.operation.previousCursor !== previousCursor ||
              recoveryOperation.operation.targetHash !== ghostHash ||
              recoveryOperation.operation.phase !== 'prepared' ||
              !this.changedFilesEqual(recoveryOperation.operation.changedFiles, changes)
            ) {
              return { success: false, message: 'Recovery journal does not match this rewind' };
            }
          }
          for (const path of paths) {
            if (!(await this.worktreePathMatches(previousCursor, path))) {
              return {
                success: false,
                message: `Workspace changed after preview: ${path}. Preserve or checkpoint it before rewinding.`,
              };
            }
          }

          if (paths.length === 0) {
            const moved = await this.shadowGit.exec([
              'update-ref',
              cursorRef,
              ghostHash,
              previousCursor,
            ]);
            if (moved.success && recoveryOperation) {
              recoveryOperation =
                (await this.updateRecoveryOperationLocked(recoveryOperation, {
                  phase: 'workspace_applied',
                })) ?? recoveryOperation;
            }
            return moved.success
              ? {
                  success: true,
                  message: `Recovered conversation checkpoint: ${ghost.message.slice(0, 50)}`,
                  previousHash: previousCursor,
                  receipt: {
                    agentId,
                    targetHash: ghostHash,
                    previousCursor,
                    changedFiles: [],
                    operationId: recoveryOperation?.operation.id,
                  },
                }
              : { success: false, message: `Session cursor changed: ${moved.output}` };
          }

          const recoveryBackup = await this.createGhostCommitLocked(
            'Auto-save before recovery',
            {
              agentId,
              prompt: 'Automatic checkpoint before time travel recovery',
              checkpointType: 'recovery_backup',
              changedFiles: changes,
            },
            agentId,
            session,
            'recovery-backup',
          );
          if (!recoveryBackup) {
            return {
              success: false,
              message: 'Could not create the required recovery safety snapshot',
            };
          }
          if (recoveryOperation) {
            const advanced = await this.updateRecoveryOperationLocked(recoveryOperation, {
              phase: 'backup_ready',
              recoveryBackupHash: recoveryBackup,
            });
            if (!advanced) {
              return {
                success: false,
                message:
                  'Recovery safety snapshot was created, but its durable journal could not advance; nothing was overwritten',
                previousHash: previousCursor,
                recoveryBackupHash: recoveryBackup,
              };
            }
            recoveryOperation = advanced;
          }
          for (const path of paths) {
            if (!(await this.worktreePathMatches(recoveryBackup, path))) {
              return {
                success: false,
                message: `Workspace changed while preparing recovery: ${path}. Nothing was overwritten.`,
                previousHash: previousCursor,
                recoveryBackupHash: recoveryBackup,
              };
            }
          }

          const applied = await this.restoreWorktreeSnapshot(ghostHash, previousCursor, paths);
          const verified = applied.success && (await this.pathsMatchSnapshot(ghostHash, paths));
          if (!applied.success || !verified) {
            const rolledBack = await this.restoreWorktreeSnapshot(
              recoveryBackup,
              previousCursor,
              paths,
            );
            const rollbackVerified =
              rolledBack.success && (await this.pathsMatchSnapshot(recoveryBackup, paths));
            return {
              success: false,
              message: rollbackVerified
                ? `Recovery failed and the workspace was restored: ${applied.message}`
                : `Recovery failed and automatic rollback could not be verified. Safety snapshot: ${recoveryBackup}`,
              previousHash: previousCursor,
              recoveryBackupHash: recoveryBackup,
            };
          }

          const moved = await this.shadowGit.exec([
            'update-ref',
            cursorRef,
            ghostHash,
            previousCursor,
          ]);
          if (!moved.success) {
            const rolledBack = await this.restoreWorktreeSnapshot(recoveryBackup, ghostHash, paths);
            const rollbackVerified =
              rolledBack.success && (await this.pathsMatchSnapshot(recoveryBackup, paths));
            return {
              success: false,
              message: rollbackVerified
                ? 'The session cursor changed; workspace changes were rolled back.'
                : `The session cursor changed and rollback needs manual recovery from ${recoveryBackup}`,
              previousHash: previousCursor,
              recoveryBackupHash: recoveryBackup,
            };
          }

          if (recoveryOperation) {
            recoveryOperation =
              (await this.updateRecoveryOperationLocked(recoveryOperation, {
                phase: 'workspace_applied',
                recoveryBackupHash: recoveryBackup,
              })) ?? recoveryOperation;
          }

          koryLog.info({ ghostHash, previousHash: recoveryBackup }, 'Recovered session checkpoint');
          return {
            success: true,
            message: `Recovered to state: ${ghost.message.slice(0, 50)}`,
            previousHash: previousCursor,
            recoveryBackupHash: recoveryBackup,
            receipt: {
              agentId,
              targetHash: ghostHash,
              previousCursor,
              recoveryBackupHash: recoveryBackup,
              changedFiles: changes,
              operationId: recoveryOperation?.operation.id,
            },
          };
        },
        `recover session ${session}`,
      );
    } finally {
      release();
    }
  }

  /** Compensate a completed recovery without touching the user's real index.
   * The cursor and worktree are compare-and-set guarded so a later user edit
   * is preserved rather than overwritten. */
  async rollbackRecovery(
    receipt: CheckpointRecoveryReceipt,
  ): Promise<{ success: boolean; message: string }> {
    const agentId = this.validateAgentId(receipt.agentId);
    if (!agentId) return { success: false, message: 'A valid session is required' };
    if (
      !this.sanitizeObjectId(receipt.targetHash) ||
      !this.sanitizeObjectId(receipt.previousCursor) ||
      (receipt.recoveryBackupHash && !this.sanitizeObjectId(receipt.recoveryBackupHash))
    ) {
      return { success: false, message: 'Recovery receipt is invalid' };
    }
    const changes = this.normalizeChangedFiles(receipt.changedFiles) ?? [];
    if (changes.length !== receipt.changedFiles.length || changes.length > 500) {
      return { success: false, message: 'Recovery receipt contains unsafe paths' };
    }
    const session = this.sessionRefKey(agentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          const cursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
          const currentCursor = await this.resolveRef(cursorRef);
          if (currentCursor !== receipt.targetHash) {
            return {
              success: false,
              message: 'Session changed after recovery; rollback was not applied',
            };
          }
          if (!(await this.isOwnedCheckpoint(receipt.previousCursor, agentId))) {
            return {
              success: false,
              message: 'Previous session checkpoint is no longer available',
            };
          }

          let restoreSource = receipt.previousCursor;
          if (receipt.recoveryBackupHash) {
            const backupRefs = await this.shadowGit.exec([
              'for-each-ref',
              '--format=%(objectname)',
              `${this.RECOVERY_BACKUP_REF_ROOT}/${session}`,
            ]);
            const ownsBackup =
              backupRefs.success &&
              backupRefs.stdout.split('\n').includes(receipt.recoveryBackupHash) &&
              (await this.getMetadata(receipt.recoveryBackupHash))?.agentId === agentId;
            if (!ownsBackup) {
              return { success: false, message: 'Recovery safety snapshot is no longer available' };
            }
            restoreSource = receipt.recoveryBackupHash;
          }

          const paths = changes.map((change) => change.path);
          if (paths.some((path) => !this.isSafeRecoveryPath(path))) {
            return { success: false, message: 'Recovery receipt contains a reserved path' };
          }
          if (!(await this.pathsMatchSnapshot(receipt.targetHash, paths))) {
            return {
              success: false,
              message: 'Workspace changed after recovery; rollback preserved the newer edit',
            };
          }
          if (paths.length > 0) {
            const restored = await this.restoreWorktreeSnapshot(
              restoreSource,
              receipt.targetHash,
              paths,
            );
            if (!restored.success || !(await this.pathsMatchSnapshot(restoreSource, paths))) {
              return {
                success: false,
                message: `Could not restore the recovery safety snapshot: ${restored.message}`,
              };
            }
          }

          const moved = await this.shadowGit.exec([
            'update-ref',
            cursorRef,
            receipt.previousCursor,
            receipt.targetHash,
          ]);
          if (moved.success) {
            return { success: true, message: 'Recovery was rolled back safely' };
          }

          // Cursor CAS failed after the worktree compensation. Put the worktree
          // back at the still-authoritative target before reporting failure.
          const restoredTarget =
            paths.length === 0
              ? { success: true, message: 'No workspace paths changed' }
              : await this.restoreWorktreeSnapshot(receipt.targetHash, restoreSource, paths);
          const targetVerified =
            restoredTarget.success && (await this.pathsMatchSnapshot(receipt.targetHash, paths));
          return {
            success: false,
            message: targetVerified
              ? 'Session cursor changed; the recovered workspace was retained.'
              : `Session cursor changed and workspace compensation needs manual recovery from ${restoreSource}`,
          };
        },
        `rollback recovery for session ${session}`,
      );
    } finally {
      release();
    }
  }

  /** Restore the workspace side of an interrupted coordinated recovery to its
   * journaled pre-rewind snapshot. Every owned path must still match either
   * the old or target snapshot; an arbitrary post-crash edit is preserved and
   * turns reconciliation into an explicit blocker. The journal is retained
   * until the caller also reconciles the conversation boundary. */
  async repairInterruptedRecovery(
    agentId: string,
    operationId: string,
  ): Promise<{ success: boolean; message: string; operation?: RecoveryOperation }> {
    const validatedAgentId = this.validateAgentId(agentId);
    if (!validatedAgentId) return { success: false, message: 'A valid session is required' };
    const session = this.sessionRefKey(validatedAgentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          const state = await this.readRecoveryOperation(session, operationId);
          if (!state || state.operation.agentId !== validatedAgentId) {
            return {
              success: false,
              message: 'Recovery journal is missing or belongs to another session',
            };
          }
          const operation = state.operation;
          const cursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
          const cursor = await this.resolveRef(cursorRef);
          if (cursor !== operation.previousCursor && cursor !== operation.targetHash) {
            return {
              success: false,
              message:
                'Session cursor moved beyond the interrupted recovery; no files were changed',
              operation,
            };
          }
          const changes = this.normalizeChangedFiles(operation.changedFiles) ?? [];
          if (changes.length !== operation.changedFiles.length || changes.length > 500) {
            return { success: false, message: 'Recovery journal contains unsafe paths', operation };
          }
          const paths = changes.map((change) => change.path);
          let allPrevious = true;
          for (const path of paths) {
            if (!this.isSafeRecoveryPath(path)) {
              return { success: false, message: `Recovery path is unsafe: ${path}`, operation };
            }
            const matchesPrevious = await this.worktreePathMatches(operation.previousCursor, path);
            if (matchesPrevious) continue;
            allPrevious = false;
            if (!(await this.worktreePathMatches(operation.targetHash, path))) {
              return {
                success: false,
                message: `Workspace has a newer edit at ${path}; interrupted recovery was not overwritten`,
                operation,
              };
            }
          }

          if (!allPrevious && paths.length > 0) {
            const restored = await this.restoreWorktreeSnapshot(
              operation.previousCursor,
              cursor,
              paths,
            );
            if (
              !restored.success ||
              !(await this.pathsMatchSnapshot(operation.previousCursor, paths))
            ) {
              return {
                success: false,
                message: `Could not restore the pre-rewind workspace: ${restored.message}`,
                operation,
              };
            }
          }
          if (cursor === operation.targetHash) {
            const moved = await this.shadowGit.exec([
              'update-ref',
              cursorRef,
              operation.previousCursor,
              operation.targetHash,
            ]);
            if (!moved.success) {
              return {
                success: false,
                message: `Could not restore the pre-rewind cursor: ${moved.output}`,
                operation,
              };
            }
          }
          return {
            success: true,
            message: 'Interrupted workspace recovery was restored to its prior checkpoint',
            operation,
          };
        },
        `repair interrupted recovery for ${session}`,
      );
    } finally {
      release();
    }
  }

  private async restoreWorktreeSnapshot(
    sourceHash: string,
    baselineHash: string,
    paths: string[],
  ): Promise<{ success: boolean; message: string }> {
    const directory = mkdtempSync(join(this.tempDir, 'recovery-'));
    const privateIndex = join(directory, 'index');
    const env = {
      ...ShadowRepo.mainReadEnv(this.workingDirectory),
      GIT_INDEX_FILE: privateIndex,
    };
    try {
      const seeded = await this.git.exec(['read-tree', baselineHash], { env });
      if (!seeded.success) return { success: false, message: seeded.output };
      const restored = await this.git.exec(
        [
          'restore',
          `--source=${sourceHash}`,
          '--worktree',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        { env, stdin: `${paths.join('\0')}\0` },
      );
      return restored.success
        ? { success: true, message: 'Workspace restored' }
        : { success: false, message: restored.output };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async pathsMatchSnapshot(hash: string, paths: string[]): Promise<boolean> {
    for (const path of paths) {
      if (!this.isSafeRecoveryPath(path) || !(await this.worktreePathMatches(hash, path)))
        return false;
    }
    return true;
  }

  /**
   * Compare current state with a ghost commit
   */
  async compareWithGhost(ghostHash: string): Promise<string> {
    await this.ensureShadowReady();
    // MAIN context: diff compares the ghost commit (visible via alternates)
    // with the real HEAD. Running in main context gives us the real HEAD.
    const result = await this.git.execCombined(['diff', ghostHash, 'HEAD'], {
      env: ShadowRepo.mainReadEnv(this.workingDirectory),
    });
    return result.success ? result.output : '';
  }

  async compareCheckpoints(fromHash: string, toHash: string, paths: string[]): Promise<string> {
    await this.ensureShadowReady();
    const normalized =
      this.normalizeChangedFiles(paths.map((path) => ({ path, operation: 'edit' as const })))?.map(
        (change) => change.path,
      ) ?? [];
    if (normalized.length !== paths.length) return '';
    const result = await this.shadowGit.execCombined([
      'diff',
      '--stat',
      fromHash,
      toHash,
      '--',
      ...normalized,
    ]);
    return result.success ? result.output : '';
  }

  async checkpointsEqual(fromHash: string, toHash: string): Promise<boolean> {
    await this.ensureShadowReady();
    return (await this.shadowGit.exec(['diff', '--quiet', fromHash, toHash])).success;
  }

  /** Materialize a private root snapshot into the main object database before
   * publishing a normal branch ref. The branch remains valid after checkpoint
   * pruning and shadow GC. */
  async createBranchFromCheckpoint(
    ghostHash: string,
    branchName: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureShadowReady();
    const nameCheck = await this.git.exec(['check-ref-format', '--branch', branchName]);
    if (!nameCheck.success || nameCheck.stdout.trim() !== branchName) {
      return { success: false, message: 'Invalid branch name' };
    }
    return await ShadowRepo.withExclusiveLock(
      this.workingDirectory,
      async () => {
        if (!(await this.getGhostCommit(ghostHash))) {
          return { success: false, message: 'Checkpoint is no longer available' };
        }
        try {
          await ShadowRepo.materializeSnapshotInMain(this.workingDirectory, ghostHash);
        } catch (error) {
          return { success: false, message: `Could not materialize checkpoint: ${String(error)}` };
        }
        const format = await this.git.exec(['rev-parse', '--show-object-format']);
        const zero = format.stdout.trim() === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
        const branchRef = `refs/heads/${branchName}`;
        const created = await this.git.exec(['update-ref', branchRef, ghostHash, zero]);
        return created.success
          ? { success: true, message: `Created recovery branch '${branchName}' from checkpoint` }
          : { success: false, message: `Failed to create branch: ${created.output}` };
      },
      `materialize recovery branch ${branchName}`,
    );
  }

  /**
   * Clean up old checkpoints — removes refs older than the specified days.
   * Also cleans up the corresponding manifest entries.
   *
   * @param olderThanDays Remove checkpoints older than this many days
   * @returns Number of entries removed
   */
  async prune(olderThanDays = 30): Promise<{ removed: number; message: string }> {
    await this.ensureShadowReady();
    return await ShadowRepo.withExclusiveLock(this.workingDirectory, async () => {
      await this.migrateAllLegacySessionsLocked();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const refs = await this.shadowGit.exec([
        'for-each-ref',
        '--format=%(refname)|%(objectname)|%(creatordate:unix)',
        this.CHECKPOINT_REF_ROOT,
      ]);
      if (!refs.success) {
        throw new CheckpointStoreError(`Failed to list checkpoints for pruning: ${refs.output}`);
      }
      const recoveryHolds = await this.shadowGit.exec([
        'for-each-ref',
        '--format=%(objectname)',
        this.RECOVERY_HOLD_REF_ROOT,
      ]);
      if (!recoveryHolds.success) {
        throw new CheckpointStoreError(
          `Failed to inspect active recovery holds: ${recoveryHolds.output}`,
        );
      }
      const heldHashes = new Set(
        recoveryHolds.stdout
          .split('\n')
          .map((hash) => hash.trim())
          .filter((hash) => Boolean(this.sanitizeObjectId(hash))),
      );

      const candidates = refs.stdout
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          const [ref, hash, timestamp] = line.split('|');
          if (
            !ref ||
            !this.sanitizeObjectId(hash) ||
            heldHashes.has(hash) ||
            Number(timestamp) * 1000 >= cutoffDate.getTime()
          ) {
            return [];
          }
          const prefix = `${this.CHECKPOINT_REF_ROOT}/`;
          const remainder = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
          const slash = remainder.indexOf('/');
          if (slash <= 0) return [];
          return [{ ref, hash, session: remainder.slice(0, slash) }];
        });
      if (candidates.length === 0) {
        return { removed: 0, message: `Pruned 0 checkpoints older than ${olderThanDays} days` };
      }

      const zero = await this.zeroObjectId();
      if (!zero) throw new CheckpointStoreError('Could not determine repository object format');
      const transaction = ['start'];
      const bySession = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        const entries = bySession.get(candidate.session) ?? [];
        entries.push(candidate);
        bySession.set(candidate.session, entries);
      }

      for (const [session, sessionCandidates] of bySession) {
        const firstMetadata = await this.getMetadata(sessionCandidates[0].hash);
        if (!firstMetadata?.agentId || this.sessionRefKey(firstMetadata.agentId) !== session) {
          throw new CheckpointStoreError(
            `Cannot safely prune checkpoint namespace ${session}: ownership metadata is missing or mismatched`,
          );
        }
        const state = await this.readManifestState(session, firstMetadata.agentId);
        const removedHashes = new Set(sessionCandidates.map((candidate) => candidate.hash));
        const nextManifest: CheckpointManifest = {
          ...state.manifest,
          entries: state.manifest.entries.filter((entry) => !removedHashes.has(entry.hash)),
        };
        const manifestOid = await this.hashJsonBlob(nextManifest);
        const highWaterOid = await this.hashJsonBlob({
          version: 1,
          nextSequence: nextManifest.nextSequence,
        });
        if (!manifestOid || !highWaterOid) {
          throw new CheckpointStoreError(`Could not prepare prune state for ${session}`);
        }

        for (const candidate of sessionCandidates) {
          transaction.push(`delete ${candidate.ref} ${candidate.hash}`);
          const metadataRef = `${this.METADATA_REF_ROOT}/${candidate.hash}`;
          const metadataOid = await this.resolveRef(metadataRef);
          if (metadataOid) transaction.push(`delete ${metadataRef} ${metadataOid}`);
        }
        transaction.push(
          `update ${this.MANIFEST_REF_ROOT}/${session} ${manifestOid} ${state.manifestOid ?? zero}`,
          `update ${this.HIGH_WATER_REF_ROOT}/${session} ${highWaterOid} ${state.highWaterOid ?? zero}`,
        );

        const cursorRef = `${this.CURSOR_REF_ROOT}/${session}`;
        const cursor = await this.resolveRef(cursorRef);
        if (cursor && removedHashes.has(cursor)) {
          const replacement = [...nextManifest.entries].sort((a, b) => b.sequence - a.sequence)[0]
            ?.hash;
          transaction.push(
            replacement
              ? `update ${cursorRef} ${replacement} ${cursor}`
              : `delete ${cursorRef} ${cursor}`,
          );
        }
      }
      transaction.push('prepare', 'commit', '');
      const deleted = await this.shadowGit.exec(['update-ref', '--stdin'], {
        stdin: transaction.join('\n'),
      });
      if (!deleted.success) {
        throw new CheckpointStoreError(`Atomic checkpoint prune failed: ${deleted.output}`);
      }

      await ShadowRepo.gc(this.workingDirectory, { exclusiveLockHeld: true });
      koryLog.info({ olderThanDays, removed: candidates.length }, 'Pruned old checkpoints');
      return {
        removed: candidates.length,
        message: `Pruned ${candidates.length} checkpoints older than ${olderThanDays} days`,
      };
    });
  }

  /**
   * Erase every private checkpoint/ref namespace owned by one session. This is
   * intentionally separate from normal retention pruning: deletion removes
   * cursors, manifests, recovery journals/holds/backups, direct metadata, and
   * legacy notes, then prunes unreachable objects immediately.
   */
  async eraseSession(agentId: string): Promise<{ removedRefs: number }> {
    const validatedAgentId = this.validateAgentId(agentId);
    if (!validatedAgentId) throw new CheckpointStoreError('Session ID is required for erasure');
    const session = this.sessionRefKey(validatedAgentId);
    const release = await this.acquireSessionLock(session);
    try {
      await this.ensureShadowReady();
      return await ShadowRepo.withExclusiveLock(
        this.workingDirectory,
        async () => {
          await this.migrateLegacySessionLocked(validatedAgentId);
          const namespacedRoots = [
            `${this.CHECKPOINT_REF_ROOT}/${session}`,
            `${this.RECOVERY_BACKUP_REF_ROOT}/${session}`,
            `${this.RECOVERY_OPERATION_REF_ROOT}/${session}`,
            `${this.RECOVERY_HOLD_REF_ROOT}/${session}`,
          ];
          const listed = await this.shadowGit.exec([
            'for-each-ref',
            '--format=%(refname)|%(objectname)',
            ...namespacedRoots,
          ]);
          if (!listed.success) {
            throw new CheckpointStoreError('Could not enumerate session checkpoint refs');
          }
          const refs = listed.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [ref, oid] = line.split('|');
              return { ref, oid: this.sanitizeObjectId(oid) };
            })
            .filter((entry): entry is { ref: string; oid: string } => Boolean(entry.ref && entry.oid));

          const checkpointHashes = new Set<string>();
          for (const entry of refs) {
            if (
              entry.ref.startsWith(`${this.CHECKPOINT_REF_ROOT}/${session}/`) ||
              entry.ref.startsWith(`${this.RECOVERY_BACKUP_REF_ROOT}/${session}/`)
            ) {
              const metadata = await this.getMetadata(entry.oid);
              if (!metadata || metadata.agentId !== validatedAgentId) {
                throw new CheckpointStoreError(
                  `Checkpoint erasure refused mismatched ownership at ${entry.ref}`,
                );
              }
              checkpointHashes.add(entry.oid);
            }
            if (entry.ref.startsWith(`${this.RECOVERY_OPERATION_REF_ROOT}/${session}/`)) {
              const state = await this.readRecoveryOperationRef(entry.ref, entry.oid);
              if (!state || state.operation.agentId !== validatedAgentId) {
                throw new CheckpointStoreError(
                  `Checkpoint erasure refused damaged recovery ownership at ${entry.ref}`,
                );
              }
            }
          }

          for (const ref of [
            `${this.CURSOR_REF_ROOT}/${session}`,
            `${this.MANIFEST_REF_ROOT}/${session}`,
            `${this.HIGH_WATER_REF_ROOT}/${session}`,
          ]) {
            const oid = await this.resolveRef(ref);
            if (oid) refs.push({ ref, oid });
          }

          const allDurable = await this.shadowGit.exec([
            'for-each-ref',
            '--format=%(refname)|%(objectname)',
            this.CHECKPOINT_REF_ROOT,
            this.RECOVERY_BACKUP_REF_ROOT,
          ]);
          if (!allDurable.success) {
            throw new CheckpointStoreError('Could not verify shared checkpoint metadata ownership');
          }
          const targetRefs = new Set(refs.map((entry) => entry.ref));
          const externallyReferenced = new Set(
            allDurable.stdout
              .split('\n')
              .filter(Boolean)
              .flatMap((line) => {
                const [ref, oid] = line.split('|');
                return ref && oid && !targetRefs.has(ref) ? [oid] : [];
              }),
          );
          for (const hash of checkpointHashes) {
            if (externallyReferenced.has(hash)) continue;
            const metadataRef = `${this.METADATA_REF_ROOT}/${hash}`;
            const metadataOid = await this.resolveRef(metadataRef);
            if (metadataOid) refs.push({ ref: metadataRef, oid: metadataOid });
          }

          if (refs.length > 0) {
            const transaction = [
              'start',
              ...refs.map((entry) => `delete ${entry.ref} ${entry.oid}`),
              'prepare',
              'commit',
              '',
            ].join('\n');
            const deleted = await this.shadowGit.exec(['update-ref', '--stdin'], {
              stdin: transaction,
            });
            if (!deleted.success) {
              throw new CheckpointStoreError('Atomic session checkpoint ref erasure failed');
            }
          }

          const hashes = [...checkpointHashes];
          for (let index = 0; index < hashes.length; index += 100) {
            const batch = hashes.slice(index, index + 100);
            for (const notesRef of [this.NOTES_REF, this.LEGACY_NOTES_REF]) {
              const removed = await this.shadowGit.exec([
                'notes',
                `--ref=${notesRef}`,
                'remove',
                '--ignore-missing',
                ...batch,
              ]);
              if (!removed.success) {
                throw new CheckpointStoreError(
                  `Session checkpoint notes erasure failed for ${notesRef}`,
                );
              }
            }
          }
          await ShadowRepo.gc(this.workingDirectory, { exclusiveLockHeld: true });
          return { removedRefs: refs.length };
        },
        `checkpoint erasure for ${session}`,
      );
    } finally {
      release();
    }
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

  private async persistManifestRepair(session: string, state: ManifestState): Promise<void> {
    const manifestOid = await this.hashJsonBlob(state.manifest);
    const highWaterOid = await this.hashJsonBlob({
      version: 1,
      nextSequence: state.manifest.nextSequence,
    });
    const zero = await this.zeroObjectId();
    if (!manifestOid || !highWaterOid || !zero) {
      throw new CheckpointStoreError(`Could not prepare repaired manifest for ${session}`);
    }
    const transaction = [
      'start',
      `update ${this.MANIFEST_REF_ROOT}/${session} ${manifestOid} ${state.manifestOid ?? zero}`,
      `update ${this.HIGH_WATER_REF_ROOT}/${session} ${highWaterOid} ${state.highWaterOid ?? zero}`,
      'prepare',
      'commit',
      '',
    ].join('\n');
    const result = await this.shadowGit.exec(['update-ref', '--stdin'], { stdin: transaction });
    if (!result.success) {
      throw new CheckpointStoreError(`Could not publish repaired manifest: ${result.output}`);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private generateId(): string {
    return `ghost_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Bound and redact every free-form field at the persistence boundary. The
   * MessageStore remains the source for full transcripts and tool output. */
  private sanitizeMetadata(metadata: GhostCommitMetadata): GhostCommitMetadata {
    const toolCalls = metadata.toolCalls ?? [];
    const commands = metadata.commands ?? [];
    const fileEdits = metadata.fileEdits ?? [];
    const messageCount = Math.max(
      0,
      Math.trunc(metadata.transcript?.messageCount ?? metadata.transcript?.messageIds?.length ?? 0),
    );

    const boundedToolCalls = toolCalls.slice(0, 50).map((tool) => ({
      name: this.sanitizePreview(tool.name, 80) || 'tool',
      inputPreview: tool.inputPreview
        ? `[input sha256:${createHash('sha256').update(tool.inputPreview).digest('hex').slice(0, 16)}]`
        : undefined,
      resultPreview: tool.resultPreview
        ? `[result sha256:${createHash('sha256').update(tool.resultPreview).digest('hex').slice(0, 16)}]`
        : undefined,
      durationMs: this.nonNegativeNumber(tool.durationMs),
      isError: tool.isError,
    }));
    const boundedCommands = commands.slice(0, 50).map((command) => ({
      command: `[command sha256:${createHash('sha256').update(command.command).digest('hex').slice(0, 16)}]`,
      exitCode: command.exitCode,
      durationMs: this.nonNegativeNumber(command.durationMs),
    }));
    const boundedFileEdits = fileEdits.slice(0, 100).flatMap((edit) => {
      const normalized = this.normalizeChangedFiles([
        { path: edit.path, operation: edit.operation },
      ])?.[0];
      if (!normalized) return [];
      return [
        {
          ...normalized,
          linesAdded: this.nonNegativeNumber(edit.linesAdded),
          linesDeleted: this.nonNegativeNumber(edit.linesDeleted),
        },
      ];
    });

    const transcript = metadata.transcript
      ? {
          userMessagePreview: metadata.transcript.userMessagePreview
            ? `[message sha256:${createHash('sha256').update(metadata.transcript.userMessagePreview).digest('hex').slice(0, 16)}]`
            : undefined,
          assistantResponsePreview: metadata.transcript.assistantResponsePreview
            ? `[response sha256:${createHash('sha256').update(metadata.transcript.assistantResponsePreview).digest('hex').slice(0, 16)}]`
            : undefined,
          reasoningPreview: undefined,
          messageIds: metadata.transcript.messageIds
            ?.slice(0, 50)
            .map((id) => this.sanitizePreview(id, 128))
            .filter((id): id is string => Boolean(id)),
          messageCount,
        }
      : undefined;

    const sanitized: GhostCommitMetadata = {
      id: this.sanitizePreview(metadata.id, 128) || this.generateId(),
      timestamp: metadata.timestamp,
      sequence: metadata.sequence,
      promptHash: this.sanitizePreview(metadata.promptHash, 128),
      baseHead: this.sanitizeObjectId(metadata.baseHead),
      model: this.sanitizePreview(metadata.model, 160),
      agentId: this.validateAgentId(metadata.agentId),
      messageId: this.sanitizePreview(metadata.messageId, 160),
      checkpointType: metadata.checkpointType,
      summary: this.sanitizePreview(metadata.summary, 240),
      provider: this.sanitizePreview(metadata.provider, 120),
      reasoningLevel: this.sanitizePreview(metadata.reasoningLevel, 80),
      cost: this.nonNegativeNumber(metadata.cost),
      tokensIn: this.nonNegativeNumber(metadata.tokensIn),
      tokensOut: this.nonNegativeNumber(metadata.tokensOut),
      changedFiles: metadata.changedFiles?.slice(0, 200),
      toolCalls: boundedToolCalls.length > 0 ? boundedToolCalls : undefined,
      commands: boundedCommands.length > 0 ? boundedCommands : undefined,
      fileEdits: boundedFileEdits.length > 0 ? boundedFileEdits : undefined,
      transcript,
      evidenceCounts:
        toolCalls.length + commands.length + fileEdits.length + messageCount > 0
          ? {
              toolCalls: toolCalls.length,
              commands: commands.length,
              fileEdits: fileEdits.length,
              messages: messageCount,
            }
          : undefined,
    };
    const encoded = JSON.stringify(sanitized);
    if (Buffer.byteLength(encoded, 'utf-8') > 64 * 1024) {
      throw new CheckpointStoreError('Checkpoint metadata exceeds the 64 KiB persistence limit');
    }
    return sanitized;
  }

  private sanitizePreview(value: string | undefined, maxLen: number): string | undefined {
    if (value === undefined) return undefined;
    return redactSecretsInText(value, maxLen);
  }

  private nonNegativeNumber(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
  }

  private sanitizeObjectId(value: string | undefined): string | undefined {
    return value && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
      ? value.toLowerCase()
      : undefined;
  }

  private validateAgentId(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!value || value.length > 512 || /[\0-\x1f\x7f]/.test(value)) {
      throw new CheckpointStoreError(
        'Checkpoint agent ID is empty, oversized, or contains control characters',
      );
    }
    return value;
  }

  private sessionRefKey(agentId: string): string {
    const digest = createHash('sha256').update(agentId).digest('hex');
    const label =
      agentId
        .normalize('NFKC')
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'session';
    return `${label}-${digest}`;
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
      if (
        !path ||
        path === '..' ||
        path.startsWith('../') ||
        path.length > 1024 ||
        path === '.git' ||
        path.startsWith('.git/') ||
        path === '.koryphaios' ||
        path.startsWith('.koryphaios/') ||
        path.includes('\0')
      )
        continue;
      normalized.set(path, change.operation);
    }
    return Array.from(normalized, ([path, operation]) => ({ path, operation }));
  }

  /** Reject reserved paths and any existing symlink/non-directory ancestor.
   * The leaf may itself be a symlink; Git then replaces/removes the link rather
   * than following it. */
  private isSafeRecoveryPath(path: string): boolean {
    if (
      !path ||
      path.startsWith('/') ||
      path === '.git' ||
      path.startsWith('.git/') ||
      path === '.koryphaios' ||
      path.startsWith('.koryphaios/') ||
      path.includes('\0')
    )
      return false;
    const root = resolve(this.workingDirectory);
    const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
    if (normalized !== path || normalized === '..' || normalized.startsWith('../')) return false;
    const segments = path.split('/');
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      if (!existsSync(current)) continue;
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      } catch {
        return false;
      }
    }
    return true;
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
