import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-chat-git-api-')));
process.env.NODE_ENV = 'test';
process.env.KORYPHAIOS_DATA_DIR = root;
process.env.DATABASE_URL = `sqlite:${join(root, 'test.sqlite')}`;
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const { Elysia } = await import('elysia');
const { initDb } = await import('../../db');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { setContext, getContext } = await import('../../context');
const { SessionStore } = await import('../../stores/session-store');
const { createSessionWorkspace } = await import('../../kory/session-workspace');
const { KoryManager } = await import('../../kory/manager');
const { SessionRuntimeRegistry } = await import('../../kory/services/SessionRuntime');
const { ensurePendingSessionReview } = await import('../../stores/session-review-store');
const { processSupervisor } = await import('../../process-supervisor/supervisor');
const { gitRoutes } = await import('./git');
const { ToolRegistry } = await import('../../tools/registry');
const { registerGitTools } = await import('../../tools/git');
const { decideToolPermission } = await import('../../tools/permission-policy');
const { tryAcquireWorkspaceOperation } = await import('../../tools/workspace-operation-gate');
const { sourceControlService } = await import('../../services/source-control-service');
const { chatGitForSession } = await import('../../services/chat-git-service');
const app = new Elysia().onError(errorHandler).use(gitRoutes);
const sessions = new SessionStore();
const source = join(root, 'source');
let a: { id: string; path: string };
let b: { id: string; path: string };
let token = '';
let head = '';
let managerBusy = false;
let processBusy = false;
const released = mock(() => {});
const processLease = spyOn(processSupervisor, 'tryAcquireAgentToolBarrier').mockImplementation(
  () => (processBusy ? null : { release: released }),
);
const chatFacade = sourceControlService.chat.bind(sourceControlService);
const chatFacadeSpy = spyOn(sourceControlService, 'chat').mockImplementation((scope) =>
  chatFacade(scope),
);
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
beforeAll(async () => {
  await initDb();
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.test');
  git(source, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(source, 'file'), 'baseline');
  mkdirSync(join(source, 'nested'));
  writeFileSync(join(source, 'nested', 'base.ts'), 'baseline');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Initial');
  head = git(source, 'rev-parse', 'HEAD');
  async function chat(branch: string) {
    const workspace = await createSessionWorkspace(source, {
      branch,
      storageRoot: join(root, 'chats'),
    });
    const session = await sessions.create('local-user', branch, undefined, source, workspace);
    return { id: session.id, path: workspace.path };
  }
  a = await chat('chat-a');
  b = await chat('chat-b');
  token = buildLocalBearerToken(localAuth.createSession(['*']));
  const workspaceManager = Object.assign(Object.create(KoryManager.prototype), {
    sessions,
    workingDirectory: source,
    runtimes: new SessionRuntimeRegistry(),
    emitWSMessage: mock(() => {}),
  }) as InstanceType<typeof KoryManager>;
  setContext({
    sessions,
    kory: {
      resolveSessionWorkingDirectoryPublic: async (id: string) =>
        workspaceManager.resolveSessionWorkingDirectoryPublic(id),
      tryAcquireSessionMutationBarrier: () => (managerBusy ? null : { release: released }),
      tryAcquireAgentGitMutationBarrier: () => (managerBusy ? null : { release: released }),
    },
    wsManager: { broadcastToSession: mock(() => {}) },
  } as never);
});
afterAll(() => {
  processLease.mockRestore();
  chatFacadeSpy.mockRestore();
  localAuth.dispose();
  rmSync(root, { recursive: true, force: true });
});
function request(path: string, id?: string, body?: unknown, authenticated = true) {
  return new Request(`http://localhost/api/git${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(authenticated && { authorization: token }),
      ...(id && { 'X-Koryphaios-Session': id }),
      'X-Koryphaios-Project': source,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function payload(branch: string, current: string) {
  return {
    expectedHead: head,
    expectedBranch: current,
    target: { kind: 'commit', ref: head, branch },
  };
}
describe('chat-scoped Git API and tools', () => {
  test('requires authentication and a real explicit chat; never falls back to a project', async () => {
    expect((await app.handle(request('/chat', a.id, undefined, false))).status).toBe(401);
    expect((await app.handle(request('/chat'))).status).toBe(400);
    expect((await app.handle(request('/chat', 'missing'))).status).toBe(404);
    expect(
      (await app.handle(request('/chat/switch', undefined, payload('bad', 'chat-a')))).status,
    ).toBe(400);
  });
  test('shows each chat state even when the selected project is identical', async () => {
    const first = await (await app.handle(request('/chat', a.id))).json();
    const second = await (await app.handle(request('/chat', b.id))).json();
    expect(first.data.branch).toBe('chat-a');
    expect(second.data.branch).toBe('chat-b');
    expect(first.data.repositoryPath).toBe(a.path);
    expect(second.data.repositoryPath).toBe(b.path);
    expect(chatFacadeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: a.id, workspaceRoot: realpathSync(a.path) }),
    );
  });
  test('ordinary chats read and write the selected folder directly', async () => {
    // Seed a chat without an explicit revision workspace.
    const legacy = await sessions.create('local-user', 'Legacy chat');
    await sessions.update(legacy.id, { workingDirectory: source });
    writeFileSync(join(source, 'unfinished.txt'), 'legacy draft');
    try {
      for (const path of ['/chat', '/status']) {
        const response = await app.handle(request(path, legacy.id));
        expect(response.status).toBe(200);
      }
      expect((await sessions.get(legacy.id))?.gitWorkspace).toBeUndefined();
      expect(git(source, 'status', '--porcelain')).toContain('unfinished.txt');
      expect(
        (await app.handle(request('/stage', legacy.id, { file: 'unfinished.txt' }))).status,
      ).toBe(200);
      expect(git(source, 'diff', '--cached', '--name-only')).toContain('unfinished.txt');
      expect((await app.handle(request('/chat', a.id))).status).toBe(200);
    } finally {
      git(source, 'reset', '--', 'unfinished.txt');
      rmSync(join(source, 'unfinished.txt'), { force: true });
    }
  });
  test('in-place access refuses a resolved directory that differs from the persisted binding', async () => {
    const session = await sessions.create('local-user', 'Bound folder', undefined, source);
    const resolver = spyOn(
      getContext().kory,
      'resolveSessionWorkingDirectoryPublic',
    ).mockResolvedValue(b.path);
    try {
      await expect(chatGitForSession(session.id)).rejects.toThrow('binding changed');
      expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(b.path, 'rev-parse', 'HEAD')).toBe(head);
    } finally {
      resolver.mockRestore();
    }
  });
  test('returns a first-class non-repository state instead of failing Git inspection', async () => {
    const plain = join(root, 'plain-folder');
    mkdirSync(plain);
    const session = await sessions.create('local-user', 'Plain folder');
    await sessions.update(session.id, { workingDirectory: plain });

    const response = await app.handle(request('/chat', session.id));
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.data.isRepo).toBe(false);
    expect(value.data.branch).toBeNull();
    expect(value.data.sourceRefs).toEqual([]);
  });
  test('stages and commits only the explicit chat and returns real commit failures', async () => {
    expect((await app.handle(request('/stage', undefined, { file: '.' }))).status).toBe(400);
    writeFileSync(join(b.path, 'ui-change.txt'), 'chat b only');
    expect((await app.handle(request('/stage', b.id, { file: 'ui-change.txt' }))).status).toBe(200);
    const status = await (await app.handle(request('/status', b.id))).json();
    expect(status.data.remote).toBeNull();
    expect(
      status.data.status.some(
        (file: { path: string; staged: boolean }) => file.path === 'ui-change.txt' && file.staged,
      ),
    ).toBe(true);
    const commit = await app.handle(request('/commit', b.id, { message: 'UI commit' }));
    expect(commit.status).toBe(200);
    expect(git(b.path, 'log', '-1', '--format=%s')).toBe('UI commit');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(a.path, 'rev-parse', 'HEAD')).toBe(head);
    const empty = await app.handle(request('/commit', b.id, { message: 'Nothing staged' }));
    expect(empty.status).toBe(500);
    expect((await empty.json()).error).toContain('nothing to commit');
    git(b.path, 'reset', '--hard', head);
  });
  test('all panel writes honor active-work and exclusive-workspace barriers', async () => {
    const writes = [
      ['/stage', { file: '.' }],
      ['/commit', { message: 'Blocked' }],
      ['/merge', { branch: 'main' }],
      ['/push', {}],
      ['/pull', {}],
      ['/remote', { url: 'https://github.com/owner/repo.git' }],
    ] as const;
    for (const barrier of ['manager', 'process', 'tool']) {
      managerBusy = barrier === 'manager';
      processBusy = barrier === 'process';
      const lease = barrier === 'tool' ? tryAcquireWorkspaceOperation(a.id)! : undefined;
      try {
        for (const [path, body] of writes)
          expect((await app.handle(request(path, a.id, body))).status).toBe(409);
      } finally {
        managerBusy = processBusy = false;
        lease?.release();
      }
    }
    expect(git(a.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(a.path, 'remote')).toBe('');
  });
  test('resolves repository-relative files for a chat opened in a project subfolder', async () => {
    const workspace = await createSessionWorkspace(join(source, 'nested'), {
      branch: 'subfolder-chat',
      storageRoot: join(root, 'chats'),
    });
    const session = await sessions.create(
      'local-user',
      'Subfolder',
      undefined,
      join(source, 'nested'),
      workspace,
    );
    writeFileSync(join(workspace.path, 'new.ts'), 'subfolder edit');
    const status = await (await app.handle(request('/status', session.id))).json();
    expect(status.data.status.some((file: { path: string }) => file.path === 'nested/new.ts')).toBe(
      true,
    );
    expect(
      (await app.handle(request('/stage', session.id, { file: 'nested/new.ts' }))).status,
    ).toBe(200);
    const content = await (
      await app.handle(request('/file?path=nested%2Fnew.ts', session.id))
    ).json();
    expect(content.data.content).toBe('subfolder edit');
    expect(
      (await app.handle(request('/commit', session.id, { message: 'Subfolder commit' }))).status,
    ).toBe(200);
    expect(git(workspace.path, 'log', '-1', '--format=%s')).toBe('Subfolder commit');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  });
  test('refuses active manager/process/parallel tool mutations and releases barriers', async () => {
    managerBusy = true;
    expect(
      (await app.handle(request('/chat/switch', a.id, payload('blocked-manager', 'chat-a'))))
        .status,
    ).toBe(409);
    managerBusy = false;
    processBusy = true;
    expect(
      (await app.handle(request('/chat/switch', a.id, payload('blocked-process', 'chat-a'))))
        .status,
    ).toBe(409);
    processBusy = false;
    const lease = tryAcquireWorkspaceOperation(a.id)!;
    try {
      expect(
        (await app.handle(request('/chat/switch', a.id, payload('blocked-tool', 'chat-a')))).status,
      ).toBe(409);
    } finally {
      lease.release();
    }
    expect(git(a.path, 'branch', '--show-current')).toBe('chat-a');
    expect(released).toHaveBeenCalled();
  });
  test('switches just the chat, persists selection and leaves origin metadata intact', async () => {
    const response = await app.handle(request('/chat/switch', a.id, payload('selected', 'chat-a')));
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.data.branch).toBe('selected');
    const session = await sessions.get(a.id);
    expect(session?.gitWorkspace?.selection?.branch).toBe('selected');
    expect(session?.gitWorkspace?.branch).toBe('chat-a');
    expect(git(source, 'branch', '--show-current')).toBe('main');
    expect(git(b.path, 'branch', '--show-current')).toBe('chat-b');
  });
  test('manager agent tools use the same guarded service and deny worker/critic or cross-chat paths', async () => {
    const tools = new ToolRegistry();
    registerGitTools(tools);
    for (const role of ['worker', 'critic', 'coder'] as const) {
      const result = await tools.execute(
        { sessionId: a.id, workingDirectory: a.path, callerRole: role },
        { id: role, name: 'git_switch', input: payload('denied', 'selected') },
      );
      expect(result.isError).toBe(true);
    }
    const inspected = await tools.execute(
      { sessionId: a.id, workingDirectory: a.path, callerRole: 'manager' },
      { id: 'read', name: 'git_inspect', input: { action: 'state' } },
    );
    expect(inspected.isError).toBe(false);
    expect(JSON.parse(inspected.output).branch).toBe('selected');
    const wrong = await tools.execute(
      { sessionId: a.id, workingDirectory: b.path, callerRole: 'manager' },
      { id: 'wrong', name: 'git_switch', input: payload('wrong-chat', 'selected') },
    );
    expect(wrong.isError).toBe(true);
    const result = await tools.execute(
      { sessionId: a.id, workingDirectory: a.path, callerRole: 'manager', validateToolInput: true },
      { id: 'switch', name: 'git_switch', input: payload('agent-branch', 'selected') },
    );
    expect(result.isError, result.output).toBe(false);
    expect(git(a.path, 'branch', '--show-current')).toBe('agent-branch');
    expect(git(b.path, 'branch', '--show-current')).toBe('chat-b');
  });
  test('pending change reviews and archived chats cannot switch', async () => {
    await ensurePendingSessionReview({
      sessionId: a.id,
      projectRoot: a.path,
      changes: [],
      rollback: { kind: 'git', baselineHash: head },
    });
    const pending = await app.handle(
      request('/chat/switch', a.id, payload('must-not-switch', 'agent-branch')),
    );
    expect(pending.status).toBe(409);
    expect((await pending.json()).error).toContain('pending change review');
    expect((await app.handle(request('/stage', a.id, { file: '.' }))).status).toBe(409);
    expect((await app.handle(request('/commit', a.id, { message: 'Blocked review' }))).status).toBe(
      409,
    );
    await sessions.archive(b.id);
    expect((await app.handle(request('/chat', b.id))).status).toBe(409);
    expect((await app.handle(request('/stage', b.id, { file: '.' }))).status).toBe(409);
    expect(git(a.path, 'branch', '--show-current')).toBe('agent-branch');
  });

  test('Git inspection is read-only but switching asks in guarded mode and denies in planning interaction', () => {
    const policy = {
      mode: 'guarded' as const,
      autoRunTools: true,
      autoApplySafeFixes: true,
      confirmRiskyActions: true,
      autonomyLimitsEnabled: false,
      approvalThresholdFiles: 10,
      approvalThresholdLines: 100,
      toolAllowlist: [],
      toolBlocklist: [],
      toolAsklist: [],
    };
    expect(decideToolPermission(policy, 'git_inspect').action).toBe('allow');
    expect(decideToolPermission(policy, 'git_switch').action).toBe('ask');
    expect(decideToolPermission({ ...policy, interactionMode: 'plan' }, 'git_switch').action).toBe(
      'deny',
    );
  });
});
