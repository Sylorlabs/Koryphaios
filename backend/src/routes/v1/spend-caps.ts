import { Elysia, t } from 'elysia';
import {
  getEnforcedCaps,
  setEnforcedCaps,
  checkAndEnforceCaps,
  isSessionPaused,
  getSessionPauseRecord,
  getAllPausedSessions,
  resumeSession,
  getPauseHistory,
} from '../../security/spend-caps-enforced';
import { getSessionUsage, getGlobalSpendStats } from '../../security/spend-caps';
import { serverLog } from '../../logger';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const spendCapsRoutes = new Elysia({ prefix: '/api/spend-caps' })
  .get('/config', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const config = await getEnforcedCaps();
    return { ok: true, config };
  })
  .put(
    '/config',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const updated = await setEnforcedCaps(body as any);
        serverLog.info({ updates: body }, 'Spend caps updated via API');
        return { ok: true, config: updated };
      } catch (err) {
        set.status = 400;
        serverLog.error({ err }, 'Failed to update spend caps');
        return { ok: false, error: 'Failed to update spend caps' };
      }
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        sessionHourlyCents: t.Optional(t.Number()),
        sessionDailyCents: t.Optional(t.Number()),
        globalHourlyCents: t.Optional(t.Number()),
        globalDailyCents: t.Optional(t.Number()),
        perRequestCents: t.Optional(t.Number()),
        action: t.Optional(t.Enum({ pause: 'pause', warn: 'warn', block: 'block' })),
        notifyAtPercent: t.Optional(t.Array(t.Number())),
      }),
    },
  )
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const caps = await getEnforcedCaps();
    const globalStats = {
      hour: await getGlobalSpendStats('hour'),
      day: await getGlobalSpendStats('day'),
      month: await getGlobalSpendStats('month'),
    };
    const pausedSessions = getAllPausedSessions();

    return {
      ok: true,
      caps,
      globalStats,
      pausedSessions,
      isEnforcing: caps.enabled,
    };
  })
  .get('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const usage = await getSessionUsage(id);
    const isPaused = isSessionPaused(id);
    const pauseRecord = isPaused ? getSessionPauseRecord(id) : null;

    return {
      ok: true,
      sessionId: id,
      usage,
      isPaused,
      pauseRecord,
    };
  })
  .post('/sessions/:id/resume', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    if (!isSessionPaused(id)) {
      set.status = 400;
      return { ok: false, error: 'Session is not paused' };
    }

    const success = await resumeSession(id);
    if (success) {
      return { ok: true, message: 'Session resumed successfully', sessionId: id };
    } else {
      set.status = 500;
      return { ok: false, error: 'Failed to resume session' };
    }
  })
  .get(
    '/history',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const history = await getPauseHistory(query.sessionId, query.limit || 100);
      return {
        ok: true,
        history,
        count: history.length,
      };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
        limit: t.Optional(t.Numeric()),
      }),
    },
  )
  .post(
    '/check',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const result = await checkAndEnforceCaps(body.sessionId, body.estimatedCostCents || 0);
        return {
          ok: true,
          canProceed: result.canProceed,
          reason: result.reason,
          isPaused: result.paused,
        };
      } catch (err) {
        set.status = 500;
        serverLog.error({ err }, 'Failed to check spend caps');
        return { ok: false, error: 'Failed to check spend caps' };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        estimatedCostCents: t.Optional(t.Number()),
      }),
    },
  );
