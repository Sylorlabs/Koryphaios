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
 */

import { spawnSync } from 'bun';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { koryLog, serverLog } from '../logger';
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

export class WorkspaceManager {
  private worktrees: Map<string, WorktreeInfo> = new Map();
  private worktreeDir: string;
  private maxConcurrent: number;
  private copyEnvFiles: boolean;
  private repoRoot: string;
  private gitignoreUpdated = false;
  /** Explicit branch to reconcile worker changes into. null = use the branch the user
   *  currently has checked out (i.e. "whatever branch was selected on the user's system"). */
  private targetBranch: string | null = null;

  constructor(repoRoot: string, config?: KoryphaiosConfig['workspace']) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeDir = config?.worktreeDir ?? '.trees';
    this.maxConcurrent = config?.worktreeLimit ?? 4;
    this.copyEnvFiles = config?.copyEnvFiles ?? false;

    // Validate we're in a git repo
    if (!this.isGitRepo()) {
      throw new WorkspaceError('Not a valid Git repository');
    }

    // Ensure .trees/ is in .gitignore
    this.ensureGitignoreEntry();

    // Recover existing worktrees from disk
    this.recover();

    koryLog.info(
      {
        worktreeDir: this.worktreeDir,
        maxConcurrent: this.maxConcurrent,
        copyEnvFiles: this.copyEnvFiles,
        recoveredCount: this.worktrees.size,
      },
      'WorkspaceManager initialized',
    );
  }

  /**
   * Recover existing worktrees from disk on startup
   */
  private recover(): void {
    const allWorktrees = this.listAllWorktrees();
    const worktreeBaseDir = resolve(this.repoRoot, this.worktreeDir);

    for (const wt of allWorktrees) {
      // Check if this worktree is inside our managed directory
      const absoluteWtPath = resolve(wt.path);
      if (absoluteWtPath.startsWith(worktreeBaseDir)) {
        const taskId = relative(worktreeBaseDir, absoluteWtPath);

        // Simple validation of taskId (should be what we used in spawn).
        // Reject path separators on both Unix (/) and Windows (\).
        if (taskId && !taskId.includes('/') && !taskId.includes('\\') && !taskId.includes('..')) {
          this.worktrees.set(taskId, {
            id: taskId,
            taskName: 'Recovered Task', // We don't know the original name without a DB
            branchName: wt.branch || 'unknown',
            path: absoluteWtPath,
            createdAt: Date.now(), // Estimate
          });
        }
      }
    }
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
   * @param agentId Optional agent ID that owns this worktree
   * @returns WorktreeInfo on success, null if at capacity
   */
  spawn(taskId: string, taskName: string, agentId?: string): WorktreeInfo | null {
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

    // Sanitize task name for branch name
    const sanitizedTaskName = this.sanitizeBranchName(taskName);
    const branchName = `ai/${sanitizedTaskName}-${taskId.slice(0, 8)}`;
    const worktreePath = join(this.repoRoot, this.worktreeDir, taskId);

    // Create worktree directory if it doesn't exist
    const worktreeBaseDir = join(this.repoRoot, this.worktreeDir);
    if (!existsSync(worktreeBaseDir)) {
      mkdirSync(worktreeBaseDir, { recursive: true });
    }

    // Record the base commit so we can later diff exactly what the worker changed.
    const baseSha = this.runGit(['rev-parse', 'HEAD']).output.trim() || undefined;

    // Create the worktree with a new branch
    const result = this.runGit(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    if (!result.success) {
      koryLog.error({ taskId, output: result.output }, 'Failed to create worktree');
      return null;
    }

    // Handle .env file copying based on security policy
    if (this.copyEnvFiles) {
      this.copyEnvToWorktree(worktreePath);
    }

    // Make dependencies resolvable in the worktree so the Critic's hard check (`bun test`)
    // can exercise the worker's actual diff. A fresh worktree has no node_modules (gitignored),
    // so symlink the repo's installed deps in — fast, zero-copy, and ignored by git.
    this.linkDependencies(worktreePath);

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
  getCurrentBranch(): string | null {
    const result = this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
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
  reconcile(taskId: string, squash = true): { success: boolean; message: string } {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    // Check for uncommitted changes in the worktree
    // Ignore node_modules in the change check — a symlinked node_modules isn't matched by
    // the dir-only gitignore pattern, so it would otherwise look like a pending change.
    const hasChanges = this.runGit(['-C', worktree.path, 'status', '--porcelain']).output
      .split('\n')
      .some((line) => line.trim() && !line.includes('node_modules'));

    if (hasChanges) {
      // Auto-commit any pending changes, explicitly excluding dependency dirs so the
      // symlinked node_modules never get committed onto the user's branch.
      this.runGit([
        '-C',
        worktree.path,
        'add',
        '-A',
        '--',
        '.',
        ':(exclude)node_modules',
        ':(exclude)**/node_modules',
      ]);
      const commitResult = this.runGit([
        '-C',
        worktree.path,
        'commit',
        '-m',
        `[AI] Changes from ${worktree.taskName}`,
        '--no-verify',
      ]);

      if (!commitResult.success) {
        return { success: false, message: 'Failed to commit changes in worktree' };
      }
    }

    // Return to the selected branch and merge the worktree branch into it.
    const mainBranch = this.targetBranch ?? this.getCurrentBranch() ?? this.getMainBranch();

    // Check if main repository has uncommitted changes that might block checkout
    const mainHasChanges = this.runGit(['status', '--porcelain']).output.trim() !== '';
    let stashed = false;

    if (mainHasChanges) {
      koryLog.info('Stashing changes in main repo before reconcile');
      this.runGit(['stash', 'push', '-m', `[KORY] Auto-stash for reconcile ${taskId}`]);
      stashed = true;
    }

    try {
      // Checkout main
      const checkoutResult = this.runGit(['checkout', mainBranch]);
      if (!checkoutResult.success) {
        return {
          success: false,
          message: `Failed to checkout ${mainBranch}: ${checkoutResult.output}`,
        };
      }

      if (squash) {
        // Squash merge: Combine all worktree changes into one commit
        const mergeResult = this.runGit(['merge', '--squash', worktree.branchName]);

        if (!mergeResult.success) {
          koryLog.error({ taskId, output: mergeResult.output }, 'Squash merge failed');
          return { success: false, message: 'Merge failed (conflicts?): ' + mergeResult.output };
        }

        // Commit the squashed changes
        const commitResult = this.runGit([
          'commit',
          '-m',
          `feat: ${worktree.taskName} [ai-${taskId.slice(0, 8)}]`,
          '--no-verify',
        ]);

        if (!commitResult.success) {
          return { success: false, message: 'Failed to commit squashed changes' };
        }
      } else {
        // Regular merge: Preserve all commits from worktree
        const mergeResult = this.runGit([
          'merge',
          worktree.branchName,
          '-m',
          `Merge ${worktree.branchName} into ${mainBranch}`,
        ]);

        if (!mergeResult.success) {
          koryLog.error({ taskId, output: mergeResult.output }, 'Merge failed');
          return { success: false, message: 'Merge failed: ' + mergeResult.output };
        }
      }

      // Cleanup: Remove worktree and branch
      const cleanupResult = this.cleanup(taskId);

      return {
        success: true,
        message: cleanupResult.success
          ? `Changes reconciled and worktree cleaned up`
          : `Changes reconciled but cleanup failed: ${cleanupResult.message}`,
      };
    } finally {
      // Always try to restore stashed changes
      if (stashed) {
        this.runGit(['stash', 'pop']);
      }
    }
  }

  /**
   * Clean up a worktree and its branch without merging
   * @param taskId The task/worktree ID to clean up
   * @returns Success status
   */
  cleanup(taskId: string): { success: boolean; message: string } {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    // Remove the worktree
    const removeResult = this.runGit(['worktree', 'remove', '--force', worktree.path]);
    if (!removeResult.success) {
      koryLog.error({ taskId, output: removeResult.output }, 'Failed to remove worktree');
      return { success: false, message: 'Failed to remove worktree: ' + removeResult.output };
    }

    // Delete the branch
    this.runGit(['branch', '-D', worktree.branchName]);

    // Remove from tracking
    this.worktrees.delete(taskId);

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
  getChangedFiles(taskId: string): string[] {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) return [];
    const base = worktree.baseSha ?? 'HEAD';
    const files = new Set<string>();
    // Tracked changes (committed or working-tree) since the base commit.
    const tracked = this.runGit(['-C', worktree.path, 'diff', '--name-only', base]);
    if (tracked.success) {
      for (const line of tracked.output.split('\n')) {
        const f = line.trim();
        if (f) files.add(f);
      }
    }
    // New untracked files (respecting .gitignore, so node_modules symlinks are skipped).
    const untracked = this.runGit([
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
  listAllWorktrees(): Array<{ path: string; branch?: string; detached: boolean }> {
    const result = this.runGit(['worktree', 'list', '--porcelain']);
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
  prune(): { success: boolean; message: string } {
    const result = this.runGit(['worktree', 'prune']);
    if (result.success) {
      return { success: true, message: 'Stale worktree references pruned' };
    }
    return { success: false, message: 'Prune failed: ' + result.output };
  }

  // ─── Private Helper Methods ───────────────────────────────────────────────

  private isGitRepo(): boolean {
    return this.runGit(['rev-parse', '--is-inside-work-tree']).success;
  }

  private runGit(args: string[]): { success: boolean; output: string } {
    const proc = spawnSync(['git', ...args], {
      cwd: this.repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = proc.stdout.toString() + proc.stderr.toString();
    return { success: proc.exitCode === 0, output };
  }

  private sanitizeBranchName(name: string): string {
    // Convert to lowercase, replace spaces with hyphens, remove unsafe chars
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 50); // Keep it reasonable
  }

  private ensureGitignoreEntry(): void {
    if (this.gitignoreUpdated) return;

    const gitignorePath = join(this.repoRoot, '.gitignore');
    const entry = `${this.worktreeDir}/`;

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${entry}\n`, 'utf-8');
      this.gitignoreUpdated = true;
      koryLog.info('Created .gitignore with worktree directory entry');
      return;
    }

    const content = readFileSync(gitignorePath, 'utf-8');
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
      appendFileSync(gitignorePath, `\n# Koryphaios AI worktrees\n${entry}\n`, 'utf-8');
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
  private linkDependencies(worktreePath: string): void {
    const linkOne = (relDir: string): void => {
      const src = join(this.repoRoot, relDir, 'node_modules');
      if (!existsSync(src)) return;
      const destParent = join(worktreePath, relDir);
      if (!existsSync(destParent)) return; // workspace dir not present in the worktree
      const dest = join(destParent, 'node_modules');
      if (existsSync(dest)) return; // already linked/installed
      try {
        symlinkSync(src, dest, 'dir');
      } catch (err) {
        koryLog.warn({ relDir, err: String(err) }, 'Failed to symlink node_modules into worktree');
      }
    };

    // Root deps, then each immediate subdirectory that ships its own node_modules
    // (bun workspaces keep per-package node_modules alongside the hoisted root one).
    linkOne('.');
    try {
      for (const entry of readdirSync(this.repoRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        linkOne(entry.name);
      }
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Best-effort directory enumeration failed; root link above is the important one');
    }
  }

  private copyEnvToWorktree(worktreePath: string): void {
    const envFiles = ['.env', '.env.local', '.env.development'];

    for (const envFile of envFiles) {
      const sourcePath = join(this.repoRoot, envFile);
      const targetPath = join(worktreePath, envFile);

      if (existsSync(sourcePath)) {
        try {
          const content = readFileSync(sourcePath, 'utf-8');
          writeFileSync(targetPath, content, 'utf-8');
          koryLog.debug({ file: envFile }, 'Copied .env file to worktree');
        } catch (err) {
          koryLog.warn({ file: envFile, err }, 'Failed to copy .env file');
        }
      }
    }
  }

  private getMainBranch(): string {
    // Try common main branch names
    const candidates = ['main', 'master', 'trunk', 'develop'];

    for (const branch of candidates) {
      const result = this.runGit(['rev-parse', '--verify', branch]);
      if (result.success) return branch;
    }

    // Fallback to current branch
    const result = this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.output.trim() || 'main';
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
