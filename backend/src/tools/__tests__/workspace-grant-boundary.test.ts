import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionWorkspace } from '../../kory/session-workspace';
import { BashTool } from '../bash';
import { ReadFileTool } from '../files';
import { ToolRegistry, type ToolContext } from '../registry';

// The mandatory boundary used to come only from ownership: a Koryphaios-owned
// session checkout or an explicit review root. Workers pointed straight at an
// ordinary repo (chat run on the project itself, not a session checkout) had
// neither, so every tool call failed with the generic boundary error. A
// host-issued `requiredWorkspaceRoot` is itself the workspace grant — it is
// set by the host, never by provider input — and must be canonicalized before
// it can serve as the root.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-grant-')));
const registry = new ToolRegistry();
for (const tool of [new BashTool(), new ReadFileTool()]) registry.register(tool);
const off = {
  isSandboxed: false,
  pathConfinement: false,
  commandWhitelist: false,
  metacharacters: false,
  network: false,
  containerTools: false,
  degraded: true,
};
function context(overrides: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'grant-test',
    workingDirectory: root,
    isSandboxed: false,
    sandboxOptions: off,
    allowedPaths: ['/'],
    permissionPolicy: {
      mode: 'yolo',
      autoRunTools: true,
      autoApplySafeFixes: true,
      confirmRiskyActions: false,
      autonomyLimitsEnabled: false,
      approvalThresholdFiles: 100,
      approvalThresholdLines: 10000,
      toolAllowlist: [],
      toolBlocklist: [],
      toolAsklist: [],
    },
    ...overrides,
  };
}
function execute(name: string, input: Record<string, unknown>, ctx: ToolContext) {
  return registry.execute(ctx, { id: crypto.randomUUID(), name, input });
}
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('host-issued requiredWorkspaceRoot grant', () => {
  test('unowned repo + requiredWorkspaceRoot = repo root: read_file and bash ls succeed', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kory-grant-repo-')));
    writeFileSync(join(repo, 'a.txt'), 'hello');
    git(repo, 'init', '-q');
    const ctx = context({ workingDirectory: repo, requiredWorkspaceRoot: repo });
    const read = await execute('read_file', { path: 'a.txt' }, ctx);
    expect(read.isError).toBeFalsy();
    expect(String(read.output)).toContain('hello');
    const ls = await execute('bash', { command: 'ls' }, ctx);
    expect(ls.isError).toBeFalsy();
    expect(String(ls.output)).toContain('a.txt');
    rmSync(repo, { recursive: true, force: true });
  });

  test('nonexistent grant errors with the specific reason', async () => {
    const gone = join(root, 'no-such-dir');
    const result = await execute(
      'read_file',
      { path: 'a.txt' },
      context({ workingDirectory: root, requiredWorkspaceRoot: gone }),
    );
    expect(result.isError).toBeTruthy();
    expect(String(result.output)).toContain(
      'Cannot establish the mandatory workspace boundary: Owned workspace is no longer available',
    );
  });

  test('cwd outside the grant errors with the reason preserved', async () => {
    const grant = realpathSync(mkdtempSync(join(tmpdir(), 'kory-grant-only-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kory-outside-')));
    const result = await execute(
      'read_file',
      { path: 'a.txt' },
      context({ workingDirectory: outside, requiredWorkspaceRoot: grant }),
    );
    expect(result.isError).toBeTruthy();
    expect(String(result.output)).toContain(
      'Cannot establish the mandatory workspace boundary:',
    );
    rmSync(grant, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('a worktree-isolated worker path inside the grant is accepted', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'kory-grant-wt-')));
    writeFileSync(join(repo, 'f.txt'), 'data');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const worktrees = join(root, 'worktrees');
    git(repo, 'worktree', 'add', '-q', join(worktrees, 'w1'), 'HEAD');
    // The host pins the worker to its own worktree directory.
    const ctx = context({
      workingDirectory: join(worktrees, 'w1'),
      requiredWorkspaceRoot: join(worktrees, 'w1'),
    });
    const read = await execute('read_file', { path: 'f.txt' }, ctx);
    expect(read.isError).toBeFalsy();
    expect(String(read.output)).toContain('data');
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  });

  test('owned session checkout path still works unchanged (no grant needed)', async () => {
    const source = realpathSync(mkdtempSync(join(tmpdir(), 'kory-grant-src-')));
    git(source, 'init', '-q');
    writeFileSync(join(source, 'c.txt'), 'owned');
    git(source, 'add', '.');
    git(source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    const ws = await createSessionWorkspace(source, { storageRoot: join(root, 'chats') });
    const ctx = context({ workingDirectory: ws.path });
    const read = await execute('read_file', { path: 'c.txt' }, ctx);
    expect(read.isError).toBeFalsy();
    expect(String(read.output)).toContain('owned');
    rmSync(source, { recursive: true, force: true });
    rmSync(join(root, 'chats'), { recursive: true, force: true });
  });
});

describe('subAgentRequiredWorkspaceRoot', () => {
  test('a YOLO worker context carries no workspace pin; guarded stays pinned', async () => {
    const { subAgentRequiredWorkspaceRoot } = await import('../../kory/manager');
    expect(subAgentRequiredWorkspaceRoot('yolo', '/wt/worker')).toBeUndefined();
    expect(subAgentRequiredWorkspaceRoot('guarded', '/wt/worker')).toBe('/wt/worker');
    expect(subAgentRequiredWorkspaceRoot('edits', '/wt/worker')).toBe('/wt/worker');
    expect(subAgentRequiredWorkspaceRoot(undefined, '/wt/worker')).toBe('/wt/worker');
  });
});
