import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { setContext } from '../../context';
import { errorHandler } from '../../middleware/error-handling';
import { sessionRoutes } from './sessions';

const SESSION_ID = 'cancel-chat';
const app = new Elysia().onError(errorHandler).use(sessionRoutes);
let authorization = '';
let cancelledWith: string[] = [];
let broadcasts: Array<{ type: string; payload: unknown; sessionId: string }> = [];

beforeAll(() => {
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});
afterAll(() => localAuth.dispose());

beforeEach(() => {
  cancelledWith = [];
  broadcasts = [];
  setContext({
    kory: {
      cancelSessionWorkers: async (id: string) => {
        cancelledWith.push(id);
      },
    },
    goalDriver: { pauseForSession: async () => undefined },
    wsManager: {
      broadcastToSession: (sessionId: string, event: { type: string; payload: unknown }) => {
        broadcasts.push({ ...event, sessionId });
      },
    },
  } as never);
});

function cancel(body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/sessions/${SESSION_ID}/cancel`, {
      method: 'POST',
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe('session cancel route', () => {
  test('a plain cancel hard-stops the workers and announces the cancellation', async () => {
    const response = await cancel();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'Session cancelled' });
    expect(cancelledWith).toEqual([SESSION_ID]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'system.info',
      sessionId: SESSION_ID,
      payload: { message: 'Session cancelled' },
    });
  });

  test('a legacy purpose "steer" is accepted as a plain cancel, never a cancel-and-continue handoff', async () => {
    const response = await cancel({ purpose: 'steer' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: 'Session cancelled' });
    expect(cancelledWith).toEqual([SESSION_ID]);
    expect(broadcasts.map((event) => event.payload)).toEqual([{ message: 'Session cancelled' }]);
  });

  test('an unknown purpose is rejected before any worker is touched', async () => {
    const response = await cancel({ purpose: 'pause' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cancelledWith).toEqual([]);
  });
});
