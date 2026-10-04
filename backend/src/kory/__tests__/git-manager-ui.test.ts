import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitManager } from '../git-manager';

let root: string;
let repo: string;
let manager: GitManager;
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-git-ui-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'UI Test');
  git(repo, 'config', 'user.email', 'ui@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'tracked file.txt'), 'initial\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial');
  manager = new GitManager(repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Git panel real repository workflows', () => {
  test('preserves unstaged status, unusual paths, and separate index/worktree stats', async () => {
    writeFileSync(join(repo, 'tracked file.txt'), 'initial\nstaged\n');
    expect(await manager.stageFile('tracked file.txt')).toBe(true);
    writeFileSync(join(repo, 'tracked file.txt'), 'initial\nstaged\nunstaged\n');
    const unusual = process.platform === 'win32' ? 'new ü.txt' : 'new "quoted" ü.txt';
    writeFileSync(join(repo, unusual), 'untracked\n');
    const status = await manager.getStatus();
    expect(status).toContainEqual({
      path: 'tracked file.txt',
      status: 'modified',
      staged: true,
      additions: 1,
      deletions: 0,
    });
    expect(status).toContainEqual({
      path: 'tracked file.txt',
      status: 'modified',
      staged: false,
      additions: 1,
      deletions: 0,
    });
    expect(status).toContainEqual({ path: unusual, status: 'untracked', staged: false });
    expect(await manager.stageFile(unusual)).toBe(true);
    expect(await manager.unstageFile(unusual)).toBe(true);
    expect((await manager.getStatus()).find((file) => file.path === unusual)?.staged).toBe(false);
  });

  test('recognizes a leading unstaged modification without trimming its status column', async () => {
    writeFileSync(join(repo, 'tracked file.txt'), 'edited\n');
    expect(await manager.getStatus()).toEqual([
      { path: 'tracked file.txt', status: 'modified', staged: false, additions: 1, deletions: 1 },
    ]);
  });

  test('unstages both sides of a rename and leaves the files intact', async () => {
    renameSync(join(repo, 'tracked file.txt'), join(repo, 'renamed file.txt'));
    expect(await manager.stageFile('.')).toBe(true);
    expect(await manager.getStatus()).toEqual([
      {
        path: 'renamed file.txt',
        originalPath: 'tracked file.txt',
        status: 'renamed',
        staged: true,
        additions: 0,
        deletions: 0,
      },
    ]);
    expect(await manager.unstageFile('renamed file.txt')).toBe(true);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(
      (await manager.getStatus()).some(
        (file) => file.path === 'renamed file.txt' && file.status === 'untracked',
      ),
    ).toBe(true);
  });

  test('publishes a new branch to a disposable remote and establishes its upstream', async () => {
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'checkout', '-b', 'feature/ui');
    const result = await manager.push();
    expect(result.success, result.output).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/ui');
    expect(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/ui')).toBe(
      git(repo, 'rev-parse', 'HEAD'),
    );
    expect((await manager.push()).success).toBe(true);
  });

  test('configures a hosted origin explicitly and rejects local paths or embedded credentials', async () => {
    expect(await manager.getOrigin()).toBeNull();
    for (const url of [repo, `file://${repo}`, 'https://user:secret@example.test/repo.git']) {
      expect((await manager.setOrigin(url)).success).toBe(false);
      expect(await manager.getOrigin()).toBeNull();
    }
    expect((await manager.setOrigin('https://github.com/owner/repo.git')).success).toBe(true);
    expect(await manager.getOrigin()).toBe('https://github.com/owner/repo.git');
    expect((await manager.setOrigin('git@github.com:owner/other.git')).success).toBe(true);
    expect(await manager.getOrigin()).toBe('git@github.com:owner/other.git');
  });
});
