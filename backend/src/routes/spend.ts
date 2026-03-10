// Spend status and quota management routes

import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import {
  getSessionUsage,
  getGlobalSpendStats,
  getSpendCaps,
  resetSessionUsage,
  checkSpendCaps,
  checkGlobalSpendCaps,
  formatCost,
  type SessionUsage,
} from "../security/spend-caps";

export function createSpendRoutes(): RouteHandler[] {
  return [
    // GET /api/spend/status - Get current spend status
    {
      path: "/api/spend/status",
      method: "GET",
      handler: async (req) => {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get("sessionId");

        const caps = getSpendCaps();
        const globalCheck = checkGlobalSpendCaps();
        const dailyStats = getGlobalSpendStats("day");
        const monthlyStats = getGlobalSpendStats("month");

        let sessionUsage: SessionUsage | null = null;
        let sessionCheck: ReturnType<typeof checkSpendCaps> | null = null;

        if (sessionId) {
          sessionUsage = getSessionUsage(sessionId);
          sessionCheck = checkSpendCaps(sessionId, caps);
        }

        return json({
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
            session: sessionUsage ? {
              spent: formatCost(sessionUsage.totalCost),
              inputTokens: sessionUsage.inputTokens,
              outputTokens: sessionUsage.outputTokens,
              totalTokens: sessionUsage.inputTokens + sessionUsage.outputTokens,
              commands: sessionUsage.commandCount,
              duration: Date.now() - sessionUsage.startTime,
              allowed: sessionCheck?.allowed,
              reason: sessionCheck?.reason,
            } : null,
          },
        }, 200);
      },
    },

    // POST /api/spend/reset-session - Reset session usage (admin only)
    {
      path: "/api/spend/reset-session",
      method: "POST",
      handler: async (req) => {
        try {
          const body = await req.json();
          const { sessionId } = body;

          if (!sessionId) {
            return json({ ok: false, error: "sessionId is required" }, 400);
          }

          resetSessionUsage(sessionId);

          return json({
            ok: true,
            message: `Session ${sessionId} usage reset`,
          }, 200);
        } catch (err) {
          return json({ ok: false, error: "Invalid request body" }, 400);
        }
      },
    },
  ];
}
