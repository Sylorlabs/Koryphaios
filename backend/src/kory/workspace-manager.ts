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
 * - Admission: 0 (the default) means no host-imposed limit. A positive
 *   worktreeLimit queues further spawns in FIFO order instead of failing
 * - Persistence: Worktree metadata survives crashes via .koryphaios/worktrees.json
 * - Lifecycle: shutdown() drains all active worktrees
 *
 * All git operations go through GitExecutor, which serializes them via gitMutex.
 * All filesystem operations use fs/promises — the event loop is never blocked.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, readdir, symlink, rename } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { koryLog, serverLog } from '../logger';
import { GitExecutor } from './git-executor';
import { canonicalizePath } from '../runtime/platform';
import type { KoryphaiosConfig } from '@koryphaios/shared';

/** Koryphaios' own per-project state directory. Excluded from Git because it
 *  holds the worktree manifest, snapshots, and credential material. */
const STATE_DIR_NAME = '.koryphaios';

export interface WorktreeInfo {
  id: string;
  taskName: string;
  branchName: string;
  path: string;
  createdAt: number;
  agentId?: string;
  /** Commit the worktree branched from — used to diff the worker's changes. */
  baseSha?: string;
  /** Branch that was checked out when the worktree was created. Reconcile
   *  targets this ref specifically instead of re-resolving "whatever is checked
   *  out now", so a user who switches branches mid-task cannot silently move
   *  worker output onto a different branch. */
  destinationBranch: string;
}

export interface WorktreeStatus {
  active: WorktreeInfo[];
  /** null when no host limit is configured (the default). */
  availableSlots: number | null;
  /** null when no host limit is configured (the default). */
  maxAllowed: number | null;
  /** Spawns waiting behind an explicitly configured worktreeLimit. */
  queued: number;
  /** Worktrees whose merge could not land. Their commits are preserved on
   *  `recoveryBranch`; nothing was written to the destination. */
  pendingResolutions: PendingResolution[];
}

/** A repo-relative path Git could not merge automatically. */
export interface WorktreeConflict {
  path: string;
}

export type ReconcileOutcome = 'merged' | 'conflict' | 'noop' | 'error';

export interface ReconcileResult {
  success: boolean;
  message: string;
  outcome: ReconcileOutcome;
  conflicts: WorktreeConflict[];
  /** Branch still holding the worker's commits when the merge could not land. */
  recoveryBranch?: string;
}

/** A worktree whose changes did not merge cleanly, or whose worker did not
 *  finish. The branch is retained and the working tree is left untouched. */
export interface PendingResolution {
  taskId: string;
  taskName: string;
  branchName: string;
  destinationBranch: string;
  conflicts: WorktreeConflict[];
  /** 'conflict' = the merge had unresolved content. 'incomplete' = the worker
   *  did not pass review, so the work is preserved but unverified. */
  reason: 'conflict' | 'incomplete';
  recordedAt: number;
}

interface WorktreeManifest {
  worktrees: WorktreeInfo[];
  resolutions?: PendingResolution[];
}

/** Outcome of an in-memory `git merge-tree` dry run. */
type MergePreflight =
  | { status: 'clean'; tree: string }
  | { status: 'conflict'; conflicts: WorktreeConflict[] }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

function reconcileError(message: string): ReconcileResult {
  return { success: false, outcome: 'error', conflicts: [], message };
}

/** A branch name is interpolated into `refs/heads/<name>` and passed to Git as
 *  an argument, so anything Git would read as an option, a traversal, or a
 *  revision expression must be rejected before it reaches a command line. */ function isSafeRefName(
  ref: string,
): boolean {
  if (!ref || ref.length > 255) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(ref)) return false;
  return true;
}

type WorkspaceGitOperation =
  | 'worktree-add'
  | 'stash-push'
  | 'checkout'
  | 'merge-squash'
  | 'merge'
  | 'merge-abort'
  | 'reset-hard'
  | 'merge-tree'
  | 'commit-tree'
  | 'update-ref'
  | 'stash-apply'
  | 'stash-drop'
  | 'worktree-remove'
  | 'worktree-prune'
  | 'branch-delete'
  | 'config-identity';

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

interface SlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function slotAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Worktree spawn was cancelled');
  error.name = 'AbortError';
  return error;
}

export class WorkspaceManager {
  private initialization?: Promise<void>;
  private closing = false;
  private operations: Promise<unknown> = Promise.resolve();

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => undefined);
    return pending;
  }

  private worktrees: Map<string, WorktreeInfo> = new Map();
  private resolutions: Map<string, PendingResolution> = new Map();
  private worktreeDir: string;
  private maxConcurrent: number;
  private copyEnvFiles: boolean;
  private skipHooks: boolean;
  private modifyGitignore: boolean;
  private repoRoot: string;
  private git: GitExecutor;
  private excludeUpdated = false;
  private manifestPath: string;
  /** Cached result of the `git merge-tree --write-tree` capability probe. */
  private mergeTreeSupport?: boolean;
  /** Slots reserved by admitted spawns that have not created their worktree yet. */
  private pendingSlots = 0;
  /** FIFO spawns waiting for a slot when the user configured a positive cap. */
  private slotWaiters: SlotWaiter[] = [];

  constructor(repoRoot: string, config?: KoryphaiosConfig['workspace']) {
    this.repoRoot = resolve(repoRoot);
    this.worktreeDir = config?.worktreeDir ?? '.trees';
    // 0 means unlimited; the hardware is the only ceiling unless the user sets one.
    this.maxConcurrent = config?.worktreeLimit ?? 0;
    this.copyEnvFiles = config?.copyEnvFiles ?? false;
    this.skipHooks = config?.skipHooks ?? true;
    this.modifyGitignore = config?.modifyGitignore ?? false;
    this.git = new GitExecutor(this.repoRoot);
    this.manifestPath = join(this.repoRoot, STATE_DIR_NAME, 'worktrees.json');
  }

  /**
   * Async initialization — must be called after construction before any other method.
   * Validates the git repo, ensures .gitignore, and recovers worktrees from persisted
   * metadata cross-referenced with `git worktree list`.
   */
  init(): Promise<void> {
    return (this.initialization ??= this.initialize());
  }

  private async initialize(): Promise<void> {
    const root = canonicalizePath(this.repoRoot);
    const base = resolve(root, this.worktreeDir);
    const rel = relative(root, base);
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      rel.split(sep)[0] === '.git'
    ) {
      throw new WorkspaceError('Worktree directory must be inside the project');
    }
    if (!(await this.isGitRepo())) {
      throw new WorkspaceError('Not a valid Git repository');
    }
    this.repoRoot = root;
    await mkdir(base, { recursive: true });
    if (canonicalizePath(base) !== base) {
      throw new WorkspaceError('Worktree directory must not redirect through a symlink');
    }
    await this.ensureWorktreeDirIgnored();
    await this.recover();

    koryLog.info(
      {
        worktreeDir: this.worktreeDir,
        maxConcurrent: this.maxConcurrent,
        copyEnvFiles: this.copyEnvFiles,
        skipHooks: this.skipHooks,
        modifyGitignore: this.modifyGitignore,
        recoveredCount: this.worktrees.size,
        pendingResolutions: this.resolutions.size,
        mergeTreePreflight: await this.supportsMergeTree(),
      },
      'WorkspaceManager initialized',
    );
  }

  /**
   * Recover existing worktrees from persisted metadata, cross-referenced with
   * `git worktree list`. Metadata is loaded from .koryphaios/worktrees.json so
   * recovery is lossless — taskName, createdAt, agentId, baseSha, and the pinned
   * destination branch are all preserved. Worktrees that git no longer lists
   * are pruned from the manifest. Orphan worktrees (in our directory but not in
   * the manifest) are cleaned up. Unmerged branches recorded as pending
   * resolutions are restored so a conflict survives a restart.
   */
  private async recover(): Promise<void> {
    const allWorktrees = await this.listAllWorktrees();
    const worktreeBaseDir = resolve(this.repoRoot, this.worktreeDir);
    const manifest = await this.loadManifest();
    const manifestById = new Map(manifest.worktrees.map((wt) => [wt.id, wt]));

    for (const resolution of manifest.resolutions ?? []) {
      if (!/^[a-zA-Z0-9_-]+$/.test(resolution.taskId) || !/^ai\/.+/.test(resolution.branchName)) {
        koryLog.warn(
          { taskId: resolution.taskId },
          'Discarding malformed pending resolution from the manifest',
        );
        continue;
      }
      this.resolutions.set(resolution.taskId, resolution);
    }

    for (const wt of allWorktrees) {
      // On Windows, `git worktree list --porcelain` may report paths using
      // 8.3 short names (e.g. RUNNER~1) while the WorkspaceManager was
      // A stale entry can survive a rename between the short (8.3) and long
      // spelling of the same directory, so compare kernel-canonical paths.
      let absoluteWtPath = resolve(wt.path);
      try {
        absoluteWtPath = canonicalizePath(absoluteWtPath);
      } catch {
        // realpath fails if the path doesn't exist (e.g. a stale
        // worktree entry). Keep the resolved path so the startsWith check
        // can still filter it out naturally.
      }
      let canonicalBaseDir = worktreeBaseDir;
      try {
        canonicalBaseDir = canonicalizePath(worktreeBaseDir);
      } catch {
        // worktreeBaseDir may not exist yet on first run; fall back to the
        // resolved path.
      }
      if (canonicalBaseDir !== worktreeBaseDir || absoluteWtPath === this.repoRoot) continue;

      const taskId = relative(canonicalBaseDir, absoluteWtPath);
      if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..'))
        continue;

      // Prefer persisted metadata; fall back to git-derived info for orphans
      const persisted = manifestById.get(taskId);
      if (persisted) {
        this.worktrees.set(taskId, {
          ...persisted,
          id: taskId,
          branchName: wt.branch ?? 'unknown',
          path: absoluteWtPath,
          // Manifests written before destinations were pinned have no value;
          // fall back to the current branch so reconcile still has a target.
          destinationBranch: persisted.destinationBranch ?? (await this.getCurrentBranch()) ?? '',
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
          destinationBranch: (await this.getCurrentBranch()) ?? '',
        });
      }
    }

    for (const taskId of this.worktrees.keys()) {
      try {
        await this.validateWorktree(taskId);
      } catch {
        this.worktrees.delete(taskId);
      }
    }

    // A worktree whose destination was lost to a pre-pinning manifest cannot be
    // reconciled safely (we would not know which ref to target). Retain its
    // branch as a resolution instead of guessing.
    for (const [taskId, worktree] of [...this.worktrees]) {
      if (worktree.destinationBranch) continue;
      this.resolutions.set(taskId, {
        taskId,
        taskName: worktree.taskName,
        branchName: worktree.branchName,
        destinationBranch: '',
        conflicts: [],
        reason: 'incomplete',
        recordedAt: Date.now(),
      });
      await this.releaseWorktree(taskId, { keepBranch: true }).catch(() => undefined);
    }

    // Persist the reconciled manifest (drops entries for worktrees git no longer has)
    await this.saveManifest();
  }

  /**
   * Get current worktree status including available slots
   */
  getStatus(): WorktreeStatus {
    const limit = this.maxConcurrent > 0 ? this.maxConcurrent : null;
    return {
      active: Array.from(this.worktrees.values()),
      availableSlots:
        limit === null ? null : Math.max(0, limit - this.worktrees.size - this.pendingSlots),
      maxAllowed: limit,
      queued: this.slotWaiters.length,
      pendingResolutions: this.listPendingResolutions(),
    };
  }

  /** Worktrees whose changes did not merge cleanly, oldest first. */
  listPendingResolutions(): PendingResolution[] {
    return [...this.resolutions.values()].sort((a, b) => a.recordedAt - b.recordedAt);
  }

  /**
   * Check if we can spawn a new worktree
   */
  canSpawn(): boolean {
    return !this.closing && this.worktrees.size + this.pendingSlots < this.slotLimit();
  }

  private slotLimit(): number {
    return this.maxConcurrent > 0 ? this.maxConcurrent : Number.POSITIVE_INFINITY;
  }

  private hasAvailableSlot(): boolean {
    return this.worktrees.size + this.pendingSlots < this.slotLimit();
  }

  /**
   * Reserve a spawn slot, waiting in FIFO order when an explicit cap is set.
   * A waiting spawn is queued work, not a failed task.
   */
  private waitForSlot(signal?: AbortSignal): Promise<void> {
    if (this.closing) {
      return Promise.reject(new WorkspaceError('WorkspaceManager is shutting down'));
    }
    if (this.hasAvailableSlot()) {
      this.pendingSlots++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, signal };
      const abort = (): void => {
        const index = this.slotWaiters.indexOf(waiter);
        if (index >= 0) this.slotWaiters.splice(index, 1);
        waiter.signal?.removeEventListener('abort', abort);
        reject(slotAbortError(signal));
      };
      waiter.onAbort = abort;
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.slotWaiters.push(waiter);
    });
  }

  private pumpSlotWaiters(): void {
    while (this.slotWaiters.length > 0 && this.hasAvailableSlot()) {
      const waiter = this.slotWaiters.shift()!;
      this.pendingSlots++;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve();
    }
  }

  private releaseSlotReservation(): void {
    if (this.pendingSlots > 0) this.pendingSlots--;
    this.pumpSlotWaiters();
  }

  /**
   * Create a new isolated worktree for a task
   * @param taskId Unique identifier for the task
   * @param taskName Human-readable task name (used for branch naming)
   * @param agentId Optional agent/session ID that owns this worktree
   * @returns WorktreeInfo on success, null if at capacity
   */
  async spawn(
    taskId: string,
    taskName: string,
    agentId?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorktreeInfo | null> {
    if (this.closing) throw new WorkspaceError('WorkspaceManager is shutting down');
    if (!this.initialization) throw new WorkspaceError('WorkspaceManager is not initialized');
    await this.initialization;
    // Reject a duplicate immediately instead of making it wait behind the queue.
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || this.worktrees.has(taskId)) {
      throw new WorkspaceError('Invalid or already active worktree task ID');
    }
    await this.waitForSlot(options.signal);
    try {
      if (options.signal?.aborted) throw slotAbortError(options.signal);
      return await this.exclusive(() => this.spawnWorktree(taskId, taskName, agentId));
    } finally {
      this.releaseSlotReservation();
    }
  }

  private async spawnWorktree(
    taskId: string,
    taskName: string,
    agentId?: string,
  ): Promise<WorktreeInfo | null> {
    if (this.closing) throw new WorkspaceError('WorkspaceManager is shutting down');
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || this.worktrees.has(taskId)) {
      throw new WorkspaceError('Invalid or already active worktree task ID');
    }
    const base = resolve(this.repoRoot, this.worktreeDir);
    if (canonicalizePath(base) !== base)
      throw new WorkspaceError('Worktree directory was redirected');
    // Sanitize task name for branch name — use the full taskId for uniqueness
    const sanitizedTaskName = this.sanitizeBranchName(taskName);
    const branchName = `ai/${sanitizedTaskName}-${taskId}`;
    const worktreePath = join(this.repoRoot, this.worktreeDir, taskId);

    // Pin the reconcile destination now, while the user's branch selection is
    // known. Reconcile later targets this exact ref, so switching branches
    // mid-task cannot redirect worker output somewhere unintended.
    const destinationBranch = (await this.getCurrentBranch()) ?? (await this.getMainBranch());

    // Create worktree directory if it doesn't exist
    const worktreeBaseDir = join(this.repoRoot, this.worktreeDir);
    if (!existsSync(worktreeBaseDir)) {
      await mkdir(worktreeBaseDir, { recursive: true });
    }

    // Record the base commit so we can later diff exactly what the worker changed.
    const baseResult = await this.git.execCombined(['rev-parse', 'HEAD']);
    if (!baseResult.success || !/^[0-9a-f]{40,64}$/.test(baseResult.output.trim())) {
      throw new WorkspaceError('Worktree baseline is unavailable');
    }
    const baseSha = baseResult.output.trim();

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

    const worktree: WorktreeInfo = {
      id: taskId,
      taskName,
      branchName,
      path: worktreePath,
      createdAt: Date.now(),
      agentId,
      baseSha,
      destinationBranch,
    };

    this.worktrees.set(taskId, worktree);
    try {
      await this.validateWorktree(taskId, agentId);
      // Handle .env file copying based on security policy
      if (this.copyEnvFiles) {
        await this.copyEnvToWorktree(worktreePath);
      }

      // Make dependencies resolvable in the worktree so the Critic's hard check (`bun test`)
      // can exercise the worker's actual diff. A fresh worktree has no node_modules (gitignored),
      // so symlink the repo's installed deps in — fast, zero-copy, and ignored by git.
      await this.linkDependencies(worktreePath);

      await this.saveManifest();
    } catch (error) {
      try {
        await this.cleanupWorktree(taskId);
      } catch {
        /* Retain tracked entry for recovery. */
      }
      throw error;
    }

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

  /** The branch the user currently has checked out in the main repo. */
  async getCurrentBranch(): Promise<string | null> {
    const result = await this.git.execCombined(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = result.output.trim();
    return result.success && branch && branch !== 'HEAD' ? branch : null;
  }

  /**
   * True when this Git build understands `merge-tree --write-tree` (2.38+),
   * which performs a real three-way merge entirely in memory. Cached after the
   * first probe. `merge-tree` has no side effects, so merging a commit with
   * itself is a safe capability check.
   */
  private async supportsMergeTree(): Promise<boolean> {
    if (this.mergeTreeSupport !== undefined) return this.mergeTreeSupport;
    // With no commit yet there is nothing to merge, so the probe cannot run.
    // Reconcile already refuses an unborn destination earlier; assume support
    // rather than recording a false negative that would needlessly downgrade
    // every later reconcile to the in-place path.
    const head = await this.git.exec(['rev-parse', '--verify', 'HEAD']);
    if (!head.success) {
      this.mergeTreeSupport = true;
      return true;
    }
    const tip = head.stdout.trim();
    const probe = await this.git.exec(['merge-tree', '--write-tree', '--name-only', tip, tip]);
    this.mergeTreeSupport = probe.success;
    if (!this.mergeTreeSupport) {
      koryLog.warn(
        'Git predates `merge-tree --write-tree`; reconcile falls back to guarded in-place merge',
      );
    }
    return this.mergeTreeSupport;
  }

  /**
   * Dry-run the merge without touching the index, working tree, or any ref.
   *
   * This is what makes a conflicting reconcile harmless: the conflict is
   * discovered *before* the user's checkout is modified, so there is no state
   * to roll back and no way to leave conflict markers behind.
   */
  private async preflightMerge(destinationTip: string, branch: string): Promise<MergePreflight> {
    if (!(await this.supportsMergeTree())) return { status: 'unsupported' };
    const result = await this.git.exec([
      'merge-tree',
      '--write-tree',
      '--name-only',
      destinationTip,
      branch,
    ]);
    // Layout: "<tree oid>\n<conflicted path>...\n\n<human-readable summary>".
    // Everything after the blank line is Git's console summary, not paths, so
    // the conflicted-path list must stop at the first empty line.
    const rawLines = result.stdout.split('\n');
    const summaryStart = rawLines.findIndex((line) => line.trim() === '');
    const pathLines = (summaryStart === -1 ? rawLines : rawLines.slice(0, summaryStart))
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    const tree = (rawLines[0] ?? '').trim();

    if (result.exitCode === 0) {
      if (!/^[0-9a-f]{40,64}$/.test(tree)) {
        return { status: 'error', message: 'Git merge preflight returned an unusable tree' };
      }
      return { status: 'clean', tree };
    }
    if (result.exitCode === 1) {
      const conflicts = pathLines.map((path) => ({ path }));
      koryLog.warn(
        { branch, conflictCount: conflicts.length },
        'Reconcile preflight found unresolved conflicts',
      );
      return {
        status: 'conflict',
        conflicts: conflicts.length > 0 ? conflicts : [{ path: '(unknown)' }],
      };
    }
    return { status: 'error', message: 'Git merge preflight could not be evaluated' };
  }

  /** Commit whatever the worker left uncommitted so its branch is a complete,
   *  self-contained record of the work. Returns false on failure. */
  private async commitPendingWorktreeChanges(
    worktree: WorktreeInfo,
    commitArgs: string[],
  ): Promise<boolean> {
    // Ignore node_modules in the change check — a symlinked node_modules isn't matched by
    // the dir-only gitignore pattern, so it would otherwise look like a pending change.
    const statusResult = await this.git.execCombined([
      '-C',
      worktree.path,
      'status',
      '--porcelain',
    ]);
    if (!statusResult.success) return false;
    const hasChanges = statusResult.output
      .split('\n')
      .some((line) => line.trim() && !line.includes('node_modules'));
    if (!hasChanges) return true;

    // Auto-commit any pending changes, explicitly excluding dependency dirs so the
    // symlinked node_modules never get committed onto the user's branch.
    const addResult = await this.git.execCombined([
      '-C',
      worktree.path,
      'add',
      '-A',
      '--',
      '.',
      ':(exclude)node_modules',
      ':(exclude)**/node_modules',
    ]);
    if (!addResult.success) return false;
    const commitResult = await this.git.execCombined([
      '-C',
      worktree.path,
      'commit',
      '-m',
      `[AI] Changes from ${worktree.taskName}`,
      ...commitArgs,
    ]);
    return commitResult.success;
  }

  /**
   * Reconcile a worktree's changes into the destination branch pinned at spawn.
   *
   * The merge is preflighted in memory first, so a conflict never modifies the
   * user's checkout. When the destination is not the checked-out branch the
   * merge is landed with plumbing (`commit-tree` + `update-ref`) and the working
   * tree is not touched at all. When it is, the working tree must be updated, so
   * the guarded in-place path runs with an unconditional abort on failure.
   */
  async reconcile(taskId: string, squash = true): Promise<ReconcileResult> {
    return this.exclusive(() => this.git.withLock(() => this.reconcileWorktree(taskId, squash)));
  }

  private async reconcileWorktree(taskId: string, squash: boolean): Promise<ReconcileResult> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return reconcileError(`Worktree ${taskId} not found`);
    }

    await this.validateWorktree(taskId);

    const commitArgs = this.skipHooks ? ['--no-verify'] : [];

    // The branch must be a complete record of the work before it is retained as
    // a recovery artifact or merged.
    if (!(await this.commitPendingWorktreeChanges(worktree, commitArgs))) {
      return reconcileError('Failed to commit changes in worktree');
    }

    const destination = worktree.destinationBranch;
    if (!destination) {
      return this.recordPendingResolution(worktree, [{ path: '(destination branch unknown)' }]);
    }

    const tipResult = await this.git.exec(['rev-parse', '--verify', `refs/heads/${destination}`]);
    if (!tipResult.success || !/^[0-9a-f]{40,64}$/.test(tipResult.stdout.trim())) {
      return reconcileError(
        `Reconcile destination branch '${destination}' no longer exists. Switch to it or reconcile manually.`,
      );
    }
    const destinationTip = tipResult.stdout.trim();

    // A branch with no commits beyond the destination has nothing to land.
    const ahead = await this.git.exec([
      'rev-list',
      '--count',
      `${destinationTip}..${worktree.branchName}`,
    ]);
    if (ahead.success && ahead.stdout.trim() === '0') {
      const cleanupResult = await this.cleanupWorktree(taskId);
      return {
        success: cleanupResult.success,
        outcome: 'noop',
        conflicts: [],
        message: cleanupResult.success
          ? 'Worker produced no changes; worktree cleaned up'
          : `Worker produced no changes; cleanup failed: ${cleanupResult.message}`,
      };
    }

    const preflight = await this.preflightMerge(destinationTip, worktree.branchName);
    if (preflight.status === 'conflict') {
      return this.recordPendingResolution(worktree, preflight.conflicts);
    }
    if (preflight.status === 'error') {
      return reconcileError(preflight.message);
    }

    return this.landMerge({
      worktree,
      destination,
      destinationTip,
      tree: preflight.status === 'clean' ? preflight.tree : null,
      squash,
      commitArgs,
    });
  }

  /**
   * Land a preflighted merge.
   *
   * `tree` is the in-memory merge result when preflight succeeded. When it is
   * null (older Git without `merge-tree`) the caller has no proof the merge is
   * clean, so the guarded in-place path is used and must abort on any failure.
   */
  private async landMerge(input: {
    worktree: WorktreeInfo;
    destination: string;
    destinationTip: string;
    tree: string | null;
    squash: boolean;
    commitArgs: string[];
  }): Promise<ReconcileResult> {
    const { worktree, destination, destinationTip, tree, squash, commitArgs } = input;
    const taskId = worktree.id;
    const message = `feat: ${worktree.taskName} [ai-${taskId}]`;

    const currentBranch = await this.getCurrentBranch();
    if (currentBranch === destination) {
      return this.mergeInPlace(worktree, destination, squash, commitArgs);
    }

    // The destination is not checked out here. Refuse if the user has it checked
    // out in another worktree: moving that ref would desync their working tree
    // the same way, and we must not silently modify a tree we cannot see.
    const foreign = await this.branchCheckedOutElsewhere(destination);
    if (foreign) {
      return reconcileError(
        `Reconcile destination branch '${destination}' is checked out in another worktree (${foreign}). Switch or reconcile manually.`,
      );
    }

    if (tree === null) {
      // Without a preflight result we cannot use plumbing safely — building a
      // tree we never verified would be a guess. Use the guarded in-place path.
      return this.mergeInPlace(worktree, destination, squash, commitArgs);
    }

    // The merge result is identical to the destination. Creating a commit here
    // would add an empty change, and `update-ref` would still move the ref.
    const destTree = await this.git.exec(['rev-parse', '--verify', `${destinationTip}^{tree}`]);
    if (destTree.success && destTree.stdout.trim() === tree) {
      const noopCleanup = await this.cleanupWorktree(taskId);
      return {
        success: noopCleanup.success,
        outcome: 'noop',
        conflicts: [],
        message: noopCleanup.success
          ? 'Destination already contains these changes'
          : `Destination already contains these changes; cleanup failed: ${noopCleanup.message}`,
      };
    }

    // Plumbing path: never touches the index, working tree, or HEAD, so the
    // user's uncommitted work needs no stash and cannot be disturbed.
    const identity = await this.resolveCommitIdentity();
    const commitResult = await this.git.exec(
      ['commit-tree', tree, '-p', destinationTip, '-m', message],
      { env: identity },
    );
    const newCommit = commitResult.stdout.trim();
    if (!commitResult.success || !/^[0-9a-f]{40,64}$/.test(newCommit)) {
      return reconcileError('Failed to create the reconcile commit');
    }

    // Compare-and-swap: if anything moved the destination since the preflight,
    // refuse rather than clobber it.
    const updateResult = await this.git.exec([
      'update-ref',
      `refs/heads/${destination}`,
      newCommit,
      destinationTip,
    ]);
    if (!updateResult.success) {
      koryLog.error(
        { taskId, ...workspaceGitLogMetadata('update-ref', updateResult) },
        'Reconcile ref update lost a compare-and-set race',
      );
      return reconcileError(
        `The '${destination}' branch changed while the worker's changes were being merged. Retry the merge.`,
      );
    }

    const cleanupResult = await this.cleanupWorktree(taskId);
    return {
      success: true,
      outcome: 'merged',
      conflicts: [],
      message: cleanupResult.success
        ? 'Changes reconciled and worktree cleaned up'
        : `Changes reconciled but cleanup failed: ${cleanupResult.message}`,
    };
  }

  /**
   * Merge into the branch the user currently has checked out.
   *
   * The working tree has to reflect the merge, so unlike the plumbing path this
   * one must stage and commit in place. Every failure path therefore unwinds:
   * `merge --abort` clears any in-progress merge and `reset --hard HEAD` drops
   * staged squash content. Both are safe here because the tree was provably
   * clean before the merge (uncommitted work was stashed first) and a squash
   * merge does not move HEAD until the commit succeeds.
   */
  private async mergeInPlace(
    worktree: WorktreeInfo,
    destination: string,
    squash: boolean,
    commitArgs: string[],
  ): Promise<ReconcileResult> {
    const taskId = worktree.id;
    const branch = worktree.branchName;

    const mainStatus = await this.git.execCombined(['status', '--porcelain']);
    if (!mainStatus.success) return reconcileError('Destination status is unavailable');
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
        return reconcileError(
          'Could not safely preserve main-repository changes before reconcile.',
        );
      }
    }

    const unwind = async (): Promise<void> => {
      const abort = await this.git.exec(['merge', '--abort']);
      if (!abort.success) {
        // No merge was in progress (e.g. the commit itself failed). `reset` is
        // still required to clear staged squash content.
        koryLog.debug(
          { taskId, ...workspaceGitLogMetadata('merge-abort', abort) },
          'No in-progress merge to abort',
        );
      }
      const reset = await this.git.exec(['reset', '--hard', 'HEAD']);
      if (!reset.success) {
        koryLog.error(
          {
            taskId,
            ...workspaceGitLogMetadata('reset-hard', reset),
            recovery: 'git status --short && git merge --abort',
          },
          'Failed to unwind the destination tree after a reconcile failure',
        );
      }
    };

    try {
      if (squash) {
        // Squash merge: Combine all worktree changes into one commit
        const mergeResult = await this.git.execCombined(['merge', '--squash', branch]);
        if (!mergeResult.success) {
          koryLog.error(
            { taskId, ...workspaceGitLogMetadata('merge-squash', mergeResult) },
            'Squash merge failed',
          );
          await unwind();
          return reconcileError(
            'Merge failed. Resolve the reported Git conflict or hook failure, then retry.',
          );
        }

        const commitResult = await this.git.execCombined([
          'commit',
          '-m',
          `feat: ${worktree.taskName} [ai-${taskId}]`,
          ...commitArgs,
        ]);
        if (!commitResult.success) {
          // `merge --squash` reports "Already up to date" and stages nothing when
          // the destination already contains the branch's content, so the commit
          // has nothing to record. That is a successful no-op, not a failure.
          if (await this.indexIsClean()) {
            return {
              success: true,
              outcome: 'noop',
              conflicts: [],
              message: 'Destination already contains these changes',
            };
          }
          await unwind();
          return reconcileError('Failed to commit squashed changes');
        }
      } else {
        // Regular merge: Preserve all commits from worktree
        const mergeResult = await this.git.execCombined([
          'merge',
          branch,
          '-m',
          `Merge ${branch} into ${destination}`,
        ]);
        if (!mergeResult.success) {
          koryLog.error(
            { taskId, ...workspaceGitLogMetadata('merge', mergeResult) },
            'Merge failed',
          );
          await unwind();
          return reconcileError(
            'Merge failed. Resolve the reported Git conflict or hook failure, then retry.',
          );
        }
      }
    } finally {
      // Restore the exact object Kory created. Never `stash pop` the mutable
      // stack head: another/pre-existing user stash must not be consumed.
      if (autoStashHash) await this.restoreAutoStash(taskId, autoStashHash);
    }

    const cleanupResult = await this.cleanupWorktree(taskId);
    return {
      success: true,
      outcome: 'merged',
      conflicts: [],
      message: cleanupResult.success
        ? 'Changes reconciled and worktree cleaned up'
        : `Changes reconciled but cleanup failed: ${cleanupResult.message}`,
    };
  }

  /**
   * Retain a conflicting worktree's work instead of corrupting the destination.
   *
   * The worker's commits are already on its branch, so the working copy is
   * released to reclaim the concurrency slot while the branch — the actual
   * work — is kept and recorded as a pending resolution.
   */
  private async recordPendingResolution(
    worktree: WorktreeInfo,
    conflicts: WorktreeConflict[],
    reason: PendingResolution['reason'] = 'conflict',
  ): Promise<ReconcileResult> {
    this.resolutions.set(worktree.id, {
      taskId: worktree.id,
      taskName: worktree.taskName,
      branchName: worktree.branchName,
      destinationBranch: worktree.destinationBranch,
      conflicts,
      reason,
      recordedAt: Date.now(),
    });
    try {
      await this.releaseWorktree(worktree.id, { keepBranch: true });
    } catch (err: unknown) {
      koryLog.warn(
        { taskId: worktree.id, err: String(err) },
        'Could not release a conflicted worktree; retained for recovery',
      );
    }
    await this.saveManifest();

    koryLog.warn(
      { taskId: worktree.id, branch: worktree.branchName, conflictCount: conflicts.length },
      'Worker changes conflicted; destination left untouched',
    );
    return {
      success: false,
      outcome: 'conflict',
      conflicts,
      recoveryBranch: worktree.branchName,
      message:
        (reason === 'conflict'
          ? worktree.destinationBranch
            ? `Changes conflicted with '${worktree.destinationBranch}' in ` +
              `${conflicts.length} file(s) and were not applied. Your checkout is unchanged. `
            : 'Changes could not be applied because the destination branch is unknown. ' +
              'Your checkout is unchanged. '
          : `The worker did not finish, so its changes were not applied. Your checkout is ` +
            `unchanged. `) + `The work is preserved on branch '${worktree.branchName}'.`,
    };
  }

  /**
   * Retry a previously conflicted merge now that the destination may have moved.
   * Re-runs the full preflight, so an unresolved conflict is still refused
   * without touching the working tree.
   */
  async applyResolution(taskId: string, squash = true): Promise<ReconcileResult> {
    return this.exclusive(() =>
      this.git.withLock(async () => {
        const resolution = this.resolutions.get(taskId);
        if (!resolution) return reconcileError(`No pending resolution for ${taskId}`);
        // Shutdown may retain a dirty checkout when its recovery commit failed.
        // Do not report a successful branch-only merge while ignoring those files.
        const retained = this.worktrees.get(taskId);
        if (retained) {
          if (
            resolution.branchName !== retained.branchName ||
            resolution.destinationBranch !== retained.destinationBranch
          ) {
            return reconcileError(
              'Recovery metadata does not match the retained checkout; nothing was removed.',
            );
          }
          await this.validateWorktree(taskId);
          if (!(await this.commitPendingWorktreeChanges(retained, ['--no-verify']))) {
            return reconcileError(
              'Recovery worktree is still present; its pending changes could not be committed. Nothing was removed.',
            );
          }
          const released = await this.releaseWorktree(taskId, { keepBranch: true });
          if (!released.success) return reconcileError(released.message);
        }

        // The manifest is local state a tampered process could edit, and both
        // names are interpolated into refspecs. Re-validate before use.
        if (
          !/^[a-zA-Z0-9_-]+$/.test(taskId) ||
          !isSafeRefName(resolution.branchName) ||
          !isSafeRefName(resolution.destinationBranch) ||
          !resolution.branchName.startsWith('ai/')
        ) {
          this.resolutions.delete(taskId);
          await this.saveManifest();
          return reconcileError(
            'The recorded resolution is malformed and was dropped; rebuild the branch manually.',
          );
        }

        const exists = await this.git.exec([
          'rev-parse',
          '--verify',
          `refs/heads/${resolution.branchName}`,
        ]);
        if (!exists.success) {
          this.resolutions.delete(taskId);
          await this.saveManifest();
          return reconcileError(
            `Branch '${resolution.branchName}' no longer exists; the pending resolution was dropped.`,
          );
        }

        const tipResult = await this.git.exec([
          'rev-parse',
          '--verify',
          `refs/heads/${resolution.destinationBranch}`,
        ]);
        if (!tipResult.success) {
          return reconcileError(
            `Destination branch '${resolution.destinationBranch}' no longer exists.`,
          );
        }
        const destinationTip = tipResult.stdout.trim();

        const preflight = await this.preflightMerge(destinationTip, resolution.branchName);
        if (preflight.status === 'conflict') {
          resolution.conflicts = preflight.conflicts;
          await this.saveManifest();
          return {
            success: false,
            outcome: 'conflict',
            conflicts: preflight.conflicts,
            recoveryBranch: resolution.branchName,
            message: `Branch '${resolution.branchName}' still conflicts with '${resolution.destinationBranch}'.`,
          };
        }
        if (preflight.status === 'error') return reconcileError(preflight.message);

        const synthetic: WorktreeInfo = {
          id: resolution.taskId,
          taskName: resolution.taskName,
          branchName: resolution.branchName,
          path: '',
          createdAt: resolution.recordedAt,
          destinationBranch: resolution.destinationBranch,
        };
        const result = await this.landMerge({
          worktree: synthetic,
          destination: resolution.destinationBranch,
          destinationTip,
          tree: preflight.status === 'clean' ? preflight.tree : null,
          squash,
          commitArgs: this.skipHooks ? ['--no-verify'] : [],
        });
        if (result.success) {
          this.resolutions.delete(taskId);
          await this.deleteBranch(resolution.branchName);
          await this.saveManifest();
        }
        return result;
      }),
    );
  }

  /**
   * Abandon a worktree whose worker did not finish, without merging anything.
   *
   * Uncommitted work is committed to the branch first so it is not lost with
   * the working copy, the directory is released to reclaim the slot, and the
   * branch is recorded as an `incomplete` resolution when it still carries work
   * the destination does not have. Branches with nothing to show are deleted.
   */
  async abandon(taskId: string): Promise<ReconcileResult> {
    return this.exclusive(() =>
      this.git.withLock(async () => {
        const worktree = this.worktrees.get(taskId);
        if (!worktree) return reconcileError(`Worktree ${taskId} not found`);
        await this.validateWorktree(taskId);

        if (!(await this.commitPendingWorktreeChanges(worktree, ['--no-verify']))) {
          koryLog.warn({ taskId }, 'Could not commit incomplete worker work; retaining worktree');
          return reconcileError('Failed to commit incomplete worker work; worktree retained');
        }

        const hasWork = await this.branchHasUnmergedWork(worktree);
        const result = await this.releaseWorktree(taskId, { keepBranch: hasWork });
        if (!result.success) return reconcileError(result.message);

        if (!hasWork) {
          return {
            success: true,
            outcome: 'noop',
            conflicts: [],
            message: 'Worker produced no changes; worktree discarded',
          };
        }

        this.resolutions.set(taskId, {
          taskId,
          taskName: worktree.taskName,
          branchName: worktree.branchName,
          destinationBranch: worktree.destinationBranch,
          conflicts: [],
          reason: 'incomplete',
          recordedAt: Date.now(),
        });
        await this.saveManifest();
        koryLog.info(
          { taskId, branch: worktree.branchName },
          'Incomplete worker work preserved on its branch',
        );
        return {
          success: true,
          outcome: 'noop',
          conflicts: [],
          recoveryBranch: worktree.branchName,
          message: `Incomplete worker work preserved on branch '${worktree.branchName}'.`,
        };
      }),
    );
  }

  /** Drop a pending resolution and delete the branch holding its work. */
  async discardResolution(taskId: string): Promise<{ success: boolean; message: string }> {
    return this.exclusive(async () => {
      const resolution = this.resolutions.get(taskId);
      if (!resolution) return { success: false, message: `No pending resolution for ${taskId}` };
      this.resolutions.delete(taskId);
      const deleted = await this.deleteBranch(resolution.branchName);
      await this.saveManifest();
      return deleted.success
        ? { success: true, message: `Discarded ${resolution.branchName}` }
        : { success: false, message: deleted.message };
    });
  }

  /** True when nothing is staged in the destination index. */
  private async indexIsClean(): Promise<boolean> {
    const staged = await this.git.execCombined(['diff', '--cached', '--name-only']);
    return staged.success && staged.output.trim() === '';
  }

  /** Resolve the commit identity for plumbing-created commits, falling back to a
   *  Koryphaios identity so `commit-tree` cannot fail on an unconfigured repo. */
  private async resolveCommitIdentity(): Promise<Record<string, string>> {
    const name = await this.git.exec(['config', '--get', 'user.name']);
    const email = await this.git.exec(['config', '--get', 'user.email']);
    const authorName = name.success && name.stdout.trim() ? name.stdout.trim() : 'Koryphaios';
    const authorEmail =
      email.success && email.stdout.trim() ? email.stdout.trim() : 'agent@koryphaios.invalid';
    koryLog.debug(
      { ...workspaceGitLogMetadata('config-identity', { success: true, output: '' }) },
      'Resolved reconcile commit identity',
    );
    return {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };
  }

  /** Path of another worktree that has `branch` checked out, if any. */
  private async branchCheckedOutElsewhere(branch: string): Promise<string | null> {
    for (const wt of await this.listAllWorktrees()) {
      if (wt.branch !== branch) continue;
      if (canonicalizePath(wt.path) === this.repoRoot) continue;
      return wt.path;
    }
    return null;
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
    return this.exclusive(() => this.cleanupWorktree(taskId));
  }

  private async cleanupWorktree(taskId: string): Promise<{ success: boolean; message: string }> {
    // A pending resolution has already released its worktree, so there is
    // nothing left to remove. Treat it as done rather than as a failure.
    if (!this.worktrees.has(taskId)) {
      return { success: true, message: 'Worktree already released' };
    }
    return this.releaseWorktree(taskId, { keepBranch: false });
  }

  /**
   * Remove a worktree's working copy and, unless the caller is retaining the
   * work, its branch. Releasing the directory reclaims a concurrency slot;
   * keeping the branch preserves every commit the worker produced.
   */
  private async releaseWorktree(
    taskId: string,
    { keepBranch }: { keepBranch: boolean },
  ): Promise<{ success: boolean; message: string }> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree) {
      return { success: false, message: `Worktree ${taskId} not found` };
    }

    await this.validateWorktree(taskId);

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

    if (keepBranch) {
      koryLog.info({ taskId, branch: worktree.branchName }, 'Worktree released; branch retained');
    } else {
      const deleted = await this.deleteBranch(worktree.branchName);
      if (!deleted.success) return deleted;
    }

    // Remove from tracking
    this.worktrees.delete(taskId);
    this.pumpSlotWaiters();
    await this.saveManifest();

    koryLog.info({ taskId, branch: worktree.branchName }, 'Worktree cleaned up');

    return {
      success: true,
      message: keepBranch ? 'Worktree removed' : 'Worktree and branch removed',
    };
  }

  private async deleteBranch(branch: string): Promise<{ success: boolean; message: string }> {
    const result = await this.git.execCombined(['branch', '-D', branch]);
    if (result.success) return { success: true, message: `Branch ${branch} removed` };
    // A branch that is already gone is the desired end state.
    const verify = await this.git.exec(['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!verify.success) return { success: true, message: `Branch ${branch} already absent` };
    koryLog.error(
      { branch, ...workspaceGitLogMetadata('branch-delete', result) },
      'Failed to delete branch',
    );
    return { success: false, message: `Failed to delete branch ${branch}. Delete it manually.` };
  }

  /** Revalidate live Git identity; missing .git must never make Git use a parent repository. */
  async validateWorktree(taskId: string, agentId?: string): Promise<string> {
    const worktree = this.worktrees.get(taskId);
    if (!worktree || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      throw new WorkspaceError('Worker has no managed worktree');
    }
    const base = resolve(this.repoRoot, this.worktreeDir);
    const expected = resolve(base, taskId);
    const path = canonicalizePath(worktree.path);
    if (
      canonicalizePath(base) !== base ||
      path !== expected ||
      path === this.repoRoot ||
      (agentId !== undefined && worktree.agentId !== agentId)
    ) {
      throw new WorkspaceError('Worktree path or session ownership is unsafe');
    }
    const top = await this.git.exec(['-C', path, 'rev-parse', '--show-toplevel']);
    const common = await this.git.exec(['-C', path, 'rev-parse', '--git-common-dir']);
    const projectCommon = await this.git.exec(['rev-parse', '--git-common-dir']);
    const branch = await this.git.exec(['-C', path, 'symbolic-ref', '--short', 'HEAD']);
    if (
      !top.success ||
      canonicalizePath(top.stdout.trim()) !== path ||
      !common.success ||
      !projectCommon.success ||
      canonicalizePath(resolve(path, common.stdout.trim())) !==
        canonicalizePath(resolve(this.repoRoot, projectCommon.stdout.trim())) ||
      !branch.success ||
      branch.stdout.trim() !== worktree.branchName ||
      !worktree.branchName.startsWith('ai/') ||
      !worktree.branchName.endsWith(`-${taskId}`) ||
      (worktree.baseSha !== undefined && !/^[0-9a-f]{40,64}$/.test(worktree.baseSha)) ||
      !isSafeRefName(worktree.destinationBranch)
    ) {
      throw new WorkspaceError('Worktree Git identity is unsafe or unavailable');
    }
    return path;
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
    await this.validateWorktree(taskId);
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
   * Shutdown — release all active worktrees. Called during server shutdown.
   *
   * Un-reconciled work is never destroyed: pending changes are committed to the
   * worktree's branch and the branch is retained, so a restart (or a crash)
   * leaves the work recoverable instead of silently discarded.
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    // Wake queued spawns so they fail closed instead of hanging shutdown.
    const queued = this.slotWaiters.splice(0);
    for (const waiter of queued) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new WorkspaceError('WorkspaceManager is shutting down'));
    }
    await this.initialization?.catch(() => undefined);
    return this.exclusive(() => this.drainWorktrees());
  }

  private async drainWorktrees(): Promise<void> {
    koryLog.info({ activeCount: this.worktrees.size }, 'WorkspaceManager shutting down');
    for (const [taskId, worktree] of [...this.worktrees]) {
      try {
        if (!(await this.commitPendingWorktreeChanges(worktree, ['--no-verify']))) {
          // Never remove a worktree whose changes were not committed. The
          // branch alone cannot preserve uncommitted files, so leave both the
          // checkout and its manifest entry in place for recovery on restart.
          this.resolutions.set(taskId, {
            taskId,
            taskName: worktree.taskName,
            branchName: worktree.branchName,
            destinationBranch: worktree.destinationBranch,
            conflicts: [],
            reason: 'incomplete',
            recordedAt: Date.now(),
          });
          koryLog.warn(
            { taskId, path: worktree.path },
            'Could not commit pending worktree changes before shutdown; worktree retained for recovery',
          );
          continue;
        }
        const result = await this.releaseWorktree(taskId, { keepBranch: true });
        if (!result.success) {
          koryLog.warn({ taskId, msg: result.message }, 'Worktree retained for recovery');
          continue;
        }
        if (await this.branchHasUnmergedWork(worktree)) {
          this.resolutions.set(taskId, {
            taskId,
            taskName: worktree.taskName,
            branchName: worktree.branchName,
            destinationBranch: worktree.destinationBranch,
            conflicts: [],
            reason: 'incomplete',
            recordedAt: Date.now(),
          });
          koryLog.info(
            { taskId, branch: worktree.branchName },
            'Shutdown preserved unmerged worker work as a pending resolution',
          );
        } else {
          await this.deleteBranch(worktree.branchName);
        }
      } catch (err: unknown) {
        koryLog.warn(
          { taskId, err: err instanceof Error ? err.message : String(err) },
          'Failed to release worktree during shutdown',
        );
      }
    }
    await this.saveManifest();
    // Prune stale refs as a final sweep
    try {
      await this.prune();
    } catch {
      // best-effort
    }
    koryLog.info({ preserved: this.resolutions.size }, 'WorkspaceManager shutdown complete');
  }

  /**
   * Delete `ai/*` branches that hold nothing: either fully merged into every
   * plausible destination or pointing at a commit that no longer exists.
   * Branches that still carry unmerged work are always kept.
   */
  async reapMergedBranches(): Promise<{ success: boolean; message: string }> {
    return this.exclusive(() =>
      this.git.withLock(async () => {
        const listed = await this.git.exec([
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads/ai/',
        ]);
        if (!listed.success) {
          return { success: false, message: 'Could not enumerate Koryphaios branches' };
        }
        const protectedBranches = new Set([
          ...this.resolutions.values().map((r) => r.branchName),
          ...this.worktrees.values().map((w) => w.branchName),
        ]);
        const candidates = [...this.worktrees.values()].map((w) => w.destinationBranch);
        let removed = 0;
        for (const branch of listed.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)) {
          if (protectedBranches.has(branch)) continue;
          if (
            await this.branchHasUnmergedWork(
              { branchName: branch, destinationBranch: '' },
              candidates,
            )
          ) {
            continue;
          }
          const deleted = await this.deleteBranch(branch);
          if (deleted.success) removed += 1;
        }
        return { success: true, message: `Removed ${removed} fully merged Koryphaios branch(es)` };
      }),
    );
  }

  /** True when `branch` has commits not reachable from its destination (or from
   *  any candidate destination, when supplied). */
  private async branchHasUnmergedWork(
    branch: Pick<WorktreeInfo, 'branchName' | 'destinationBranch'>,
    extraCandidates: string[] = [],
  ): Promise<boolean> {
    const targets = [branch.destinationBranch, ...extraCandidates].filter(isSafeRefName);
    const aheadAgainst = async (target: string): Promise<boolean> => {
      const result = await this.git.exec([
        'rev-list',
        '--count',
        `${target}..${branch.branchName}`,
      ]);
      return result.success && result.stdout.trim() !== '0';
    };
    for (const target of targets) {
      if (await aheadAgainst(target)) return true;
    }
    if (targets.length === 0) {
      // No known destination: only reap branches already contained in HEAD.
      const contained = await this.git.exec([
        'branch',
        '--contains',
        branch.branchName,
        '--format=%(refname:short)',
      ]);
      const names = new Set(contained.stdout.split('\n').map((l) => l.trim()));
      return !names.has(branch.branchName);
    }
    return false;
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

  /**
   * Keep the worktree directory out of the repository's tracked view.
   *
   * By default this writes to `.git/info/exclude`, which is local to the clone
   * and never appears in a commit — Koryphaios does not silently edit a tracked
   * `.gitignore` on the user's behalf. `workspace.modifyGitignore` opts into the
   * tracked-file behaviour for users who want the entry shared with teammates.
   */
  private async ensureWorktreeDirIgnored(): Promise<void> {
    if (this.excludeUpdated) return;

    // `.koryphaios/` holds Koryphaios' own state (worktree manifest, snapshots,
    // credentials). Leaving it visible pollutes the user's `git status` and lets
    // a `git add -A` commit credential material, so it is excluded as well.
    const entries = [`${this.worktreeDir}/`, `${STATE_DIR_NAME}/`];
    if (this.modifyGitignore) {
      for (const entry of entries) {
        await this.appendIgnoreEntry(join(this.repoRoot, '.gitignore'), entry, true);
      }
    } else {
      // Resolve through --git-common-dir so a linked worktree's own .git file
      // never becomes the exclude target.
      const common = await this.git.exec(['rev-parse', '--git-common-dir']);
      if (!common.success) {
        koryLog.warn('Could not resolve the common Git directory; worktree dir not excluded');
        return;
      }
      const infoDir = join(resolve(this.repoRoot, common.stdout.trim()), 'info');
      await mkdir(infoDir, { recursive: true });
      for (const entry of entries) {
        await this.appendIgnoreEntry(join(infoDir, 'exclude'), entry, false);
      }
    }
    this.excludeUpdated = true;
  }

  private async appendIgnoreEntry(path: string, entry: string, tracked: boolean): Promise<void> {
    let content = '';
    if (existsSync(path)) {
      try {
        content = await readFile(path, 'utf-8');
      } catch (err: unknown) {
        koryLog.warn({ err: String(err) }, 'Could not read ignore file; leaving it untouched');
        return;
      }
    }
    const dir = this.worktreeDir;
    const isIgnored = content.split('\n').some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === entry || trimmed === dir || trimmed === `${dir}**` || trimmed === `${dir}/**`
      );
    });
    if (isIgnored) return;
    if (tracked) {
      await appendFile(path, `\n# Koryphaios AI worktrees\n${entry}\n`, 'utf-8');
      koryLog.info('Added worktree directory to .gitignore');
    } else {
      const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
      await appendFile(path, `${prefix}# Koryphaios AI worktrees\n${entry}\n`, 'utf-8');
      koryLog.info('Added worktree directory to .git/info/exclude');
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
      // Do not silently discard ownership data. A corrupt manifest degrades
      // every entry to an orphan — losing baseSha and agentId — so keep the
      // damaged file for inspection and start from a known-empty state.
      const quarantined = `${this.manifestPath}.corrupt`;
      try {
        await rename(this.manifestPath, quarantined);
        koryLog.error(
          { quarantined, err: err instanceof Error ? err.message : String(err) },
          'Worktree manifest was unreadable; moved aside. Worktree ownership must be re-established manually.',
        );
      } catch {
        koryLog.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Worktree manifest was unreadable and could not be moved aside',
        );
      }
    }
    return { worktrees: [] };
  }

  /**
   * Persist the manifest atomically. A torn write would drop `baseSha` and
   * `agentId`, weakening the ownership checks that `validateWorktree` relies on.
   */
  private async saveManifest(): Promise<void> {
    try {
      const dir = join(this.repoRoot, STATE_DIR_NAME);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const manifest: WorktreeManifest = {
        worktrees: Array.from(this.worktrees.values()),
        resolutions: this.listPendingResolutions(),
      };
      const tmpPath = `${this.manifestPath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
      await rename(tmpPath, this.manifestPath);
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
