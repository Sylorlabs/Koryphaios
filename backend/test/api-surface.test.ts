import { describe, expect, test } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? `sqlite:///tmp/koryphaios-api-surface.sqlite`;

const { Elysia } = await import('elysia');
const { sessionRoutes } = await import('../src/routes/v1/sessions');
const { messageRoutes } = await import('../src/routes/v1/messages');
const { providerRoutes } = await import('../src/routes/v1/providers');
const { collaborationRoutes } = await import('../src/routes/collaboration');
const { authRoutes } = await import('../src/routes/v1/auth');
const { agentSettingsRoutes } = await import('../src/routes/v1/agent-settings');
const { gitRoutes } = await import('../src/routes/v1/git');
const { memoryRoutes } = await import('../src/routes/v1/memory');
const { modeRoutes } = await import('../src/routes/v1/mode');
const { spendRoutes } = await import('../src/routes/v1/spend');
const { spendCapsRoutes } = await import('../src/routes/v1/spend-caps');
const { billingRoutes } = await import('../src/routes/v1/billing');
const { processRoutes } = await import('../src/routes/v1/processes');

const app = new Elysia()
  .get('/api/health', () => ({
    ok: true,
    data: {
      version: 'test',
      uptime: 0,
    },
  }))
  .get('/api/project', () => ({
    ok: true,
    data: {
      projectName: 'Koryphaios',
    },
  }))
  .post('/api/debug/log-error', () => ({ ok: true }))
  .use(sessionRoutes)
  .use(messageRoutes)
  .use(providerRoutes)
  .use(collaborationRoutes)
  .use(authRoutes)
  .use(agentSettingsRoutes)
  .use(gitRoutes)
  .use(memoryRoutes)
  .use(modeRoutes)
  .use(spendRoutes)
  .use(spendCapsRoutes)
  .use(billingRoutes)
  .use(processRoutes);

type RouteCheck = {
  method: string;
  path: string;
  body?: unknown;
};

const protectedRoutes: RouteCheck[] = [
  { method: 'GET', path: '/api/sessions' },
  { method: 'POST', path: '/api/sessions', body: { title: 'Test Session' } },
  { method: 'GET', path: '/api/sessions/s1' },
  { method: 'PATCH', path: '/api/sessions/s1', body: { title: 'Renamed' } },
  { method: 'DELETE', path: '/api/sessions/s1' },
  { method: 'GET', path: '/api/sessions/s1/processes' },
  { method: 'POST', path: '/api/sessions/s1/cancel' },
  { method: 'GET', path: '/api/messages/s1' },
  { method: 'POST', path: '/api/messages', body: { sessionId: 's1', content: 'Hello' } },
  { method: 'GET', path: '/api/providers' },
  { method: 'GET', path: '/api/providers/status' },
  { method: 'GET', path: '/api/providers/available' },
  { method: 'PUT', path: '/api/providers/openai', body: { apiKey: 'sk-test' } },
  { method: 'POST', path: '/api/providers/openai', body: { apiKey: 'sk-test' } },
  { method: 'POST', path: '/api/providers/openai/rotate', body: { apiKey: 'sk-rotate' } },
  { method: 'GET', path: '/api/providers/openai/accounts' },
  {
    method: 'POST',
    path: '/api/providers/openai/accounts',
    body: { label: 'Primary', apiKey: 'sk-account' },
  },
  { method: 'POST', path: '/api/providers/openai/accounts/account-1/activate' },
  { method: 'DELETE', path: '/api/providers/openai/accounts/account-1' },
  { method: 'DELETE', path: '/api/providers/openai' },
  { method: 'POST', path: '/api/collab/s1/start', body: { ownerId: 'local-user' } },
  {
    method: 'POST',
    path: '/api/collab/join',
    body: { joinCode: 'ABC123', userId: 'u1', name: 'User' },
  },
  { method: 'GET', path: '/api/collab/s1/state' },
  { method: 'POST', path: '/api/collab/s1/end' },
  { method: 'DELETE', path: '/api/auth/session' },
  { method: 'GET', path: '/api/agent/threads/s1' },
  { method: 'GET', path: '/api/agent/a1/thread?sessionId=s1' },
  { method: 'POST', path: '/api/agent/a1/message', body: { sessionId: 's1', content: 'ping' } },
  { method: 'POST', path: '/api/agent/a1/cancel' },
  { method: 'GET', path: '/api/agent/settings' },
  { method: 'PUT', path: '/api/agent/settings', body: { criticGateEnabled: true } },
  { method: 'POST', path: '/api/agent/settings/reset' },
  { method: 'GET', path: '/api/agent/preferences' },
  { method: 'PUT', path: '/api/agent/preferences', body: { content: 'Be concise' } },
  { method: 'POST', path: '/api/agent/preferences/init' },
  { method: 'GET', path: '/api/agent/context' },
  {
    method: 'POST',
    path: '/api/agent/enforce',
    body: { code: 'const x = 1;', filePath: 'src/app.ts' },
  },
  {
    method: 'POST',
    path: '/api/agent/critic-review',
    body: { code: 'const x = 1;', filePath: 'src/app.ts', changeDescription: 'Test change' },
  },
  { method: 'GET', path: '/api/agent/stats' },
  { method: 'GET', path: '/api/agent/defaults' },
  { method: 'GET', path: '/api/git/repo' },
  { method: 'GET', path: '/api/git/status' },
  { method: 'GET', path: '/api/git/diff?file=src%2Fapp.ts' },
  { method: 'GET', path: '/api/git/file?path=src%2Fapp.ts' },
  { method: 'POST', path: '/api/git/stage', body: { file: 'src/app.ts' } },
  { method: 'POST', path: '/api/git/restore', body: { file: 'src/app.ts' } },
  { method: 'POST', path: '/api/git/commit', body: { message: 'Test commit' } },
  { method: 'GET', path: '/api/git/branches' },
  { method: 'POST', path: '/api/git/checkout', body: { branch: 'feature/test' } },
  { method: 'POST', path: '/api/git/merge', body: { branch: 'main' } },
  { method: 'POST', path: '/api/git/push' },
  { method: 'POST', path: '/api/git/pull' },
  { method: 'GET', path: '/api/memory/universal' },
  { method: 'PUT', path: '/api/memory/universal', body: { content: 'Universal memory' } },
  { method: 'POST', path: '/api/memory/universal/init' },
  { method: 'GET', path: '/api/memory/project' },
  { method: 'PUT', path: '/api/memory/project', body: { content: 'Project memory' } },
  { method: 'POST', path: '/api/memory/project/init' },
  { method: 'GET', path: '/api/memory/sessions/s1' },
  { method: 'PUT', path: '/api/memory/sessions/s1', body: { content: 'Session memory' } },
  { method: 'POST', path: '/api/memory/sessions/s1/init' },
  { method: 'DELETE', path: '/api/memory/sessions/s1' },
  { method: 'GET', path: '/api/memory/rules' },
  { method: 'PUT', path: '/api/memory/rules', body: { content: 'Rule 1' } },
  { method: 'POST', path: '/api/memory/rules/init' },
  { method: 'GET', path: '/api/memory/settings' },
  { method: 'PUT', path: '/api/memory/settings', body: { sessionMemoryEnabled: true } },
  { method: 'POST', path: '/api/memory/settings/reset' },
  { method: 'GET', path: '/api/memory/context?sessionId=s1' },
  { method: 'GET', path: '/api/memory/stats?sessionId=s1' },
  { method: 'GET', path: '/api/mode' },
  { method: 'PUT', path: '/api/mode', body: { mode: 'advanced' } },
  { method: 'POST', path: '/api/mode/toggle' },
  { method: 'GET', path: '/api/spend/status?sessionId=s1' },
  { method: 'POST', path: '/api/spend/reset-session', body: { sessionId: 's1' } },
  { method: 'GET', path: '/api/spend-caps/config' },
  { method: 'PUT', path: '/api/spend-caps/config', body: { enabled: true } },
  { method: 'GET', path: '/api/spend-caps/status' },
  { method: 'GET', path: '/api/spend-caps/sessions/s1' },
  { method: 'POST', path: '/api/spend-caps/sessions/s1/resume' },
  { method: 'GET', path: '/api/spend-caps/history?limit=5' },
  {
    method: 'POST',
    path: '/api/spend-caps/check',
    body: { sessionId: 's1', estimatedCostCents: 1 },
  },
  { method: 'GET', path: '/api/billing/credits' },
  { method: 'GET', path: '/api/processes?includeInactive=true&limit=100' },
  {
    method: 'POST',
    path: '/api/processes',
    body: { name: 'Test Process', command: 'echo ok', sessionId: 's1' },
  },
  { method: 'POST', path: '/api/processes/cleanup', body: { daysToKeep: 7 } },
  { method: 'GET', path: '/api/processes/p1' },
  { method: 'DELETE', path: '/api/processes/p1?signal=SIGTERM' },
  { method: 'POST', path: '/api/processes/p1/restart' },
  { method: 'GET', path: '/api/processes/p1/logs?lines=100' },
  { method: 'GET', path: '/api/processes/p1/events?limit=50' },
];

async function jsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function request(check: RouteCheck): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${check.path}`, {
      method: check.method,
      headers: check.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: check.body !== undefined ? JSON.stringify(check.body) : undefined,
    }),
  );
}

describe('API surface verification', () => {
  test('public endpoints respond successfully', async () => {
    const health = await request({ method: 'GET', path: '/api/health' });
    const project = await request({ method: 'GET', path: '/api/project' });
    const debug = await request({ method: 'POST', path: '/api/debug/log-error' });
    const me = await request({ method: 'GET', path: '/api/auth/me' });
    const status = await request({ method: 'GET', path: '/api/auth/status' });
    const session = await request({ method: 'POST', path: '/api/auth/session' });

    expect(health.status).toBe(200);
    expect(project.status).toBe(200);
    expect(debug.status).toBe(200);
    expect(me.status).toBe(200);
    expect(status.status).toBe(200);
    expect(session.status).toBe(200);
  });

  test('every protected live endpoint rejects missing auth with 401', async () => {
    for (const check of protectedRoutes) {
      const response = await request(check);
      const body = await jsonResponse(response);

      expect(response.status).toBe(401);
      expect(body).toEqual({ ok: false, error: 'Unauthorized' });
    }
  });
});
