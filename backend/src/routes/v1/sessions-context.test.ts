import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isolatedRoot = mkdtempSync(join(tmpdir(), 'kory-session-context-route-'));
process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL = `sqlite://${join(isolatedRoot, 'sessions-context.sqlite')}`;

const { Elysia } = await import('elysia');
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { setContext } = await import('../../context');
const { initContextArchive } = await import('../../kory/context-archive');
const { errorHandler } = await import('../../middleware/error-handling');
const { sessionRoutes } = await import('./sessions');

const app = new Elysia().onError(errorHandler).use(sessionRoutes);
let authorization = '';
const boundaries = new Map([
  ['session-1', { messageId: null, contextRevision: 0 }],
  ['usage-match', { messageId: 'assistant-final', contextRevision: 3 }],
  ['usage-mismatch', { messageId: 'user-new', contextRevision: 3 }],
]);
const listMcpServers = mock(() => [{ name: 'live_server' }]);
const getMcpClient = mock((name: string) =>
  name === 'live_server'
    ? { availableTools: [{ name: 'lookup', description: 'private description', inputSchema: {} }] }
    : undefined,
);

beforeAll(async () => {
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
  writeFileSync(
    join(isolatedRoot, 'koryphaios.json'),
    JSON.stringify({
      mcpServers: {
        Registered_team: {
          type: 'sse',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'synthetic-secret' },
        },
      },
    }),
  );
  setContext({
    sessions: {
      get: async (id: string) =>
        boundaries.has(id)
          ? {
              id,
              workingDirectory: join(isolatedRoot, 'disposable-checkout'),
              gitWorkspace: { repositoryPath: isolatedRoot },
            }
          : undefined,
    },
    mcpManager: { listServers: listMcpServers, getClient: getMcpClient },
    messages: {
      getActiveBoundary: async (id: string) => boundaries.get(id),
      // The context route reads the turn provider from recent messages to
      // surface provider-injected MCP identities (the kory bridge). The
      // fixture sessions use no messages, so an empty list is the contract.
      getRecent: async () => [],
    },
  } as never);
  const archive = initContextArchive(isolatedRoot);
  await archive.record(
    'session-1',
    'tool_result',
    'bash failing-command',
    'command failed with exit code 1',
    true,
  );
  await archive.record(
    'session-1',
    'tool_result',
    'bash provenance',
    'run-owned output',
    false,
    undefined,
    { sessionId: 'session-1', runId: 'run-1', revision: 3 },
  );
  await archive.recordUsage('usage-match', {
    used: 63_000,
    max: 128_000,
    contextKnown: true,
    model: 'gpt-5',
    provider: 'openai',
    activeMessageId: 'assistant-final',
    contextRevision: 3,
    ts: 123,
  });
  await archive.recordUsage('usage-mismatch', {
    used: 42_000,
    max: 128_000,
    contextKnown: true,
    model: 'gpt-5',
    provider: 'openai',
    activeMessageId: 'assistant-old',
    contextRevision: 3,
    ts: 124,
  });
});

afterAll(() => {
  localAuth.dispose();
  rmSync(isolatedRoot, { recursive: true, force: true });
});

describe('session context archive route', () => {
  test('returns only registered display identities from the source project without connecting', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/sessions/session-1/context', {
        headers: { authorization },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mcpServers).toEqual([
      { name: 'Registered_team', tools: [] },
      { name: 'live_server', tools: ['lookup'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('synthetic-secret');
    expect(JSON.stringify(body)).not.toContain('private description');
    expect(listMcpServers).toHaveBeenCalledWith(realpathSync(isolatedRoot));
    expect(getMcpClient).toHaveBeenCalledWith('live_server', realpathSync(isolatedRoot));
  });

  test('returns the archived tool failure bit', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/sessions/session-1/context', {
        headers: { authorization },
      }),
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ id: string; isError?: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'cx_0', isError: true });
    expect(body.data[1]).toMatchObject({
      id: 'cx_1',
      runRef: { sessionId: 'session-1', runId: 'run-1', revision: 3 },
    });
  });

  test('sends only the archived activity inside the requested window', async () => {
    const { getContextArchive } = await import('../../kory/context-archive');
    const entries = await getContextArchive()!.listRecent('session-1');
    const cutoff = entries[entries.length - 1].ts;
    const windowed = await app.handle(
      new Request(`http://localhost/api/sessions/session-1/context?since=${cutoff}`, {
        headers: { authorization },
      }),
    );
    const body = (await windowed.json()) as { data: Array<{ id: string; ts: number }> };

    expect(windowed.status).toBe(200);
    expect(body.data.map((entry) => entry.id)).toEqual(
      entries.filter((entry) => entry.ts >= cutoff).map((entry) => entry.id),
    );
    expect(body.data.every((entry) => entry.ts >= cutoff)).toBe(true);

    const future = await app.handle(
      new Request(`http://localhost/api/sessions/session-1/context?since=${Date.now() + 60_000}`, {
        headers: { authorization },
      }),
    );
    expect(((await future.json()) as { data: unknown[] }).data).toEqual([]);
  });

  test('seeds usage only for the exact active conversation boundary', async () => {
    const matchingResponse = await app.handle(
      new Request('http://localhost/api/sessions/usage-match/context', {
        headers: { authorization },
      }),
    );
    const mismatchingResponse = await app.handle(
      new Request('http://localhost/api/sessions/usage-mismatch/context', {
        headers: { authorization },
      }),
    );
    const matching = (await matchingResponse.json()) as { lastUsage: unknown };
    const mismatching = (await mismatchingResponse.json()) as { lastUsage: unknown };

    expect(matchingResponse.status).toBe(200);
    expect(matching.lastUsage).toMatchObject({
      used: 63_000,
      activeMessageId: 'assistant-final',
      contextRevision: 3,
    });
    expect(mismatchingResponse.status).toBe(200);
    expect(mismatching.lastUsage).toBeNull();
  });

  test('rechecks archive state only after acquiring the visibility mutation barrier', async () => {
    const order: string[] = [];
    const release = mock(() => undefined);
    setContext({
      sessions: {
        get: async () => {
          order.push('active-check');
          return { id: 'session-1', archivedAt: 1_000 };
        },
      },
      kory: {
        tryAcquireSessionMutationBarrier: () => {
          order.push('barrier');
          return { release };
        },
      },
    } as never);

    const response = await app.handle(
      new Request('http://localhost/api/sessions/session-1/context/cx_0/visibility', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ hiddenFromAgent: true }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'Recover this archived chat before changing or continuing its work.',
    });
    expect(order).toEqual(['barrier', 'active-check']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
