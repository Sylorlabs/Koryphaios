import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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

beforeAll(async () => {
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
  setContext({
    sessions: { get: async (id: string) => (boundaries.has(id) ? { id } : undefined) },
    messages: {
      getActiveBoundary: async (id: string) => boundaries.get(id),
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
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: 'cx_0', isError: true });
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
