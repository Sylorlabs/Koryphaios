import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSessionWorkspace,
  migrateSessionWorkspace,
  sessionSettingsRoot,
  sessionWorkspaceOwnership,
} from '../session-workspace';
import { resolveMemoryRoot } from '../../memory/unified-memory';
import { ConflictError } from '../../errors/types';

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-chat-isolation-')));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'file.txt'), 'baseline\n');
  mkdirSync(join(source, 'package'));
  writeFileSync(join(source, 'package', 'index.ts'), 'export {};\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'baseline');
  return { root, source, storageRoot: join(root, 'chats') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('independent chat repositories', () => {
  test('ownership and source settings survive a fresh backend process', async () => {
    const { source } = setup();
    const workspace = await createSessionWorkspace(source);
    const script = `import { sessionWorkspaceOwnership } from ${JSON.stringify(join(import.meta.dir, '../session-workspace.ts'))}; console.log(JSON.stringify(sessionWorkspaceOwnership(${JSON.stringify(workspace.path)})));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const owner = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(owner.sourceRoot).toBe(source);
    expect(owner.checkout).toBe(workspace.path);
    rmSync(join(workspace.path, '..'), { recursive: true, force: true });
  });

  test('creating a chat from an owned checkout transfers data without executing its upload hook', async () => {
    const { root, source, storageRoot } = setup();
    const parent = await createSessionWorkspace(source, { storageRoot });
    const marker = join(root, 'should-not-exist');
    git(parent.path, 'config', 'uploadpack.packObjectsHook', `touch '${marker}'; git pack-objects`);
    const child = await createSessionWorkspace(parent.path, { storageRoot });
    expect(existsSync(marker)).toBe(false);
    expect(child.path).not.toBe(parent.path);
    expect(git(child.path, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(sessionSettingsRoot(child.path)).toBe(source);
  });

  test('legacy migration refuses dirty work instead of disconnecting it from the chat', async () => {
    const { source } = setup();
    writeFileSync(join(source, 'file.txt'), 'unfinished legacy work\n');
    git(source, 'add', 'file.txt');
    writeFileSync(join(source, 'file.txt'), 'unstaged legacy work\n');
    const before = git(source, 'status', '--porcelain');
    await expect(migrateSessionWorkspace(source, source)).rejects.toThrow('unfinished');
    await expect(migrateSessionWorkspace(source, source)).rejects.toBeInstanceOf(ConflictError);
    expect(git(source, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('unstaged legacy work\n');
  });

  test('settings authority can remain the source project when copying a legacy worktree', async () => {
    const { root, source, storageRoot } = setup();
    const legacy = join(root, 'legacy');
    git(source, 'worktree', 'add', '-b', 'legacy', legacy);
    const workspace = await createSessionWorkspace(legacy, { storageRoot, settingsRoot: source });
    expect(sessionSettingsRoot(workspace.path)).toBe(source);
    git(workspace.path, 'config', '--local', 'test.private', 'yes');
    expect(git(source, 'config', '--local', '--list')).not.toContain('test.private');
  });

  test('concurrent chats own independent indexes, refs, stash and config without touching source dirty state', async () => {
    const { source, storageRoot } = setup();
    writeFileSync(join(source, 'file.txt'), 'source staged\n');
    git(source, 'add', '.');
    writeFileSync(join(source, 'file.txt'), 'source unstaged\n');
    writeFileSync(join(source, 'untracked.txt'), 'source private\n');
    const sourceStatus = git(source, 'status', '--porcelain');
    const sourceHead = git(source, 'rev-parse', 'HEAD');
    const [a, b] = await Promise.all([
      createSessionWorkspace(source, { storageRoot }),
      createSessionWorkspace(source, { storageRoot }),
    ]);
    expect(a.isolation).toBe('independent-repository');
    expect(a.path).not.toBe(b.path);
    expect(git(a.path, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(git(b.path, 'rev-parse', '--git-common-dir')).toBe('.git');
    expect(existsSync(join(a.path, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(git(a.path, 'remote')).toBe('');
    writeFileSync(join(a.path, 'file.txt'), 'A stash\n');
    git(a.path, 'stash', 'push', '-m', 'private A');
    expect(git(b.path, 'stash', 'list')).toBe('');
    expect(git(source, 'stash', 'list')).toBe('');
    writeFileSync(join(b.path, 'file.txt'), 'B stash\n');
    git(b.path, 'stash', 'push', '-m', 'private B');
    git(b.path, 'stash', 'pop');
    expect(readFileSync(join(b.path, 'file.txt'), 'utf8')).toBe('B stash\n');
    expect(git(a.path, 'stash', 'list')).toContain('private A');
    git(a.path, 'config', '--local', 'test.chat', 'A');
    expect(git(b.path, 'config', '--local', '--list')).not.toContain('test.chat');
    git(a.path, 'tag', 'only-a');
    git(a.path, 'branch', 'only-a');
    expect(git(b.path, 'tag')).toBe('');
    expect(git(b.path, 'branch', '--list', 'only-a')).toBe('');
    git(a.path, 'stash', 'pop');
    git(a.path, 'add', '.');
    git(a.path, '-c', 'commit.gpgsign=false', 'commit', '-m', 'A only');
    git(a.path, 'reset', '--hard', 'HEAD~1');
    git(a.path, 'clean', '-fd');
    expect(readFileSync(join(b.path, 'file.txt'), 'utf8')).toBe('B stash\n');
    expect(git(source, 'status', '--porcelain')).toBe(sourceStatus);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('source private\n');
    expect(sessionSettingsRoot(a.path)).toBe(source);
    expect(resolveMemoryRoot(a.path)).toBe(source);
  });

  test('retains selected project subdirectory and authoritative source settings', async () => {
    const { source, storageRoot } = setup();
    const workspace = await createSessionWorkspace(join(source, 'package'), { storageRoot });
    expect(workspace.path.endsWith('/checkout/package')).toBe(true);
    expect(readFileSync(join(workspace.path, 'index.ts'), 'utf8')).toBe('export {};\n');
    expect(sessionSettingsRoot(workspace.path)).toBe(join(source, 'package'));
    expect(sessionWorkspaceOwnership(workspace.path)?.checkout).toBe(join(workspace.path, '..'));
  });

  test('non-Git and unborn projects get independent snapshots without initializing the source', async () => {
    const { root, storageRoot } = setup();
    for (const unborn of [false, true]) {
      const source = join(root, unborn ? 'unborn' : 'plain');
      mkdirSync(source);
      if (unborn) git(source, 'init');
      writeFileSync(join(source, 'draft.txt'), 'draft\n');
      const workspace = await createSessionWorkspace(source, { storageRoot });
      expect(readFileSync(join(workspace.path, 'draft.txt'), 'utf8')).toBe('draft\n');
      expect(git(workspace.path, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(source, '.git'))).toBe(unborn);
    }
  });
});
