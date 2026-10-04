import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspace } from '../git-workspace';

let directory: string;
let repo: string;
let service: GitWorkspace;
function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kory-git-picker-'));
  repo = join(directory, 'repo');
  mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'file.txt'), 'initial');
  git('add', '.');
  git('commit', '-m', 'Initial commit');
  service = new GitWorkspace(repo, join(directory, 'worktrees'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('Git workspace revision selection', () => {
  test('lists local/remote branches, tags, and recent commits', async () => {
    git('branch', 'feature/example');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('tag', 'v1');
    const state = await service.selection();
    expect(state.branch).toBe('main');
    expect(state.dirty).toBe(false);
    expect(state.head).toBe(git('rev-parse', 'HEAD'));
    expect(state.refs.map((item) => item.ref)).toEqual([
      'refs/heads/feature/example',
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/tags/v1',
    ]);
    expect(state.commits[0].subject).toBe('Initial commit');
  });

  test('creates an isolated branch from a commit without moving or stashing dirty work', async () => {
    const original = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'file.txt'), 'staged');
    git('add', 'file.txt');
    writeFileSync(join(repo, 'file.txt'), 'unstaged');
    writeFileSync(join(repo, 'untracked.txt'), 'private');
    const before = git('status', '--porcelain');
    expect((await service.selection()).dirty).toBe(true);
    const workspace = await service.create({
      ref: original,
      expectedHash: original,
      branch: 'feature/chat',
    });
    expect(workspace.baseCommit).toBe(original);
    expect(readFileSync(join(workspace.path, 'file.txt'), 'utf8')).toBe('initial');
    expect(existsSync(join(workspace.path, 'untracked.txt'))).toBe(false);
    expect(git('branch', '--show-current')).toBe('main');
    expect(git('status', '--porcelain')).toBe(before);
    expect(git('stash', 'list')).toBe('');
    const worktree = new GitWorkspace(workspace.path, join(directory, 'worktrees'));
    expect((await worktree.selection()).branch).toBe('feature/chat');
  });

  test('rejects moved refs and existing branch names without switching HEAD', async () => {
    const original = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'Moved branch');
    await expect(
      service.create({ ref: 'refs/heads/main', expectedHash: original, branch: 'new-chat' }),
    ).rejects.toThrow('moved');
    await expect(service.create({ ref: original, branch: 'main' })).rejects.toThrow(
      'already exists',
    );
    expect(git('branch', '--show-current')).toBe('main');
  });

  test('rejects option injection, revision expressions, and invalid branch names', async () => {
    for (const ref of ['--help', '-B', 'HEAD~1', 'main', 'refs/heads/a..b']) {
      await expect(service.create({ ref, branch: 'safe' })).rejects.toThrow();
    }
    for (const branch of [
      '--force',
      '../escape',
      'x..y',
      'refs/heads/nested',
      'has space',
      'x.lock',
    ]) {
      await expect(service.create({ ref: git('rev-parse', 'HEAD'), branch })).rejects.toThrow();
    }
    expect(git('branch', '--show-current')).toBe('main');
  });

  test('can start at a commit reachable only through a remote-tracking branch', async () => {
    const remoteCommit = git('commit-tree', 'HEAD^{tree}', '-m', 'Remote-only commit');
    git('update-ref', 'refs/remotes/origin/remote-only', remoteCommit);
    const workspace = await service.create({
      ref: 'refs/remotes/origin/remote-only',
      expectedHash: remoteCommit,
      branch: 'from-remote',
    });
    expect(workspace.baseCommit).toBe(remoteCommit);
  });

  test('supports detached HEAD, annotated tags and an unborn repository', async () => {
    git('tag', '-a', 'release', '-m', 'Release');
    const workspace = await service.create({
      ref: 'refs/tags/release',
      expectedHash: git('rev-parse', 'refs/tags/release'),
      branch: 'from-tag',
    });
    expect(workspace.baseCommit).toBe(git('rev-parse', 'HEAD'));
    git('checkout', '--detach');
    expect((await service.selection()).branch).toBeNull();
    const empty = join(directory, 'empty');
    mkdirSync(empty);
    Bun.spawnSync(['git', 'init'], { cwd: empty });
    const state = await new GitWorkspace(empty).selection();
    expect(state.isRepo).toBe(true);
    expect(state.head).toBeNull();
    expect(state.commits).toEqual([]);
  });

  test('non-repositories are an explicit empty state', async () => {
    expect((await new GitWorkspace(directory).selection()).isRepo).toBe(false);
  });
});
