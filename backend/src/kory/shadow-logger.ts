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

export interface GhostCommitMetadata {
  /** Unique ID for this ghost commit */
  id: string;
  /** Model name used (e.g., "claude-sonnet-4-5") */
  model?: string;
  /** The prompt/task that generated these changes */
  prompt?: string;
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
  checkpointType?: 'turn_end' | 'user_manual' | 'auto_save';
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

  constructor(protected workingDirectory: string) {}

  private async runGit(args: string[]): Promise<{ success: boolean; output: string }> {
    const release = await gitMutex.acquire();
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd: this.workingDirectory,
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
   * Create a ghost commit from the current index/state
   *
   * This creates a dangling commit (not attached to any branch) that captures
   * the current working directory state. The commit is reachable via reflog.
   *
   * @param message Description of what changed
   * @param metadata Optional metadata about the AI operation
   * @returns The ghost commit hash, or null if failed
   */
  async createGhostCommit(
    message: string,
    metadata?: Omit<GhostCommitMetadata, 'id' | 'timestamp'>,
  ): Promise<string | null> {
    // Stage all current changes first
    await this.runGit(['add', '-A']);

    // Get the current HEAD to use as parent
    const parentResult = await this.runGit(['rev-parse', 'HEAD']);
    if (!parentResult.success) {
      koryLog.error('Failed to get HEAD for ghost commit');
      return null;
    }
    const parent = parentResult.output.trim();

    // Write the tree from the index
    const treeResult = await this.runGit(['write-tree']);
    if (!treeResult.success) {
      koryLog.error('Failed to write tree for ghost commit');
      return null;
    }
    const tree = treeResult.output.trim();

    // Create the ghost commit using commit-tree (creates dangling commit)
    const ghostMessage = `${this.GHOST_PREFIX} ${message}`;
    const commitResult = await this.runGit(['commit-tree', tree, '-p', parent, '-m', ghostMessage]);

    if (!commitResult.success) {
      koryLog.error({ output: commitResult.output }, 'Failed to create ghost commit');
      return null;
    }

    const ghostHash = commitResult.output.trim();

    // Add metadata via git notes
    if (metadata) {
      await this.attachMetadata(ghostHash, {
        ...metadata,
        id: this.generateId(),
        timestamp: Date.now(),
      });
    }

    // Update HEAD reflog so this ghost commit appears in timeline
    // This makes it reachable for get_timeline() but doesn't affect branches
    await this.runGit(['update-ref', '-m', `ghost: ${message.slice(0, 50)}`, 'HEAD', ghostHash, parent]);

    koryLog.info({ ghostHash, message }, 'Ghost commit created');

    return ghostHash;
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
    // Get reflog entries
    const reflogResult = await this.runGit([
      'reflog',
      'show',
      'HEAD',
      '--format=%H|%gd|%gs|%ct',
      '-n',
      String(limit * 5), // Get more to filter for ghosts and agent IDs
    ]);

    if (!reflogResult.success) {
      koryLog.error('Failed to read reflog');
      return [];
    }

    const entries: TimelineEntry[] = [];
    const seenHashes = new Set<string>();

    for (const line of reflogResult.output.split('\n').filter(Boolean)) {
      const [hash, reflogSelector, subject, timestamp] = line.split('|');

      if (!hash || seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      // Check if this is a ghost commit
      const isGhost = subject?.includes(this.GHOST_PREFIX) || subject?.startsWith('ghost:');

      // Also include regular commits that have shadow metadata
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

    return entries;
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
    const diffResult = await this.runGit(['diff-tree', '--no-commit-id', '--name-status', '-r', hash]);

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
   * Performs a hard reset to the ghost commit hash, instantly reverting
   * the working directory to that state.
   *
   * @param ghostHash The ghost commit hash to recover to
   * @returns Success status and details
   */
  async recover(ghostHash: string): Promise<{ success: boolean; message: string; previousHash?: string }> {
    // Verify the ghost commit exists
    const ghost = await this.getGhostCommit(ghostHash);
    if (!ghost) {
      return { success: false, message: 'Ghost commit not found' };
    }

    // Get current HEAD before recovery (for undo capability)
    const currentResult = await this.runGit(['rev-parse', 'HEAD']);
    const previousHash = currentResult.success ? currentResult.output.trim() : undefined;

    // Create a recovery point before we reset (safety net)
    if (previousHash) {
      await this.createGhostCommit('Auto-save before recovery', {
        prompt: 'Automatic checkpoint before time travel recovery',
      });
    }

    // Perform hard reset to ghost state
    const resetResult = await this.runGit(['reset', '--hard', ghostHash]);

    if (!resetResult.success) {
      koryLog.error({ ghostHash, output: resetResult.output }, 'Recovery failed');
      return { success: false, message: 'Reset failed: ' + resetResult.output };
    }

    // Clean any untracked files that might remain
    await this.runGit(['clean', '-fd']);

    koryLog.info({ ghostHash, previousHash }, 'Recovered to ghost state');

    return {
      success: true,
      message: `Recovered to state: ${ghost.message.slice(0, 50)}`,
      previousHash,
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

    // Expire reflog entries older than cutoff
    const expireResult = await this.runGit([
      'reflog',
      'expire',
      '--expire-unreachable=' + cutoffDate.toISOString(),
      '--all',
    ]);

    if (!expireResult.success) {
      return { removed: 0, message: 'Failed to prune: ' + expireResult.output };
    }

    // Also prune shadow notes
    await this.runGit([
      'notes',
      '--ref',
      this.NOTES_REF,
      'expire',
      '--expire-unreachable=' + olderThanDays + '.days.ago',
    ]);

    koryLog.info({ olderThanDays }, 'Pruned old ghost commits');

    return {
      removed: 0, // Git doesn't give us an exact count
      message: `Pruned entries older than ${olderThanDays} days`,
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
