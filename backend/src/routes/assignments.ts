// Assignment routes — handles worker model assignments

import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { PROJECT_ROOT } from "../runtime/paths";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KoryphaiosConfig } from "@koryphaios/shared";
import { serverLog } from "../logger";

export function createAssignmentRoutes(deps: RouteDependencies): RouteHandler[] {
    const { config } = deps;

    return [
        // GET /api/assignments — Get worker assignments
        {
            path: "/api/assignments",
            method: "GET",
            handler: async (req, params, ctx) => {
                return json({ ok: true, data: { assignments: config.assignments ?? {} } }, 200);
            },
        },

        // PUT /api/assignments — Update worker assignments
        {
            path: "/api/assignments",
            method: "PUT",
            handler: async (req, params, ctx) => {
                const body = await req.json() as { assignments?: Record<string, string> };
                
                if (!body.assignments || typeof body.assignments !== "object") {
                    return json({ ok: false, error: "assignments object is required" }, 400);
                }

                // Update config in memory
                config.assignments = { ...config.assignments, ...body.assignments };

                // Persist to koryphaios.json if it exists
                const configPath = join(PROJECT_ROOT, "koryphaios.json");
                try {
                    let currentConfig: Record<string, unknown> = {};
                    if (existsSync(configPath)) {
                        currentConfig = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
                    }
                    currentConfig.assignments = config.assignments;
                    writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
                    serverLog.info("Updated worker assignments in koryphaios.json");
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    serverLog.warn({ error: errorMessage }, "Failed to persist assignments to koryphaios.json");
                }

                return json({ ok: true, data: { assignments: config.assignments } }, 200);
            },
        },
    ];
}
