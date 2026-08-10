/**
 * WorkspaceManager - Git Worktree-based Parallel Agent Isolation
 *
 * This manager uses Git Worktrees to provide filesystem isolation for parallel
 * AI agents, preventing them from clobbering each other's work.
 *
 * Features:
 * - Isolation: Each task runs in its own worktree with a dedicated branch
 * - Security: .env files are not copied unless explicitly requested
 * - Cleanup: Automatic worktree/branch removal after changes are reconciled
 * - Resource Guard: Configurable concurrent worktree limit based on system RAM
 * - Persistence: Worktree metadata survives crashes via .koryphaios/worktrees.json
 * - Lifecycle: shutdown() drains all active worktrees
 *
 * All git operations go through GitExecutor, which serializes them via gitMutex.
 * All filesystem operations use fs/promises — the event loop is never blocked.
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, readdir, symlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { koryLog, serverLog } from '../logger';
import { GitExecutor } from './git-executor';
import type { KoryphaiosConfig } from '@koryphaios/shared';

export interface WorktreeInfo {
  id: string;
  taskName: string;
  branchName: string;
  path: string;
  createdAt: number;
  agentId?: string;
  /** Commit the worktree branched from — used to diff the worker's changes. */
  baseSha?: string;
}

export interface WorktreeStatus {
  active: WorktreeInfo[];
  availableSlots: number;
  maxAllowed: number;
}

interface WorktreeManifest {
  worktrees: WorktreeInfo[];
}

type WorkspaceGitOperation =
  | 'worktree-add'
  | 'stash-push'
  | 'checkout'
  | 'merge-squash'
  | 'merge'
  | 'stash-apply'
  | 'stash-drop'
  | 'worktree-remove'
  | 'worktree-prune';

/** Git output can contain repository-controlled hook/helper text, filenames,
 * and credential-shaped values. Logs retain only bounded structural facts;
 * callers may still inspect the in-memory result for control flow. */
export function workspaceGitLogMetadata(
  operation: WorkspaceGitOperation,
  result: { success: boolean; output: string },
): { gitOperation: WorkspaceGitOperation; success: boolean; outputLength: number } {
  return {
    gitOperation: operation,
    success: result.success,
    outputLength: result.output.length,
  };
}

export class WorkspaceManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private worktreeDir: string;
  private maxConcurrent: number;
  private copyEnvFiles: boolean;
  private skipHooks: boolean;
  private repoRoot: string;
  private git: GitExecutor;
  private gitignoreUpdated = false;
  private manifestPath: string;
  /** Explicit branch to reconcile worker changes into. null = use the branch the user
   *  currently has checked out (i.e. "whatever branch was selected on the user's system"). */
  private targetBranch: string | null = null;

  constructor(repoRoot: string, config?: KoryphaiosConfig['workspace']) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeDir = config?.worktreeDir ?? '.trees';
    this.maxConcurrent = config?.worktreeLimit ?? 4;
    this.copyEnvFiles = config?.copyEnvFiles ?? false;
    this.skipHooks = config?.skipHooks ?? true;
    this.git = new GitExecutor(this.repoRoot);
    this.manifestPath = join(this.repoRoot, '.koryphaios', 'worktrees.json');
  }

  /**
   * Async initialization — must be called after construction before any other method.
   * Validates the git repo, ensures .gitignore, and recovers worktrees from persisted
   * metadata cross-referenced with `git worktree list`.
   */
  async init(): Promise<void> {
    if (!(await this.isGitRepo())) {
      throw new WorkspaceError('Not a valid Git repository');
    }

    await this.ensureGitignoreEntry();
    await this.recover();

    koryLog.info(
      {
        worktreeDir: this.worktreeDir,
        maxConcurrent: this.maxConcurrent,
        copyEnvFiles: this.copyEnvFiles,
        skipHooks: this.skipHooks,
        recoveredCount: this.worktrees.size,
      },
      'WorkspaceManager initialized',
    );
  }

  /**
   * Recover existing worktrees from persisted metadata, cross-referenced with
   * `git worktree list`. Metadata is loaded from .koryphaios/worktrees.json so
   * recovery is lossless — taskName, createdAt, agentId, baseSha are all preserved.
   * Worktrees that git no longer lists are pruned from the manifest. Orphan worktrees
   * (in our directory but not in the manifest) are cleaned up.
   */
  private async recover(): Promise<void> {
    const allWorktrees = await this.listAllWorktrees();
    const worktreeBaseDir = resolve(this.repoRoot, this.worktreeDir);
    const manifest = await this.loadManifest();
    const manifestById = new Map(manifest.worktrees.map((wt) => [wt.id, wt]));

    for (const wt of allWorktrees) {
      // On Windows, `git worktree list --porcelain` may report paths using
      // 8.3 short names (e.g. RUNNER~1) while the WorkspaceManager was
      // constructed with the canonical long name (e.g. runneradmin). The
      // startsWith prefix check below would silently skip every worktree,
      // causing hasWorktree() to return false after a restart. Canonicalize
      // both sides through realpathSync so the comparison is consistent.
      let absoluteWtPath = resolve(wt.path);
      try {
        absoluteWtPath = realpathSync(absoluteWtPath);
      } catch {
        // realpathSync fails if the path doesn't exist (e.g. a stale
        // worktree entry). Keep the resolved path so the startsWith check
        // can still filter it out naturally.
      }
      let canonicalBaseDir = worktreeBaseDir;
      try {
        canonicalBaseDir = realpathSync(worktreeBaseDir);
      } catch {
        // worktreeBaseDir may not exist yet on first run; fall back to the
        // resolved path.
      }
      if (!absoluteWtPath.startsWith(canonicalBaseDir)) continue;

      const taskId = relative(canonicalBaseDir, absoluteWtPath);
      if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..'))
        continue;

      // Prefer persisted metadata; fall back to git-derived info for orphans
      const persisted = manifestById.get(taskId);
      if (persisted) {
        this.worktrees.set(taskId, {
          ...persisted,
          branchName: wt.branch || persisted.branchName,
          path: absoluteWtPath,
        });
      } else {
        // Orphan from a pre-manifest version or a crash before manifest write.
        // Keep it tracked so it can be cleaned up explicitly.
        this.worktrees.set(taskId, {
          id: taskId,
          taskName: 'Recovered Orphan',
          branchName: wt.branch || 'unknown',
          path: absoluteWtPath,
          createdAt: Date.now(),
        });
      }
    }

    // Persist the reconciled manifest (drops entries for worktrees git no longer has)
    await this.saveManifest();
  }

  /**
   * Get current worktree status including available slots
   */
  getStatus(): WorktreeStatus {
    return {
      active: Array.from(this.worktrees.values()),
      availableSlots: this.maxConcurrent - this.worktrees.size,
      maxAllowed: this.maxConcurrent,
    };
  }

  /**
   * Check if we can spawn a new worktree
   */
  canSpawn(): boolean {
    return this.worktrees.size < this.maxConcurrent;
  }

  /**
   * Create a new isolated worktree for a task
   * @param taskId Unique identifier for the task
   * @param taskName Human-readable task name (used for branch naming)
   * @param agentId Optional agent/session ID that owns this worktree
   * @returns WorktreeInfo on success, null if at capacity
   */
  async spawn(taskId: string, taskName: string, agentId?: string): Promise<WorktreeInfo | null> {
    // Resource Guard: Check concurrent limit
    if (!this.canSpawn()) {
      koryLog.warn(
        {
          taskId,
          current: this.worktrees.size,
          max: this.maxConcurrent,
        },
        'Cannot spawn worktree: at capacity',
      );
      return null;
    }

    // Sanitize task name for branch name — use the full taskId for uniqueness
    const sanitizedTaskName = this.sanitizeBranchName(taskName);
    const branchName = `ai/${sanitizedTaskName}-${taskId}`;
    const worktreePath = join(this.repoRoot, this.worktreeDir, taskId);

    // Create worktree directory if it doesn't exist
    const worktreeBaseDir = join(this.repoRoot, this.worktreeDir);
    if (!existsSync(worktreeBaseDir)) {
      await mkdir(worktreeBaseDir, { recursive: true });
    }

    // Record the base commit so we can later diff exactly what the worker changed.
    const baseResult = await this.git.execCombined(['rev-parse', 'HEAD']);
    const baseSha = baseResult.output.trim() || undefined;

    // Create the worktree with a new branch
    const result = await this.git.execCombined([
      'worktree',
      'add',
      '-b',
      branchName,
      worktreePath,
      'HEAD',
    ]);
    if (!result.success) {
      koryLog.error(
        { taskId, ...workspaceGitLogMetadata('worktree-add', result) },
        'Failed to create worktree',
      );
      return null;
    }

    // Handle .env file copying based on security policy
    if (this.copyEnvFiles) {
      await this.copyEnvToWorktree(worktreePath);
    }

    // Make dependencies resolvable in the worktree so the Critic's hard check (`bun test`)
    // can exercise the worker's actual diff. A fresh worktree has no node_modules (gitignored),
    // so symlink the repo's installed deps in — fast, zero-copy, and ignored by git.
    await this.linkDependencies(worktreePath);

    const worktree: WorktreeInfo = {
      id: taskId,
      taskName,
      branchName,
      path: worktreePath,
      createdAt: Date.now(),
      agentId,
      baseSha,
    };

    this.worktrees.set(taskId, worktree);
    await this.saveManifest();

    koryLog.info(
      {
        taskId,
        branchName,
        path: worktreePath,
        agentId,
      },
      'Worktree created',
    );

    return worktree;
  }

  /**
   * Set an explicit branch to reconcile worker changes into. Pass null to revert
   * to "merge into whatever branch the user currently has checked out".
   */
  setTargetBranch(branch: string | null): void {
    this.targetBranch = branch && branch.trim() ? branch.trim() : null;
    koryLog.info({ targetBranch: this.targetBranch }, 'Reconcile target branch updated');
  }

  /** The branch the user currently has checked out in the main repo. */
  async getCurrentBranch(): Promise<string | null> {
    const result = await this.git.execCombined(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = result.output.trim();
    return result.success && branch && branch !== 'HEAD' ? branch : null;
  }

  /**
   * Reconcile changes from a worktree back into the target branch and clean up.
   * The target is the explicitly-set branch, else the user's currently checked-out
   * branch, else a conventional main branch — so worker output lands on the branch
   * the user actually selected rather than always on main.
   * @param taskId The task/worktree ID to reconcile
   * @param squash Whether to squash commits (true) or preserve history (false)
   * @returns Success status and details
   */
  async reconcile(taskId: string, squash = true): Promise<{ success: boolean; message: string }> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    const commitArgs = this.skipHooks ? ['--no-verify'] : [];

    // Check for uncommitted changes in the worktree
    // Ignore node_modules in the change check — a symlinked node_modules isn't matched by
    // the dir-only gitignore pattern, so it would otherwise look like a pending change.
    const statusResult = await this.git.execCombined([
      '-C',
      worktree.path,
      'status',
      '--porcelain',
    ]);
    const hasChanges = statusResult.output
      .split('\n')
      .some((line) => line.trim() && !line.includes('node_modules'));

    if (hasChanges) {
      // Auto-commit any pending changes, explicitly excluding dependency dirs so the
      // symlinked node_modules never get committed onto the user's branch.
      await this.git.execCombined([
        '-C',
        worktree.path,
        'add',
        '-A',
        '--',
        '.',
        ':(exclude)node_modules',
        ':(exclude)**/node_modules',
      ]);
      const commitResult = await this.git.execCombined([
        '-C',
        worktree.path,
        'commit',
        '-m',
        `[AI] Changes from ${worktree.taskName}`,
        ...commitArgs,
      ]);

      if (!commitResult.success) {
        return { success: false, message: 'Failed to commit changes in worktree' };
      }
    }

    // Return to the selected branch and merge the worktree branch into it.
    const mainBranch =
      this.targetBranch ?? (await this.getCurrentBranch()) ?? (await this.getMainBranch());

    // Check if main repository has uncommitted changes that might block checkout
    const mainStatus = await this.git.execCombined(['status', '--porcelain']);
    const mainHasChanges = mainStatus.output.trim() !== '';
    let autoStashHash: string | null = null;

    if (mainHasChanges) {
      koryLog.info('Stashing changes in main repo before reconcile');
      const beforeStash = await this.git.exec(['rev-parse', '--verify', 'refs/stash']);
      const beforeStashHash = beforeStash.success ? beforeStash.stdout.trim() : null;
      const stashResult = await this.git.execCombined([
        'stash',
        'push',
        '--include-untracked',
        '-m',
        `[KORY] Auto-stash for reconcile ${taskId}`,
      ]);
      const afterStash = await this.git.exec(['rev-parse', '--verify', 'refs/stash']);
      const afterStashHash = afterStash.success ? afterStash.stdout.trim() : null;
      if (afterStashHash && afterStashHash !== beforeStashHash) {
        autoStashHash = afterStashHash;
      }
      if (!stashResult.success || !autoStashHash) {
        if (autoStashHash) await this.restoreAutoStash(taskId, autoStashHash);
        koryLog.error(
          { taskId, ...workspaceGitLogMetadata('stash-push', stashResult) },
          'Failed to create a verifiable reconcile stash',
        );
        return {
          success: false,
          message: 'Could not safely preserve main-repository changes before reconcile.',
        };
      }
    }

    try {
      // Checkout main
      const checkoutResult = await this.git.execCombined(['checkout', mainBranch]);
      if (!checkoutResult.success) {
        koryLog.error(
          { taskId, ...workspaceGitLogMetadata('checkout', checkoutResult) },
          'Failed to checkout selected reconcile branch',
        );
        return {
          success: false,
          message: 'Failed to check out the selected reconcile branch.',
        };
      }

      if (squash) {
        // Squash merge: Combine all worktree changes into one commit
        const mergeResult = await this.git.execCombined(['merge', '--squash', worktree.branchName]);

        if (!mergeResult.success) {
          koryLog.error(
            { taskId, ...workspaceGitLogMetadata('merge-squash', mergeResult) },
            'Squash merge failed',
          );
          return {
            success: false,
            message: 'Merge failed. Resolve the reported Git conflict or hook failure, then retry.',
          };
        }

        // Commit the squashed changes
        const commitResult = await this.git.execCombined([
          'commit',
          '-m',
          `feat: ${worktree.taskName} [ai-${taskId}]`,
          ...commitArgs,
        ]);

        if (!commitResult.success) {
          return { success: false, message: 'Failed to commit squashed changes' };
        }
      } else {
        // Regular merge: Preserve all commits from worktree
        const mergeResult = await this.git.execCombined([
          'merge',
          worktree.branchName,
          '-m',
          `Merge ${worktree.branchName} into ${mainBranch}`,
        ]);

        if (!mergeResult.success) {
          koryLog.error(
            { taskId, ...workspaceGitLogMetadata('merge', mergeResult) },
            'Merge failed',
          );
          return {
            success: false,
            message: 'Merge failed. Resolve the reported Git conflict or hook failure, then retry.',
          };
        }
      }

      // Cleanup: Remove worktree and branch
      const cleanupResult = await this.cleanup(taskId);

      return {
        success: true,
        message: cleanupResult.success
          ? `Changes reconciled and worktree cleaned up`
          : `Changes reconciled but cleanup failed: ${cleanupResult.message}`,
      };
    } finally {
      // Restore the exact object Kory created. Never `stash pop` the mutable
      // stack head: another/pre-existing user stash must not be consumed.
      if (autoStashHash) await this.restoreAutoStash(taskId, autoStashHash);
    }
  }

  private async restoreAutoStash(taskId: string, stashHash: string): Promise<void> {
    const applyResult = await this.git.execCombined(['stash', 'apply', '--index', stashHash]);
    if (!applyResult.success) {
      koryLog.error(
        {
          taskId,
          stashHash,
          ...workspaceGitLogMetadata('stash-apply', applyResult),
          recovery: `git stash apply --index ${stashHash}`,
        },
        'Exact reconcile stash could not be restored; retained for recovery',
      );
      return;
    }

    // Drop only when the current stack head is still exactly Kory's object.
    // If any other actor changed the stack, leave the applied backup in place
    // instead of guessing an index and risking unrelated stash deletion.
    const current = await this.git.exec(['rev-parse', '--verify', 'refs/stash']);
    if (!current.success || current.stdout.trim() !== stashHash) {
      koryLog.warn(
        { taskId, stashHash },
        'Reconcile stash restored but retained because the stash stack changed concurrently',
      );
      return;
    }
    const dropResult = await this.git.execCombined(['stash', 'drop', 'stash@{0}']);
    if (!dropResult.success) {
      koryLog.warn(
        { taskId, stashHash, ...workspaceGitLogMetadata('stash-drop', dropResult) },
        'Reconcile stash restored but its backup could not be dropped',
      );
    }
  }

  /**
   * Clean up a worktree and its branch without merging
   * @param taskId The task/worktree ID to clean up
   * @returns Success status
   */
  async cleanup(taskId: string): Promise<{ success: boolean; message: string }> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    // Remove the worktree
    const removeResult = await this.git.execCombined([
      'worktree',
      'remove',
      '--force',
      worktree.path,
    ]);
    if (!removeResult.success) {
      koryLog.error(
        { taskId, ...workspaceGitLogMetadata('worktree-remove', removeResult) },
        'Failed to remove worktree',
      );
      return {
        success: false,
        message: 'Failed to remove the worktree. Inspect Git state and retry cleanup.',
      };
    }

    // Delete the branch
    await this.git.execCombined(['branch', '-D', worktree.branchName]);

    // Remove from tracking
    this.worktrees.delete(taskId);
    await this.saveManifest();

    koryLog.info({ taskId, branch: worktree.branchName }, 'Worktree cleaned up');

    return { success: true, message: 'Worktree and branch removed' };
  }

  /**
   * Get the path for a worktree by task ID
   */
  getWorktreePath(taskId: string): string | null {
    const worktree = this.worktrees.get(taskId);
    return worktree?.path ?? null;
  }

  /**
   * Files the worker changed in its worktree, relative to the repo root. Includes
   * committed + uncommitted tracked changes (diffed against the base commit) plus
   * new untracked files. Used to scope the Critic's hard check to just the diff.
   */
  async getChangedFiles(taskId: string): Promise<string[]> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) return [];
    const base = worktree.baseSha ?? 'HEAD';
    const files = new Set<string>();
    // Tracked changes (committed or working-tree) since the base commit.
    const tracked = await this.git.execCombined(['-C', worktree.path, 'diff', '--name-only', base]);
    if (tracked.success) {
      for (const line of tracked.output.split('\n')) {
        const f = line.trim();
        if (f) files.add(f);
      }
    }
    // New untracked files (respecting .gitignore, so node_modules symlinks are skipped).
    const untracked = await this.git.execCombined([
      '-C',
      worktree.path,
      'ls-files',
      '--others',
      '--exclude-standard',
    ]);
    if (untracked.success) {
      for (const line of untracked.output.split('\n')) {
        const f = line.trim();
        if (f) files.add(f);
      }
    }
    // Drop dependency dirs: a symlinked node_modules isn't matched by the dir-only
    // `node_modules/` gitignore pattern, so it can leak into untracked output here.
    return [...files].filter((f) => !/(^|\/)node_modules(\/|$)/.test(f));
  }

  /**
   * Check if a task has an active worktree
   */
  hasWorktree(taskId: string): boolean {
    return this.worktrees.has(taskId);
  }

  /**
   * List all Git worktrees (including ones we didn't create)
   */
  async listAllWorktrees(): Promise<Array<{ path: string; branch?: string; detached: boolean }>> {
    const result = await this.git.execCombined(['worktree', 'list', '--porcelain']);
    if (!result.success) return [];

    const worktrees: Array<{ path: string; branch?: string; detached: boolean }> = [];
    let current: Partial<{ path: string; branch?: string; detached: boolean }> = {};

    for (const line of result.output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path)
          worktrees.push(current as { path: string; branch?: string; detached: boolean });
        current = { path: line.slice(9).trim(), detached: false };
      } else if (line.startsWith('branch ')) {
        current.branch = line
          .slice(7)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        current.detached = true;
      }
    }

    if (current.path)
      worktrees.push(current as { path: string; branch?: string; detached: boolean });

    return worktrees;
  }

  /**
   * Prune any stale worktree references
   */
  async prune(): Promise<{ success: boolean; message: string }> {
    const result = await this.git.execCombined(['worktree', 'prune']);
    if (result.success) {
      return { success: true, message: 'Stale worktree references pruned' };
    }
    koryLog.warn(
      workspaceGitLogMetadata('worktree-prune', result),
      'Failed to prune stale worktree references',
    );
    return {
      success: false,
      message: 'Failed to prune stale worktree references. Inspect Git state and retry.',
    };
  }

  /**
   * Shutdown — clean up all active worktrees. Called during server shutdown
   * to prevent worktree/branch leaks across restarts.
   */
  async shutdown(): Promise<void> {
    koryLog.info({ activeCount: this.worktrees.size }, 'WorkspaceManager shutting down');
    for (const taskId of this.worktrees.keys()) {
      try {
        await this.cleanup(taskId);
      } catch (err: unknown) {
        koryLog.warn(
          { taskId, err: err instanceof Error ? err.message : String(err) },
          'Failed to clean up worktree during shutdown',
        );
      }
    }
    // Prune stale refs as a final sweep
    try {
      await this.prune();
    } catch {
      // best-effort
    }
    koryLog.info('WorkspaceManager shutdown complete');
  }

  // ─── Private Helper Methods ───────────────────────────────────────────────

  private async isGitRepo(): Promise<boolean> {
    return (await this.git.execCombined(['rev-parse', '--is-inside-work-tree'])).success;
  }

  private sanitizeBranchName(name: string): string {
    // Convert to lowercase, replace spaces with hyphens, remove unsafe chars
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 50); // Keep it reasonable
  }

  private async ensureGitignoreEntry(): Promise<void> {
    if (this.gitignoreUpdated) return;

    const gitignorePath = join(this.repoRoot, '.gitignore');
    const entry = `${this.worktreeDir}/`;

    if (!existsSync(gitignorePath)) {
      await writeFile(gitignorePath, `${entry}\n`, 'utf-8');
      this.gitignoreUpdated = true;
      koryLog.info('Created .gitignore with worktree directory entry');
      return;
    }

    const content = await readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n');

    // Check if already ignored (handle various formats)
    const isIgnored = lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === entry ||
        trimmed === this.worktreeDir ||
        trimmed === `${this.worktreeDir}**` ||
        trimmed === `${this.worktreeDir}/**`
      );
    });

    if (!isIgnored) {
      await appendFile(gitignorePath, `\n# Koryphaios AI worktrees\n${entry}\n`, 'utf-8');
      this.gitignoreUpdated = true;
      koryLog.info('Added worktree directory to .gitignore');
    }
  }

  /**
   * Symlink the repo's installed node_modules into a fresh worktree (root + each workspace
   * package that has its own). node_modules is gitignored, so the links never show up in
   * `git status`/`git add` during reconcile. Best-effort: a failed link just means that
   * package's deps aren't resolvable in the worktree, which `bun test` will surface.
   */
  private async linkDependencies(worktreePath: string): Promise<void> {
    const linkOne = async (relDir: string): Promise<void> => {
      const src = join(this.repoRoot, relDir, 'node_modules');
      if (!existsSync(src)) return;
      const destParent = join(worktreePath, relDir);
      if (!existsSync(destParent)) return; // workspace dir not present in the worktree
      const dest = join(destParent, 'node_modules');
      if (existsSync(dest)) return; // already linked/installed
      try {
        await symlink(src, dest, 'dir');
      } catch (err) {
        koryLog.warn({ relDir, err: String(err) }, 'Failed to symlink node_modules into worktree');
      }
    };

    // Root deps, then each immediate subdirectory that ships its own node_modules
    // (bun workspaces keep per-package node_modules alongside the hoisted root one).
    await linkOne('.');
    try {
      for (const entry of await readdir(this.repoRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await linkOne(entry.name);
      }
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Best-effort directory enumeration failed; root link above is the important one',
      );
    }
  }

  private async copyEnvToWorktree(worktreePath: string): Promise<void> {
    const envFiles = ['.env', '.env.local', '.env.development'];

    for (const envFile of envFiles) {
      const sourcePath = join(this.repoRoot, envFile);
      const targetPath = join(worktreePath, envFile);

      if (existsSync(sourcePath)) {
        try {
          const content = await readFile(sourcePath, 'utf-8');
          await writeFile(targetPath, content, 'utf-8');
          koryLog.debug({ file: envFile }, 'Copied .env file to worktree');
        } catch (err) {
          koryLog.warn({ file: envFile, err }, 'Failed to copy .env file');
        }
      }
    }
  }

  private async getMainBranch(): Promise<string> {
    // Try common main branch names
    const candidates = ['main', 'master', 'trunk', 'develop'];

    for (const branch of candidates) {
      const result = await this.git.execCombined(['rev-parse', '--verify', branch]);
      if (result.success) return branch;
    }

    // Fallback to current branch
    const result = await this.git.execCombined(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.output.trim() || 'main';
  }

  // ─── Manifest Persistence ─────────────────────────────────────────────────

  private async loadManifest(): Promise<WorktreeManifest> {
    try {
      if (existsSync(this.manifestPath)) {
        const raw = await readFile(this.manifestPath, 'utf-8');
        return JSON.parse(raw) as WorktreeManifest;
      }
    } catch (err: unknown) {
      koryLog.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to load worktree manifest — starting fresh',
      );
    }
    return { worktrees: [] };
  }

  private async saveManifest(): Promise<void> {
    try {
      const dir = join(this.repoRoot, '.koryphaios');
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const manifest: WorktreeManifest = {
        worktrees: Array.from(this.worktrees.values()),
      };
      await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    } catch (err: unknown) {
      koryLog.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to persist worktree manifest',
      );
    }
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
