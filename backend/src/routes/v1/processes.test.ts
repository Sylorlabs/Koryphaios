import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL = 'sqlite::memory:';

const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { processSupervisor } = await import('../../process-supervisor/supervisor');
const processDatabase = await import('../../process-supervisor/database');
const { setContext } = await import('../../context');
const { processRoutes } = await import('./processes');

setContext({
  sessions: {
    getActive: async (sessionId: string) => ({ id: sessionId }),
    get: async (sessionId: string) => ({ id: sessionId }),
  },
  kory: {
    hasActiveSessionExecution: () => true,
    tryAcquireSessionMutationBarrier: () => null,
  },
} as never);

const app = new Elysia().onError(errorHandler).use(processRoutes);

describe('process route cancellation truth', () => {
  test('returns conflict rather than not-found when failed termination retains a live process', async () => {
    const originalGetProcess = processSupervisor.getProcess;
    const originalKillProcess = processSupervisor.killProcess;
    const auth = localAuth.createSession();
    try {
      processSupervisor.getProcess = ((id: string) =>
        id === 'retained-process' ? ({ id } as never) : undefined) as typeof originalGetProcess;
      processSupervisor.killProcess = (async () => false) as typeof originalKillProcess;

      const response = await app.handle(
        new Request('http://localhost/api/processes/retained-process?signal=SIGTERM', {
          method: 'DELETE',
          headers: { authorization: buildLocalBearerToken(auth) },
        }),
      );
      const body = (await response.json()) as { code?: string; error?: string };

      expect(response.status).toBe(409);
      expect(body.code).toBe('CONFLICT');
      expect(body.error).toContain('remains monitored as active/degraded');
    } finally {
      processSupervisor.getProcess = originalGetProcess;
      processSupervisor.killProcess = originalKillProcess;
      localAuth.revokeSession(auth.sessionId);
    }
  });

  test('returns conflict rather than not-found when restart retains the existing process', async () => {
    const originalGetProcess = processSupervisor.getProcess;
    const originalRestartProcess = processSupervisor.restartProcess;
    const auth = localAuth.createSession();
    try {
      processSupervisor.getProcess = ((id: string) =>
        id === 'retained-restart'
          ? ({ id, sessionId: 'retained-restart-session' } as never)
          : undefined) as typeof originalGetProcess;
      processSupervisor.restartProcess = (async () => null) as typeof originalRestartProcess;

      const response = await app.handle(
        new Request('http://localhost/api/processes/retained-restart/restart', {
          method: 'POST',
          headers: { authorization: buildLocalBearerToken(auth) },
        }),
      );
      const body = (await response.json()) as { code?: string; error?: string };

      expect(response.status).toBe(409);
      expect(body.code).toBe('CONFLICT');
      expect(body.error).toContain('existing process remains active/degraded');
    } finally {
      processSupervisor.getProcess = originalGetProcess;
      processSupervisor.restartProcess = originalRestartProcess;
      localAuth.revokeSession(auth.sessionId);
    }
  });

  test('truthfully refuses replay when the durable command was redacted', async () => {
    const auth = localAuth.createSession();
    const now = Date.now();
    const id = `redacted-restart-${now}`;
    try {
      await processDatabase.persistProcess({
        id,
        name: 'redacted restart',
        command: 'API_KEY=sk-proj-SYNTHETICPROCESSSECRET1234567890; printf done',
        cwd: process.cwd(),
        pid: 0,
        sessionId: `redacted-restart-session-${now}`,
        status: 'exited',
        provenance: 'agent-tool',
        supervision: 'owned-child',
        isBackground: true,
        restartCount: 0,
        maxRestarts: 0,
        restartPolicy: 'never',
        createdAt: now,
        updatedAt: now,
        endedAt: now,
      });

      const response = await app.handle(
        new Request(`http://localhost/api/processes/${id}/restart`, {
          method: 'POST',
          headers: { authorization: buildLocalBearerToken(auth) },
        }),
      );
      const body = (await response.json()) as { code?: string; error?: string };

      expect(response.status).toBe(409);
      expect(body.code).toBe('CONFLICT');
      expect(body.error).toContain('durable command was redacted or truncated');
    } finally {
      localAuth.revokeSession(auth.sessionId);
    }
  });
});
