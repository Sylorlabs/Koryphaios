import { Elysia, t } from 'elysia';
import {
  getSessionUsage,
  getGlobalSpendStats,
  getSpendCaps,
  resetSessionUsage,
  checkSpendCaps,
  checkGlobalSpendCaps,
  formatCost,
} from '../../security/spend-caps';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const spendRoutes = new Elysia({ prefix: '/api/spend' })
  .get(
    '/status',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const sessionId = query.sessionId;

      const caps = getSpendCaps();
      const globalCheck = await checkGlobalSpendCaps();
      const dailyStats = await getGlobalSpendStats('day');
      const monthlyStats = await getGlobalSpendStats('month');

      let sessionUsage = null;
      let sessionCheck = null;

      if (sessionId) {
        sessionUsage = await getSessionUsage(sessionId);
        sessionCheck = await checkSpendCaps(sessionId, caps);
      }

      return {
        ok: true,
        data: {
          caps: {
            hourly: caps.hourlyCapCents ? formatCost(caps.hourlyCapCents) : null,
            daily: caps.dailyCapCents ? formatCost(caps.dailyCapCents) : null,
            monthly: caps.monthlyCapCents ? formatCost(caps.monthlyCapCents) : null,
            maxSessionLength: caps.maxSessionLengthMs,
            maxTokensPerHour: caps.maxTokensPerHour,
            maxCommandsPerHour: caps.maxCommandsPerHour,
          },
          global: {
            daily: {
              spent: formatCost(dailyStats.totalCostCents),
              tokens: dailyStats.totalTokens,
              commands: dailyStats.totalCommands,
              activeSessions: dailyStats.activeSessions,
            },
            monthly: {
              spent: formatCost(monthlyStats.totalCostCents),
              tokens: monthlyStats.totalTokens,
              commands: monthlyStats.totalCommands,
              activeSessions: monthlyStats.activeSessions,
            },
            allowed: globalCheck.allowed,
            reason: globalCheck.reason,
          },
          session: sessionUsage
            ? {
                spent: formatCost(sessionUsage.totalCost),
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                totalTokens: sessionUsage.inputTokens + sessionUsage.outputTokens,
                commands: sessionUsage.commandCount,
                duration: Date.now() - sessionUsage.startTime,
                allowed: sessionCheck?.allowed,
                reason: sessionCheck?.reason,
              }
            : null,
        },
      };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/reset-session',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      resetSessionUsage(body.sessionId);
      return {
        ok: true,
        message: `Session ${body.sessionId} usage reset`,
      };
    },
    {
      body: t.Object({
        sessionId: t.String(),
      }),
    },
  );
