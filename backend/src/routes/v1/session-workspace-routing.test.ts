import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const root = mkdtempSync(join(tmpdir(), 'kory-session-routing-'));
const source = join(root, 'source');
const checkoutRoot = join(root, 'checkout');
let checkout: string = checkoutRoot;
const { Elysia } = await import('elysia');
const { setContext } = await import('../../context');
const { errorHandler } = await import('../../middleware/error-handling');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { gitRoutes } = await import('./git');
const { workspaceRoutes } = await import('./workspace');
const { getRequestWorkspaceRoot } = await import('../../runtime/request-project');
const { processSupervisor } = await import('../../process-supervisor/supervisor');
const { createSessionWorkspace } = await import('../../kory/session-workspace');
const { getCorsHeaders } = await import('../../security');
const settings = await import('../../agent-settings');
const workspaceStatus = mock(async (_sessionId?: string) => ({ available: true }));
const resolveWorktree = mock(async (_taskId: string, _sessionId?: string) => ({ success: true }));
const discardWorktree = mock(async (_taskId: string, _sessionId?: string) => ({ success: true }));
const app = new Elysia().onError(errorHandler).use(gitRoutes).use(workspaceRoutes);
let token: string;
let authId: string;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function request(path: string, sessionId: string | undefined = 'chat', body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: token,
      'content-type': 'application/json',
      'x-koryphaios-project': source,
      ...(sessionId !== undefined ? { 'x-koryphaios-session': sessionId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeAll(async () => {
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.test');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'shared.txt'), 'source');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  // Chat Git mutations only ever run in a host-owned independent chat
  // repository, never in a linked worktree of the source project.
  checkout = (
    await createSessionWorkspace(source, {
      storageRoot: join(root, 'chats'),
      branch: 'chat-branch',
    })
  ).path;
  writeFileSync(join(checkout, 'shared.txt'), 'checkout');
  writeFileSync(join(checkout, 'chat-only.txt'), 'chat');
  const auth = localAuth.createSession(['*']);
  authId = auth.sessionId;
  token = buildLocalBearerToken(auth);
  setContext({
    sessions: {
      get: async (id: string) =>
        ['chat', 'missing', 'file'].includes(id)
          ? { id, workingDirectory: source, gitWorkspace: { path: realpathSync(checkout) } }
          : null,
    },
    kory: {
      resolveSessionWorkingDirectoryPublic: async (id: string) =>
        id === 'missing'
          ? join(root, 'missing')
          : id === 'file'
            ? join(source, 'shared.txt')
            : checkout,
      tryAcquireSessionMutationBarrier: () => ({ release() {} }),
      getWorkspaceStatus: workspaceStatus,
      applyWorktreeResolution: resolveWorktree,
      discardWorktreeResolution: discardWorktree,
    },
  } as never);
});
// Git mutations run under the same agent-tool barrier production uses, and a
// stopped supervisor denies that barrier.
await processSupervisor.initialize();
afterAll(async () => {
  await processSupervisor.shutdown();
  localAuth.revokeSession(authId);
  rmSync(root, { recursive: true, force: true });
});

describe('session execution checkout HTTP routing', () => {
  test('reads status and file contents from checkout while selection stays source-scoped', async () => {
    const status = await (await app.handle(request('/api/git/status'))).json();
    expect(status.data.branch).toBe('chat-branch');
    expect(status.data.status.map((file: { path: string }) => file.path)).toContain(
      'chat-only.txt',
    );
    const file = await (await app.handle(request('/api/git/file?path=shared.txt'))).json();
    expect(file.data.content).toBe('checkout');
    const selection = await (await app.handle(request('/api/git/selection', 'unknown'))).json();
    expect(selection.data.branch).toBe('main');
  });
  test('stages files only in the execution checkout', async () => {
    expect(
      (await app.handle(request('/api/git/stage', 'chat', { file: 'shared.txt' }))).status,
    ).toBe(200);
    expect(git(checkout, 'diff', '--cached', '--name-only')).toBe('shared.txt');
    expect(git(source, 'diff', '--cached', '--name-only')).toBe('');
  });
  test('file mentions and relative image paths use the session checkout', async () => {
    const files = await (await app.handle(request('/api/workspace/files'))).json();
    expect(files.data).toContain('chat-only.txt');
    writeFileSync(join(source, 'preview.png'), 'source image');
    writeFileSync(join(checkout, 'preview.png'), 'checkout image');
    const settingsSpy = spyOn(settings, 'loadAgentSettings').mockReturnValue({
      allowExternalPaths: true,
    } as never);
    try {
      // An image element supplies auth and routing via query parameters.
      const url = new URL('http://localhost/api/workspace/raw');
      url.search = new URLSearchParams({
        path: 'preview.png',
        sessionId: 'chat',
        project: source,
        auth: token,
      }).toString();
      const image = await app.handle(new Request(url));
      expect(image.status).toBe(200);
      expect(await image.text()).toBe('checkout image');
      expect(settingsSpy).toHaveBeenCalledWith(realpathSync(source));
      url.searchParams.set('sessionId', 'missing');
      expect((await app.handle(new Request(url))).status).toBe(400);
    } finally {
      settingsSpy.mockRestore();
    }
  });
  test('unknown, empty, missing, and non-directory sessions fail closed', async () => {
    for (const [session, code] of [
      ['unknown', 404],
      ['', 400],
      ['missing', 400],
      ['file', 400],
    ] as const) {
      for (const path of ['/api/git/status', '/api/workspace/files', '/api/git/worktrees']) {
        expect((await app.handle(request(path, session))).status).toBe(code);
      }
    }
    expect(await getRequestWorkspaceRoot(request('/api/git/status'))).toBe(realpathSync(checkout));
    const noSession = request('/api/git/status');
    noSession.headers.delete('x-koryphaios-session');
    expect(await getRequestWorkspaceRoot(noSession)).toBe(realpathSync(source));
  });
  test('worktree status and recovery pass the session owner to the manager', async () => {
    await app.handle(request('/api/git/worktrees'));
    expect(workspaceStatus).toHaveBeenLastCalledWith('chat');
    await app.handle(request('/api/git/worktrees/resolve', 'chat', { taskId: 'task' }));
    expect(resolveWorktree).toHaveBeenLastCalledWith('task', 'chat');
    await app.handle(request('/api/git/worktrees/discard', 'chat', { taskId: 'task' }));
    expect(discardWorktree).toHaveBeenLastCalledWith('task', 'chat');
    expect(getCorsHeaders()['Access-Control-Allow-Headers']).toContain('X-Koryphaios-Session');
  });
});
