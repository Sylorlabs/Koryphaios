// System routes — health checks, metrics, project info

import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { basename } from "node:path";
import { PROJECT_ROOT } from "../runtime/paths";
import { VERSION } from "../constants";
import { getMetricsRegistry } from "../metrics";
import { getReconciliation } from "../credit-accountant";
import { serverLog } from "../logger";


export function createSystemRoutes(deps: RouteDependencies): RouteHandler[] {
    return [
        // GET /api/health — Health check with config info
        {
            path: "/api/health",
            method: "GET",
            handler: async (req, params, ctx) => {
                return json({
                    ok: true,
                    data: {
                        status: "healthy",
                        version: VERSION,
                        config: {
                            port: deps.config.server.port,
                            host: deps.config.server.host,
                        },
                    },
                }, 200);
            },
        },

        // GET /health — Minimal health check for load balancers
        {
            path: "/health",
            method: "GET",
            handler: async (req, params, ctx) => {
                return json({ ok: true, data: { version: VERSION } }, 200);
            },
        },

        // GET /api/project — Get project name
        {
            path: "/api/project",
            method: "GET",
            handler: async (req, params, ctx) => {
                const projectName = basename(PROJECT_ROOT);
                return json({ ok: true, data: { projectName } }, 200);
            },
        },

        // GET /api/billing/credits — Get billing reconciliation
        {
            path: "/api/billing/credits",
            method: "GET",
            handler: async (req, params, ctx) => {
                try {
                    const data = getReconciliation();
                    return json({
                        localEstimate: data.localEstimate,
                        cloudReality: data.cloudReality,
                        driftPercent: data.driftPercent,
                        highlightDrift: data.highlightDrift,
                    }, 200);
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    serverLog.error({ error: errorMessage }, "Failed to get billing credits");
                    return json({ error: "Failed to get billing credits" }, 500);
                }
            },
        },

        // GET /metrics — Prometheus metrics
        {
            path: "/metrics",
            method: "GET",
            handler: async (req, params, ctx) => {
                const metricsResponse = getMetricsRegistry().handleMetrics();
                return metricsResponse;
            },
        },

        // POST /api/debug/log-error — Client error log sink
        {
            path: "/api/debug/log-error",
            method: "POST",
            handler: async (req, params, ctx) => {
                // No-op endpoint to avoid 404s from error-monitor
                return json({ ok: true }, 200);
            },
        },

        // GET /api/auth/me — Get current user (desktop app uses local auth)
        {
            path: "/api/auth/me",
            method: "GET",
            handler: async (req, params, ctx) => {
                // Desktop app uses local authentication - return default user
                return json({
                    ok: true,
                    data: {
                        user: {
                            id: "local-user",
                            username: "local",
                            isAdmin: true,
                            createdAt: Date.now(),
                        },
                    },
                }, 200);
            },
        },

        // GET /api/messaging — Get messaging configuration
        {
            path: "/api/messaging",
            method: "GET",
            handler: async (req, params, ctx) => {
                return json({
                    ok: true,
                    data: {
                        telegram: {
                            enabled: false,
                            adminId: null,
                            botTokenSet: false,
                        },
                    },
                }, 200);
            },
        },

        // PUT /api/messaging — Update messaging configuration
        {
            path: "/api/messaging",
            method: "PUT",
            handler: async (req, params, ctx) => {
                return json({ ok: true }, 200);
            },
        },
    ];
}
