// Agent routes — handles agent steering and cancellation

import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";

export function createAgentRoutes(deps: RouteDependencies): RouteHandler[] {
    const { kory } = deps;

    return [
        // POST /api/agents/:id/cancel — Cancel a specific agent
        {
            path: /^\/api\/agents\/(?<id>[^/]+)\/cancel$/,
            method: "POST",
            handler: async (req, params, ctx) => {
                const agentId = params.get("id");
                if (!agentId) {
                    return json({ ok: false, error: "Agent ID required" }, 400);
                }

                kory.cancelWorker(agentId);
                return json({ ok: true }, 200);
            },
        },

        // POST /api/agents/cancel-all — Cancel all running agents
        {
            path: "/api/agents/cancel-all",
            method: "POST",
            handler: async (req, params, ctx) => {
                kory.cancel();
                return json({ ok: true }, 200);
            },
        },

        // GET /api/agents/status — Get active agent status
        {
            path: "/api/agents/status",
            method: "GET",
            handler: async (req, params, ctx) => {
                const workers = kory.getStatus();
                return json({ ok: true, data: { workers } }, 200);
            },
        },
    ];
}
