import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-wm-isolation-')));
  roots.push(root);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Isolation Test');
  git(root, 'config', 'user.email', 'isolation@test.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.longpaths', 'true');
  writeFileSync(join(root, '.gitignore'), '.trees/\n.koryphaios/\n');
  writeFileSync(join(root, 'seed.txt'), 'baseline\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceManager isolation boundaries', () => {
  test('shutdown retains dirty working copy and manifest when its commit fails', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = (await manager.spawn('shutdown-failure', 'Shutdown Failure'))!;
    writeFileSync(join(worktree.path, 'seed.txt'), 'uncommitted recovery data\n');
    const commit = spyOn(manager as any, 'commitPendingWorktreeChanges').mockResolvedValue(false);
    try {
      await manager.shutdown();
      expect(readFileSync(join(worktree.path, 'seed.txt'), 'utf8')).toBe(
        'uncommitted recovery data\n',
      );
      const manifest = JSON.parse(readFileSync(join(root, '.koryphaios/worktrees.json'), 'utf8'));
      expect(manifest.worktrees.some((entry: any) => entry.id === 'shutdown-failure')).toBe(true);
      expect(manifest.resolutions.some((entry: any) => entry.taskId === 'shutdown-failure')).toBe(
        true,
      );
      const recovered = new WorkspaceManager(root);
      await recovered.init();
      expect(await recovered.validateWorktree('shutdown-failure')).toBe(worktree.path);
      const retryCommit = spyOn(recovered as any, 'commitPendingWorktreeChanges').mockResolvedValue(
        false,
      );
      try {
        const resolution = await recovered.applyResolution('shutdown-failure');
        expect(resolution.success).toBe(false);
        expect(resolution.message).toContain('Recovery worktree is still present');
        expect(readFileSync(join(worktree.path, 'seed.txt'), 'utf8')).toBe(
          'uncommitted recovery data\n',
        );
      } finally {
        retryCommit.mockRestore();
      }
      expect((await recovered.applyResolution('shutdown-failure')).success).toBe(true);
      expect(readFileSync(join(root, 'seed.txt'), 'utf8')).toBe('uncommitted recovery data\n');
    } finally {
      commit.mockRestore();
    }
  });

  test('concurrent spawn queues behind an explicit cap and reuses a task ID', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root, { worktreeLimit: 1 });
    await manager.init();
    const first = manager.spawn('one', 'One');
    const second = manager.spawn('two', 'Two');
    expect(await first).not.toBeNull();
    expect(manager.getStatus().availableSlots).toBe(0);
    expect(manager.getStatus().queued).toBe(1);
    await expect(manager.spawn('one', 'Duplicate')).rejects.toThrow('already active');
    await manager.cleanup('one');
    expect(await second).not.toBeNull();
    expect(manager.getStatus().active).toHaveLength(1);
    expect(manager.getStatus().queued).toBe(0);
    expect(await manager.listAllWorktrees()).toHaveLength(2);
    await manager.shutdown();
  });

  test('a queued spawn can be aborted without taking a slot', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root, { worktreeLimit: 1 });
    await manager.init();
    expect(await manager.spawn('one', 'One')).not.toBeNull();

    const controller = new AbortController();
    const queued = manager.spawn('two', 'Two', undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getStatus().queued).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(manager.getStatus().queued).toBe(0);
    expect(manager.getStatus().active).toHaveLength(1);

    await manager.cleanup('one');
    await manager.shutdown();
  });

  test('spawn waits for initialization and shutdown drains accepted work before refusing new work', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    const initialization = manager.init();
    const worktree = await manager.spawn('during-init', 'During Init');
    await initialization;
    expect(worktree).not.toBeNull();
    await manager.shutdown();
    expect(manager.getStatus().active).toHaveLength(0);
    expect(await manager.listAllWorktrees()).toHaveLength(1);
    await expect(manager.spawn('after-close', 'After Close')).rejects.toThrow('shutting down');
  });

  test('real Git spawn failure releases capacity without a tracked fallback', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root, { worktreeLimit: 1 });
    await manager.init();
    git(root, 'branch', 'ai/task-blocked');
    expect(await manager.spawn('blocked', 'Task')).toBeNull();
    expect(manager.getStatus().active).toHaveLength(0);
    expect(await manager.spawn('valid', 'Task')).not.toBeNull();
    await manager.shutdown();
  });

  test('manifest publication failure cleans up a partially created worktree', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const publish = spyOn(manager as any, 'saveManifest').mockRejectedValue(
      new Error('disk failure'),
    );
    try {
      await expect(manager.spawn('partial', 'Partial')).rejects.toThrow('disk failure');
      expect(manager.getStatus().active).toHaveLength(0);
      expect(await manager.listAllWorktrees()).toHaveLength(1);
      expect(git(root, 'branch', '--list', 'ai/partial-partial')).toBe('');
    } finally {
      publish.mockRestore();
    }
  });

  test('recovery ignores stale manifest paths and revalidates live worktree ownership', async () => {
    const root = repo();
    const first = new WorkspaceManager(root);
    await first.init();
    const worktree = (await first.spawn('recovered', 'Recovered', 'owner'))!;
    const manifest = join(root, '.koryphaios', 'worktrees.json');
    writeFileSync(manifest, JSON.stringify({ worktrees: [{ ...worktree, path: root }] }));
    const recovered = new WorkspaceManager(root);
    await recovered.init();
    expect(await recovered.validateWorktree('recovered', 'owner')).toBe(worktree.path);
    await expect(recovered.validateWorktree('recovered', 'other-session')).rejects.toThrow(
      'ownership',
    );
    writeFileSync(join(worktree.path, 'recovered.txt'), 'recovered output\n');
    expect((await recovered.reconcile('recovered')).success).toBe(true);
    expect(readFileSync(join(root, 'recovered.txt'), 'utf8')).toBe('recovered output\n');
  });

  test('missing worktree Git metadata cannot reconcile or clean up the parent project', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = (await manager.spawn('missing-git', 'Missing Git', 'owner'))!;
    const head = git(root, 'rev-parse', 'HEAD');
    renameSync(join(worktree.path, '.git'), join(worktree.path, 'git-backup'));
    await expect(manager.validateWorktree('missing-git', 'owner')).rejects.toThrow();
    await expect(manager.reconcile('missing-git')).rejects.toThrow();
    await expect(manager.cleanup('missing-git')).rejects.toThrow();
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(root, 'seed.txt'), 'utf8')).toBe('baseline\n');
    renameSync(join(worktree.path, 'git-backup'), join(worktree.path, '.git'));
    await manager.cleanup('missing-git');
  });

  test('recovery cannot adopt a detached worktree using a manifest branch claim', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktree = (await manager.spawn('detached', 'Detached'))!;
    git(worktree.path, 'checkout', '--detach');
    const recovered = new WorkspaceManager(root);
    await recovered.init();
    expect(recovered.hasWorktree('detached')).toBe(false);
    expect(await recovered.listAllWorktrees()).toHaveLength(2);
    expect(git(root, 'branch', '--list', worktree.branchName)).not.toBe('');
  });

  test('redirected worktree base and traversal IDs are refused', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    await expect(manager.spawn('../escape', 'Escape')).rejects.toThrow();
    renameSync(join(root, '.trees'), join(root, 'original-trees'));
    symlinkSync(root, join(root, '.trees'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(manager.spawn('redirected', 'Redirected')).rejects.toThrow('redirected');
    expect(await manager.listAllWorktrees()).toHaveLength(1);
  });

  test('concurrent reconciliations preserve both independent worker changes', async () => {
    const root = repo();
    const manager = new WorkspaceManager(root);
    await manager.init();
    const worktrees = await Promise.all(['one', 'two'].map((id) => manager.spawn(id, id)));
    for (const worktree of worktrees)
      writeFileSync(join(worktree!.path, `${worktree!.id}.txt`), worktree!.id);
    const results = await Promise.all(['one', 'two'].map((id) => manager.reconcile(id)));
    expect(results.every((result) => result.success)).toBe(true);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(root, 'two.txt'), 'utf8')).toBe('two');
    expect(manager.getStatus().active).toHaveLength(0);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
