import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { WorkspaceManager } from '../workspace-manager';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const result = spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function gitFails(root: string, ...args: string[]): boolean {
  return spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0;
}

function repo(file = 'shared.txt', content = 'line one\nline two\nline three\n'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-wm-conflict-')));
  roots.push(root);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Conflict Test');
  git(root, 'config', 'user.email', 'conflict@test.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, file), content);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A worker rewrites the same line another worker also rewrote, differently. */
function writeConflictingEdit(worktreePath: string): void {
  const file = join(worktreePath, 'shared.txt');
  const current = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    current.replace('line two', `rewritten by ${worktreePath.slice(-4)}\nreplacement`),
  );
}

describe('WorkspaceManager same-file conflict handling', () => {
  test('a same-file conflict leaves the checkout untouched and preserves the work on a branch', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();

    const first = await manager.spawn('first', 'First task');
    const second = await manager.spawn('second', 'Second task');
    writeConflictingEdit(first!.path);
    writeConflictingEdit(second!.path);

    // The first worker lands normally.
    expect((await manager.reconcile('first')).outcome).toBe('merged');

    // The second conflicts. This is the case that used to leave conflict
    // markers in the user's working tree and strand their uncommitted work.
    const result = await manager.reconcile('second');
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('conflict');
    expect(result.conflicts.map((c) => c.path)).toContain('shared.txt');
    expect(result.recoveryBranch).toBe('ai/second-task-second');

    // The destination is clean: no conflict markers, no half-applied merge.
    // The FIRST worker's change is legitimately present; the second's is not.
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    const destination = readFileSync(join(root, 'shared.txt'), 'utf8');
    expect(destination).not.toContain('<<<<<<<');
    expect(destination).not.toContain('>>>>>>>');
    expect(destination).toContain('rewritten by irst');
    expect(destination).toContain('line three');

    // The conflicting work is preserved, not destroyed.
    const branch = result.recoveryBranch!;
    expect(git(root, 'log', '--oneline', branch)).toContain('Changes from Second task');
    expect(manager.listPendingResolutions().map((r) => r.branchName)).toEqual([branch]);
  });

  test('a conflicted reconcile reclaims the worktree slot and untracks the worktree', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root, { worktreeLimit: 1 });
    await manager.init();

    const first = await manager.spawn('first', 'First task');
    writeConflictingEdit(first!.path);
    // Land a competing change directly on the destination branch.
    writeFileSync(join(root, 'shared.txt'), 'line one\ndestination wins\nline three\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'destination edit');

    const result = await manager.reconcile('first');
    expect(result.outcome).toBe('conflict');

    // The slot is free again even though the work was not merged.
    expect(manager.getStatus().active).toHaveLength(0);
    expect(manager.getStatus().availableSlots).toBe(1);
    expect(manager.canSpawn()).toBe(true);
    expect(manager.getStatus().pendingResolutions).toHaveLength(1);
    // A second task can now use the reclaimed capacity.
    expect(await manager.spawn('second', 'Second task')).not.toBeNull();
  });

  test('applying a resolution merges once the destination has moved past the conflict', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();

    const worktree = await manager.spawn('task', 'Conflicting task');
    writeConflictingEdit(worktree!.path);
    writeFileSync(join(root, 'shared.txt'), 'line one\ndestination wins\nline three\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'destination edit');

    const conflicted = await manager.reconcile('task');
    expect(conflicted.outcome).toBe('conflict');
    const branch = conflicted.recoveryBranch!;

    // Still conflicting: retrying must refuse rather than half-apply.
    const stillConflicted = await manager.applyResolution('task');
    expect(stillConflicted.outcome).toBe('conflict');
    expect(git(root, 'status', '--porcelain')).toBe('');

    // The user resolves it on the branch by hand: fold the destination into the
    // branch, settle the overlap there, and commit. Once the destination is an
    // ancestor of the branch, the merge is clean by construction.
    git(root, 'checkout', branch);
    gitFails(root, 'merge', 'master'); // expected to conflict; resolved below
    writeFileSync(join(root, 'shared.txt'), 'line one\nresolved by hand\nline three\n');
    git(root, 'add', 'shared.txt');
    git(root, 'commit', '-m', 'resolve by hand');
    git(root, 'checkout', '-');

    const applied = await manager.applyResolution('task');
    expect(applied.success).toBe(true);
    expect(applied.outcome).toBe('merged');
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe(
      'line one\nresolved by hand\nline three\n',
    );
    expect(manager.listPendingResolutions()).toHaveLength(0);
    // The recovery branch is deleted once its work has landed.
    expect(gitFails(root, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBe(true);
  });

  test('discarding a resolution removes the branch and the record', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Conflicting task');
    writeConflictingEdit(worktree!.path);
    writeFileSync(join(root, 'shared.txt'), 'line one\ndestination wins\nline three\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'destination edit');
    const conflicted = await manager.reconcile('task');
    expect(conflicted.outcome).toBe('conflict');

    const discarded = await manager.discardResolution('task');
    expect(discarded.success).toBe(true);
    expect(manager.listPendingResolutions()).toHaveLength(0);
    expect(gitFails(root, 'rev-parse', '--verify', `refs/heads/${conflicted.recoveryBranch}`)).toBe(
      true,
    );
  });

  test('a resolution survives a restart', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Conflicting task');
    writeConflictingEdit(worktree!.path);
    writeFileSync(join(root, 'shared.txt'), 'line one\ndestination wins\nline three\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'destination edit');
    expect((await manager.reconcile('task')).outcome).toBe('conflict');

    const restarted = new WorkspaceManager(root);
    await restarted.init();
    expect(restarted.listPendingResolutions().map((r) => r.branchName)).toEqual([
      'ai/conflicting-task-task',
    ]);
    expect(restarted.getStatus().active).toHaveLength(0);
  });

  test('the user switching branches mid-task does not redirect the merge', async () => {
    const root = repo();
    git(root, 'checkout', '-b', 'feature');
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Task');
    writeFileSync(join(worktree!.path, 'added.txt'), 'worker output\n');

    // The destination was pinned to 'feature' at spawn. Switching the user's
    // checkout must not move the work onto another branch.
    git(root, 'checkout', '-b', 'somewhere-else');
    const result = await manager.reconcile('task');
    expect(result.success).toBe(true);
    expect(existsSync(join(root, 'added.txt'))).toBe(false);
    expect(git(root, 'ls-tree', '--name-only', 'feature')).toContain('added.txt');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('somewhere-else');
  });

  test('uncommitted user work and a pre-existing stash both survive a reconcile', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Task');
    writeFileSync(join(worktree!.path, 'added.txt'), 'worker output\n');

    // A stash the user made earlier must never be popped or dropped by us.
    writeFileSync(join(root, 'earlier.txt'), 'stashed earlier\n');
    git(root, 'add', 'earlier.txt');
    git(root, 'commit', '-m', 'earlier commit');
    writeFileSync(join(root, 'earlier.txt'), 'stashed earlier, then modified\n');
    git(root, 'stash', 'push', '-m', 'user stash');
    // Uncommitted work in the tree that reconcile has to preserve.
    writeFileSync(join(root, 'uncommitted.txt'), 'uncommitted user work\n');

    const result = await manager.reconcile('task');
    expect(result.success).toBe(true);

    // The worker's change landed AND the user's uncommitted file is back.
    expect(existsSync(join(root, 'added.txt'))).toBe(true);
    expect(readFileSync(join(root, 'uncommitted.txt'), 'utf8')).toBe('uncommitted user work\n');
    // The user's own stash is still on the stack, untouched.
    expect(git(root, 'stash', 'list')).toContain('user stash');
  });

  test('a worker that changed nothing reports a no-op and still frees its slot', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    await manager.spawn('task', 'Task');
    const result = await manager.reconcile('task');
    expect(result.success).toBe(true);
    expect(result.outcome).toBe('noop');
    expect(manager.getStatus().active).toHaveLength(0);
  });

  test('a failed worker preserves its work on a branch instead of destroying it', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Failing task');
    writeFileSync(join(worktree!.path, 'partial.txt'), 'half-finished work\n');

    const abandoned = await manager.abandon('task');
    expect(abandoned.success).toBe(true);
    expect(abandoned.recoveryBranch).toBe('ai/failing-task-task');
    // Nothing was merged into the destination.
    expect(existsSync(join(root, 'partial.txt'))).toBe(false);
    // But the work is recoverable.
    expect(git(root, 'show', 'ai/failing-task-task:partial.txt')).toBe('half-finished work');
    expect(manager.listPendingResolutions()[0].reason).toBe('incomplete');
  });

  test('shutdown preserves unmerged work rather than discarding it', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = await manager.spawn('task', 'Unfinished task');
    writeFileSync(join(worktree!.path, 'in-flight.txt'), 'work in progress\n');

    await manager.shutdown();

    expect(manager.getStatus().active).toHaveLength(0);
    expect(git(root, 'show', 'ai/unfinished-task-task:in-flight.txt')).toBe('work in progress');
    expect(manager.listPendingResolutions().map((r) => r.reason)).toEqual(['incomplete']);
  });

  test('shutdown deletes branches that carry nothing', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    await manager.spawn('task', 'Empty task');
    await manager.shutdown();
    expect(gitFails(root, 'rev-parse', '--verify', 'refs/heads/ai/empty-task-task')).toBe(true);
    expect(manager.listPendingResolutions()).toHaveLength(0);
  });

  test('the reaper removes merged branches and keeps unmerged ones', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();

    const merged = await manager.spawn('merged', 'Merged task');
    writeFileSync(join(merged!.path, 'a.txt'), 'a\n');
    expect((await manager.reconcile('merged')).success).toBe(true);

    const unmerged = await manager.spawn('unmerged', 'Unmerged task');
    writeFileSync(join(unmerged!.path, 'b.txt'), 'b\n');
    // Abandon rather than reconcile so the branch outlives the worktree.
    await manager.abandon('unmerged');

    const reaped = await manager.reapMergedBranches();
    expect(reaped.success).toBe(true);
    // Both branches exist right now: 'unmerged' is a pending resolution, which
    // the reaper must never touch.
    expect(gitFails(root, 'rev-parse', '--verify', 'refs/heads/ai/unmerged-task-unmerged')).toBe(
      false,
    );
    expect(manager.listPendingResolutions()).toHaveLength(1);

    // Once the pending resolution is discarded, the branch goes too.
    await manager.discardResolution('unmerged');
    expect(gitFails(root, 'rev-parse', '--verify', 'refs/heads/ai/unmerged-task-unmerged')).toBe(
      true,
    );
  });

  test('Koryphaios state stays out of git status without editing a tracked .gitignore', async () => {
    // The repo helper deliberately creates no .gitignore: Koryphaios must not
    // add one, and its own state dir must not appear as untracked.
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
    // Both the worktree dir and the state dir are excluded locally.
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.trees/');
    expect(exclude).toContain('.koryphaios/');
  });

  test('an existing tracked .gitignore is left untouched by default', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-m', 'add gitignore');
    const manager = new WorkspaceManager(root);
    await manager.init();
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('modifyGitignore opts into the tracked .gitignore entry', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root, { modifyGitignore: true });
    await manager.init();
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('.trees/');
    expect(ignore).toContain('.koryphaios/');
  });
});
