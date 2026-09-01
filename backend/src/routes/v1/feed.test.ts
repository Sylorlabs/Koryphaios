import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { setContext } from '../../context';
import { db, initDb, sessions } from '../../db';
import { errorHandler } from '../../middleware/error-handling';
import { sessionRoutes } from './sessions';
import { feedRoutes } from './feed';

const sessionId = `feed-route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const app = new Elysia().onError(errorHandler).use(sessionRoutes).use(feedRoutes);
let authorization = '';

beforeAll(async () => {
  await initDb();
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Feed route test',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  setContext({
    sessions: { get: async (id: string) => (id === sessionId ? { id } : undefined) },
  } as never);
});

afterAll(async () => {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  localAuth.dispose();
});

describe('durable feed routes', () => {
  test('accepts only explicit client errors and exact visibility state, then replays both', async () => {
    const post = await app.handle(
      new Request(`http://localhost/api/sessions/${sessionId}/feed/client-errors`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'client-error-route-1',
          text: 'The UI could not restore one selected view.',
        }),
      }),
    );
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true });

    const visibility = await app.handle(
      new Request(`http://localhost/api/sessions/${sessionId}/feed/visibility`, {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          targets: ['event:3:8:10', 'thread:thread_1'],
          visibility: 'deleted',
        }),
      }),
    );
    expect(visibility.status).toBe(200);

    const replay = await app.handle(
      new Request(`http://localhost/api/sessions/${sessionId}/feed`, {
        headers: { authorization },
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      data: {
        entries: [
          {
            id: 'client-error-route-1',
            kind: 'client_error',
            text: 'The UI could not restore one selected view.',
            timestamp: expect.any(Number),
          },
        ],
        tombstones: expect.arrayContaining([
          { targetKey: 'event:3:8:10', visibility: 'deleted' },
          { targetKey: 'thread:thread_1', visibility: 'deleted' },
        ]),
      },
    });
  });
});
