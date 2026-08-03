/**
 * ShadowLogger - Git Reflog Recorder for Time Travel
 *
 * This utility creates "ghost commits" - dangling, unreachable commits that capture
 * the state after every AI agent change. These commits are stored in the reflog
 * and annotated with metadata (model, prompt, cost) using git notes.
 *
 * Features:
 * - Ghost Commits: Creates dangling commits via git commit-tree (not on any branch)
 * - Metadata: Attaches model, prompt, cost via git notes
 * - Timeline: Scrapes reflog to build a time travel history
 * - Recovery: Hard reset to any ghost commit state
 */

import { koryLog } from '../logger';
import { gitMutex } from './git-mutex';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface CheckpointFileChange {
  path: string;
  operation: 'create' | 'edit' | 'delete';
}

export interface GhostCommitMetadata {
  /** Unique ID for this ghost commit */
  id: string;
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
}

export class ShadowLogger {
  private readonly GHOST_PREFIX = '[GHOST]';
  private readonly NOTES_REF = 'refs/notes/shadow-logger';
  private readonly CHECKPOINT_REF_ROOT = 'refs/kory/checkpoints';
  private readonly CURSOR_REF_ROOT = 'refs/kory/cursors';

  constructor(protected workingDirectory: string) {}

  private async runGit(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ success: boolean; output: string }> {
    const release = await gitMutex.acquire();
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd: this.workingDirectory,
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { success: exitCode === 0, output: (stdout + stderr).trim() };
    } finally {
      release();
    }
  }

  /**
   * Create an immutable checkpoint from the working tree using a private index.
   *
   * The user's index, HEAD, branch and ordinary git log are never modified.
   *
   * @param message Description of what changed
   * @param metadata Optional metadata about the AI operation
   * @returns The ghost commit hash, or null if failed
   */
  async createGhostCommit(
    message: string,
    metadata?: Omit<GhostCommitMetadata, 'id' | 'timestamp'>,
  ): Promise<string | null> {
    const parentResult = await this.runGit(['rev-parse', 'HEAD']);
    if (!parentResult.success) {
      koryLog.error('Failed to get HEAD for ghost commit');
      return null;
    }
    const parent = parentResult.output.trim();
    const { prompt, changedFiles, ...metadataWithoutPrompt } = metadata ?? {};
    const checkpointMetadata: GhostCommitMetadata = {
      ...metadataWithoutPrompt,
      promptHash: prompt
        ? createHash('sha256').update(prompt).digest('hex')
        : metadataWithoutPrompt.promptHash,
      changedFiles: this.normalizeChangedFiles(changedFiles),
      id: this.generateId(),
      timestamp: Date.now(),
    };
    const privateIndexDirectory = mkdtempSync(join(tmpdir(), 'kory-checkpoint-index-'));
    const privateIndex = join(privateIndexDirectory, 'index');
    const indexEnv = { GIT_INDEX_FILE: privateIndex };
    let tree: string;
    try {
      const readTree = await this.runGit(['read-tree', parent], indexEnv);
      if (!readTree.success) throw new Error(readTree.output);
      const addResult = await this.runGit(['add', '-A', '--', '.'], indexEnv);
      if (!addResult.success) throw new Error(addResult.output);
      const treeResult = await this.runGit(['write-tree'], indexEnv);
      if (!treeResult.success) throw new Error(treeResult.output);
      tree = treeResult.output.trim();
    } catch (error) {
      koryLog.error({ error }, 'Failed to create private checkpoint tree');
      return null;
    } finally {
      rmSync(privateIndexDirectory, { recursive: true, force: true });
    }

    // Create the ghost commit using commit-tree (creates dangling commit)
    const ghostMessage = `${this.GHOST_PREFIX} ${message}`;
    const commitResult = await this.runGit([
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      ghostMessage,
      '-m',
      `Kory-Checkpoint-ID: ${checkpointMetadata.id}`,
    ]);

    if (!commitResult.success) {
      koryLog.error({ output: commitResult.output }, 'Failed to create ghost commit');
      return null;
    }

    const ghostHash = commitResult.output.trim();

    await this.attachMetadata(ghostHash, checkpointMetadata);
    const session = this.sanitizeRefPart(metadata?.agentId ?? 'unscoped');
    const checkpointRef = `${this.CHECKPOINT_REF_ROOT}/${session}/${checkpointMetadata.timestamp}-${this.sanitizeRefPart(checkpointMetadata.id)}`;
    const refResult = await this.runGit(['update-ref', checkpointRef, ghostHash]);
    if (!refResult.success) {
      koryLog.error({ checkpointRef, output: refResult.output }, 'Failed to retain checkpoint ref');
      return null;
    }
    await this.setCursor(metadata?.agentId, ghostHash);

    koryLog.info({ ghostHash, checkpointRef, message }, 'Checkpoint created');

    return ghostHash;
  }

  async getCursor(agentId: string): Promise<string | null> {
    const result = await this.runGit([
      'rev-parse',
      '--verify',
      `${this.CURSOR_REF_ROOT}/${this.sanitizeRefPart(agentId)}`,
    ]);
    return result.success ? result.output.trim() : null;
  }

  async setCursor(agentId: string | undefined, hash: string): Promise<boolean> {
    if (!agentId) return false;
    return (
      await this.runGit([
        'update-ref',
        `${this.CURSOR_REF_ROOT}/${this.sanitizeRefPart(agentId)}`,
        hash,
      ])
    ).success;
  }

  async isOwnedCheckpoint(hash: string, agentId: string): Promise<boolean> {
    if ((await this.getMetadata(hash))?.agentId !== agentId) return false;
    const refs = await this.runGit([
      'for-each-ref',
      '--format=%(objectname)',
      `${this.CHECKPOINT_REF_ROOT}/${this.sanitizeRefPart(agentId)}`,
    ]);
    return refs.success && refs.output.split('\n').includes(hash);
  }

  async worktreePathMatches(hash: string, path: string): Promise<boolean> {
    const normalized = this.normalizeChangedFiles([{ path, operation: 'edit' }])?.[0]?.path;
    if (!normalized) return false;
    const expected = await this.runGit(['rev-parse', `${hash}:${normalized}`]);
    const absolute = resolve(this.workingDirectory, normalized);
    if (!expected.success) return !existsSync(absolute);
    if (!existsSync(absolute)) return false;
    const actual = await this.runGit(['hash-object', '--', normalized]);
    return actual.success && actual.output.trim() === expected.output.trim();
  }

  /**
   * Attach metadata to a ghost commit using git notes
   */
  private async attachMetadata(hash: string, metadata: GhostCommitMetadata): Promise<void> {
    const notesContent = JSON.stringify(metadata, null, 2);

    const result = await this.runGit([
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
      koryLog.warn({ hash, output: result.output }, 'Failed to attach metadata');
    }
  }

  /**
   * Get metadata attached to a commit
   */
  async getMetadata(hash: string): Promise<GhostCommitMetadata | undefined> {
    const result = await this.runGit(['notes', '--ref', this.NOTES_REF, 'show', hash]);

    if (!result.success) return undefined;

    try {
      return JSON.parse(result.output) as GhostCommitMetadata;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the timeline of ghost commits from the reflog
   *
   * Scrapes the reflog for ghost commits and presents them as a
   * "Time Travel" list for UI display.
   *
   * @param limit Maximum number of entries to return (default: 50)
   * @returns Array of timeline entries, newest first
   */
  async getTimeline(limit = 50, filterAgentId?: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    const seenHashes = new Set<string>();
    const refsResult = await this.runGit([
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
        });
      }
    }

    // Backward compatibility: retain discovery of checkpoints made by older releases.
    const reflogResult = await this.runGit([
      'reflog',
      'show',
      'HEAD',
      '--format=%H|%gd|%gs|%ct',
      '-n',
      String(limit * 5), // Get more to filter for ghosts and agent IDs
    ]);

    if (!reflogResult.success) return entries;

    for (const line of reflogResult.output.split('\n').filter(Boolean)) {
      const [hash, _reflogSelector, subject, timestamp] = line.split('|');

      if (!hash || seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      // Check if this is a ghost commit
      const isGhost = subject?.includes(this.GHOST_PREFIX) || subject?.startsWith('ghost:');

      const metadata = await this.getMetadata(hash);

      // Filter by agentId if requested
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
        });
      }

      if (entries.length >= limit) break;
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * Get detailed ghost commit information
   *
   * @param hash The ghost commit hash
   * @returns Full ghost commit details
   */
  async getGhostCommit(hash: string): Promise<GhostCommit | null> {
    // Verify this is a valid commit
    const catResult = await this.runGit(['cat-file', '-t', hash]);
    if (!catResult.success || catResult.output !== 'commit') {
      return null;
    }

    // Get commit details
    const showResult = await this.runGit(['show', hash, '--format=%H|%P|%s|%ct', '--no-patch']);

    if (!showResult.success) return null;

    const [commitHash, parent, subject, timestamp] = showResult.output.split('|');

    // Get file changes
    const diffResult = await this.runGit([
      'diff-tree',
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

  /**
   * Recover to a specific ghost commit state
   *
   * Restores the checkpoint into the index/worktree without moving HEAD or the branch.
   *
   * @param ghostHash The ghost commit hash to recover to
   * @returns Success status and details
   */
  async recover(
    ghostHash: string,
    options: { agentId: string; changedFiles: CheckpointFileChange[] },
  ): Promise<{ success: boolean; message: string; previousHash?: string }> {
    // Verify the ghost commit exists
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
      const exists = await this.runGit(['cat-file', '-e', `${ghostHash}:${path}`]);
      (exists.success ? existingAtTarget : absentAtTarget).push(path);
    }
    if (existingAtTarget.length > 0) {
      const restored = await this.runGit([
        'restore',
        '--source',
        ghostHash,
        '--staged',
        '--worktree',
        '--',
        ...existingAtTarget,
      ]);
      if (!restored.success) {
        koryLog.error({ ghostHash, output: restored.output }, 'Recovery failed');
        return { success: false, message: 'Restore failed: ' + restored.output };
      }
    }
    for (const path of absentAtTarget) {
      await this.runGit(['rm', '-f', '--ignore-unmatch', '--', path]);
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
   *
   * @param ghostHash The ghost commit to compare against
   * @returns Diff output showing changes
   */
  async compareWithGhost(ghostHash: string): Promise<string> {
    const result = await this.runGit(['diff', ghostHash, 'HEAD']);
    return result.success ? result.output : '';
  }

  /**
   * Clean up old ghost commits
   *
   * Removes reflog entries older than the specified days.
   * Note: This doesn't delete the objects immediately (git gc will clean them)
   *
   * @param olderThanDays Remove ghost entries older than this many days
   * @returns Number of entries removed
   */
  async prune(olderThanDays = 30): Promise<{ removed: number; message: string }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const refs = await this.runGit([
      'for-each-ref',
      '--format=%(refname)|%(creatordate:unix)',
      this.CHECKPOINT_REF_ROOT,
    ]);
    if (!refs.success) return { removed: 0, message: 'Failed to list checkpoints' };
    let removed = 0;
    for (const line of refs.output.split('\n').filter(Boolean)) {
      const [ref, timestamp] = line.split('|');
      if (ref && Number(timestamp) * 1000 < cutoffDate.getTime()) {
        const deleted = await this.runGit(['update-ref', '-d', ref]);
        if (deleted.success) removed++;
      }
    }

    koryLog.info({ olderThanDays }, 'Pruned old ghost commits');

    return {
      removed,
      message: `Pruned ${removed} checkpoints older than ${olderThanDays} days`,
    };
  }

  /**
   * Get statistics about ghost commits
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
    // Clean up the ghost prefix
    let desc = subject
      .replace(new RegExp(`^${this.GHOST_PREFIX}\\s*`), '')
      .replace(/^ghost:\s*/, '');

    // If we have metadata, enhance the description
    if (metadata?.prompt) {
      desc = metadata.prompt.slice(0, 60) + (metadata.prompt.length > 60 ? '...' : '');
    }

    return desc || 'Unnamed state';
  }
}

export class ShadowLoggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowLoggerError';
  }
}
