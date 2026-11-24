import { describe, expect, test } from 'bun:test';
import type { SessionRunSnapshot } from '@koryphaios/shared';

process.env.NODE_ENV = 'test';

const { createRunRoutes } = await import('../runs');
const { localAuth } = await import('../../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../../auth/local-route-auth');

function snapshot(
  sessionId: string,
  status: SessionRunSnapshot['status'],
  activeAgentIds: string[],
): SessionRunSnapshot {
  return {
    sessionId,
    runId: `run-${sessionId}`,
    revision: 1,
    phase: status === 'active' ? 'streaming' : 'waiting_user',
    status,
    waitingReason: '',
    continuationId: null,
    activeAgentIds,
    startedAt: 1,
    updatedAt: 1,
    finishedAt: null,
    terminalReason: null,
  };
}

const runs: SessionRunSnapshot[] = [
  snapshot('a', 'active', ['kory-manager', 'worker-1', 'worker-2']),
  snapshot('b', 'active', ['kory-manager']),
  snapshot('c', 'waiting', ['kory-manager']),
  snapshot('d', 'idle', []),
  snapshot('e', 'terminal', ['kory-manager']),
];

const routes = createRunRoutes(() => ({ listActive: () => runs.filter((r) => r.status === 'active') }));

function get(headers: Record<string, string> = {}) {
  return routes.handle(
    new Request('http://localhost/api/runs/active-count', { headers }),
  );
}

describe('GET /api/runs/active-count', () => {
  test('rejects unauthenticated callers', async () => {
    const response = await get();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Unauthorized' });
  });

  test('rejects a forged bearer token', async () => {
    const response = await get({ Authorization: 'Bearer not-a-session:not-a-signature' });
    expect(response.status).toBe(401);
  });

  test('counts only active runs and the agents they have in flight', async () => {
    const token = buildLocalBearerToken(localAuth.createSession(['*']));
    const response = await get({ Authorization: token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { runs: 2, agents: 4 } });
  });

  test('reports zero when nothing is running', async () => {
    const idle = createRunRoutes(() => ({ listActive: () => [] }));
    const token = buildLocalBearerToken(localAuth.createSession(['*']));
    const response = await idle.handle(
      new Request('http://localhost/api/runs/active-count', { headers: { Authorization: token } }),
    );
    expect(await response.json()).toEqual({ ok: true, data: { runs: 0, agents: 0 } });
  });
});

describe('summarizeActiveWork', () => {
  test('never counts waiting, idle or terminal runs', async () => {
    const { summarizeActiveWork } = await import('../../../runs/active-work');
    expect(summarizeActiveWork(runs.filter((r) => r.status !== 'active'))).toEqual({
      runs: 0,
      agents: 0,
    });
  });

  test('a run with an empty agent list still counts as one agent', async () => {
    const { summarizeActiveWork } = await import('../../../runs/active-work');
    expect(summarizeActiveWork([snapshot('x', 'active', [])])).toEqual({ runs: 1, agents: 1 });
  });
});
