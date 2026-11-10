import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createIdleSessionRun } from '@koryphaios/shared';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { setContext } from '../../context';
import { errorHandler } from '../../middleware/error-handling';
import { sessionRoutes } from './sessions';

const notices: unknown[] = [];
const chat = { id: 'activity-chat', title: 'Activity fixture', workingDirectory: '/synthetic-project' };
const failed = { ...createIdleSessionRun(chat.id), revision: 3, phase: 'error', status: 'terminal' };
const app = new Elysia().onError(errorHandler).use(sessionRoutes);
let authorization = '';

beforeAll(() => {
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
  setContext({
    sessions: { listActive: async () => [chat], create: async () => chat },
    runs: { store: { getOrIdle: () => failed } },
    wsManager: { broadcastEphemeral: (notice: unknown) => notices.push(notice) },
  } as never);
});
afterAll(() => localAuth.dispose());

describe('sidebar activity projection', () => {
  test('authenticates the list and returns durable failed outcomes for unvisited chats', async () => {
    const unauthorized = await app.handle(new Request('http://localhost/api/sessions'));
    expect(unauthorized.status).toBe(401);
    const response = await app.handle(new Request('http://localhost/api/sessions', {
      headers: { authorization },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: [chat], runStates: [failed] });
  });

  test('announces creation to other windows without recording transcript events', async () => {
    const response = await app.handle(new Request('http://localhost/api/sessions', {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ title: chat.title, workingDirectory: chat.workingDirectory }),
    }));
    expect(response.status).toBe(200);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'session.updated', sessionId: chat.id, payload: { session: chat } });
  });
});
