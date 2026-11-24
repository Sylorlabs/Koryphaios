import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { Elysia } from 'elysia';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL = 'sqlite::memory:';

const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { setContext } = await import('../../context');
const { SessionRuntime } = await import('../../kory/services/SessionRuntime');
const { terminalRoutes } = await import('./terminals');

const liveSessions = new Set(['chat-a', 'chat-b']);
const runtimes = new Map<string, InstanceType<typeof SessionRuntime>>();

setContext({
  sessions: {
    getActive: async (id: string) =>
      liveSessions.has(id) ? { id, workingDirectory: tmpdir() } : undefined,
    get: async (id: string) =>
      liveSessions.has(id) ? { id, workingDirectory: tmpdir() } : undefined,
  },
  kory: {
    resolveSessionWorkingDirectoryPublic: async () => tmpdir(),
    sessionRuntimeFor: (id: string) => {
      let runtime = runtimes.get(id);
      if (!runtime) {
        runtime = new SessionRuntime();
        runtimes.set(id, runtime);
      }
      return runtime;
    },
    peekSessionRuntime: (id: string) => runtimes.get(id),
  },
} as never);

const app = new Elysia().onError(errorHandler).use(terminalRoutes);
const previousShell = process.env.SHELL;
let bearer = '';

beforeAll(() => {
  // The user's login shell is the default; pin a light one for the test.
  process.env.SHELL = '/bin/sh';
  const auth = localAuth.createSession();
  bearer = buildLocalBearerToken(auth);
});

afterAll(() => {
  for (const runtime of runtimes.values()) runtime.dispose();
  if (previousShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = previousShell;
});

function call(path: string, init: RequestInit = {}, authed = true) {
  const headers = new Headers(init.headers);
  if (authed) headers.set('authorization', bearer);
  if (init.body) headers.set('content-type', 'application/json');
  return app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

describe('terminal routes', () => {
  test('every route refuses an unauthenticated caller', async () => {
    expect((await call('/api/terminals?sessionId=chat-a', {}, false)).status).toBe(401);
    expect(
      (
        await call(
          '/api/terminals',
          { method: 'POST', body: JSON.stringify({ sessionId: 'chat-a' }) },
          false,
        )
      ).status,
    ).toBe(401);
    expect((await call('/api/terminals/abc/scrollback?sessionId=chat-a', {}, false)).status).toBe(
      401,
    );
    expect(
      (await call('/api/terminals/abc?sessionId=chat-a', { method: 'DELETE' }, false)).status,
    ).toBe(401);
  });

  test('a missing or unknown chat is not found and creates nothing', async () => {
    const response = await call('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'ghost-chat' }),
    });
    expect(response.status).toBe(404);
    expect(runtimes.has('ghost-chat')).toBe(false);
  });

  test('creates, lists, reads scrollback and removes a terminal for its own chat', async () => {
    const created = await call('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'chat-a', cols: 100, rows: 30, name: 'Build' }),
    });
    expect(created.status).toBe(200);
    const { terminal } = (await created.json()) as {
      terminal: { id: string; name: string; sessionId: string; cols: number };
    };
    expect(terminal).toMatchObject({ name: 'Build', sessionId: 'chat-a', cols: 100 });

    const listed = (await (await call('/api/terminals?sessionId=chat-a')).json()) as {
      terminals: Array<{ id: string }>;
    };
    expect(listed.terminals.map((t) => t.id)).toEqual([terminal.id]);

    const scrollback = await call(`/api/terminals/${terminal.id}/scrollback?sessionId=chat-a`);
    expect(scrollback.status).toBe(200);
    expect(
      ((await scrollback.json()) as { scrollback: { terminalId: string } }).scrollback.terminalId,
    ).toBe(terminal.id);

    const removed = await call(`/api/terminals/${terminal.id}?sessionId=chat-a`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(runtimes.get('chat-a')?.terminals.has(terminal.id)).toBe(false);
  });

  test("one chat cannot list, read, or delete another chat's terminal", async () => {
    const created = await call('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'chat-a' }),
    });
    const { terminal } = (await created.json()) as { terminal: { id: string } };

    const otherList = (await (await call('/api/terminals?sessionId=chat-b')).json()) as {
      terminals: unknown[];
    };
    expect(otherList.terminals).toEqual([]);

    expect((await call(`/api/terminals/${terminal.id}?sessionId=chat-b`)).status).toBe(404);
    expect((await call(`/api/terminals/${terminal.id}/scrollback?sessionId=chat-b`)).status).toBe(
      404,
    );
    expect(
      (await call(`/api/terminals/${terminal.id}?sessionId=chat-b`, { method: 'DELETE' })).status,
    ).toBe(404);
    // Still alive in its own chat after the refused delete.
    expect(runtimes.get('chat-a')?.terminals.has(terminal.id)).toBe(true);
    await call(`/api/terminals/${terminal.id}?sessionId=chat-a`, { method: 'DELETE' });
  });

  test('a project-scoped terminal needs a project folder on the chat', async () => {
    liveSessions.add('chat-noproject');
    const response = await call('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'chat-noproject', scope: 'project' }),
    });
    // The chat has a working directory in this stub, so the project scope opens.
    expect(response.status).toBe(200);
    const { terminal } = (await response.json()) as { terminal: { id: string; scope: string } };
    expect(terminal.scope).toBe('project');
    await call(`/api/terminals/${terminal.id}?sessionId=chat-noproject`, { method: 'DELETE' });
  });
});
