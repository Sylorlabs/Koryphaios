// Session routes — handles session CRUD operations

import type { WSMessage } from "@koryphaios/shared";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { validateSessionId, sanitizeString } from "../security";
import { SESSION } from "../constants";
import { nanoid } from "nanoid";

export function createSessionRoutes(deps: RouteDependencies): RouteHandler[] {
    const { sessions, messages, wsManager, kory } = deps;

    return [
        // GET /api/sessions — List all sessions
        {
            path: "/api/sessions",
            method: "GET",
            handler: async (_req, _params, ctx) => {
                return json({ ok: true, data: sessions.list() }, 200);
            },
        },

        // POST /api/sessions — Create new session
        {
            path: "/api/sessions",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as { title?: string; parentSessionId?: string };
                const title = sanitizeString(body.title, SESSION.MAX_TITLE_LENGTH);
                const session = sessions.create(title ?? undefined, body.parentSessionId);
                return json({ ok: true, data: session }, 201);
            },
        },

        // GET /api/sessions/:id — Get session by ID
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)$/,
            method: "GET",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                const session = sessions.get(validatedId);
                if (!session) return json({ ok: false, error: "Session not found" }, 404);

                return json({ ok: true, data: session }, 200);
            },
        },

        // PATCH /api/sessions/:id — Update session
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)$/,
            method: "PATCH",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                const body = await req.json() as { title?: string };
                const title = sanitizeString(body.title, SESSION.MAX_TITLE_LENGTH);
                if (!title) return json({ ok: false, error: "title is required" }, 400);

                const updated = sessions.update(validatedId, { title });
                if (!updated) return json({ ok: false, error: "Session not found" }, 404);

                wsManager.broadcast({
                    type: "session.updated",
                    payload: { session: updated },
                    timestamp: Date.now(),
                    sessionId: validatedId,
                } satisfies WSMessage);

                return json({ ok: true, data: updated }, 200);
            },
        },

        // DELETE /api/sessions/:id — Delete session
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)$/,
            method: "DELETE",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                kory.cancelSessionWorkers(validatedId);
                sessions.delete(validatedId);

                wsManager.broadcast({
                    type: "session.deleted",
                    payload: { sessionId: id },
                    timestamp: Date.now(),
                    sessionId: validatedId,
                } satisfies WSMessage);

                return json({ ok: true }, 200);
            },
        },

        // GET /api/sessions/:id/messages — Get session messages
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)\/messages$/,
            method: "GET",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                const sessionMessages = messages.getAll(validatedId);
                return json({ ok: true, data: sessionMessages }, 200);
            },
        },

        // POST /api/sessions/:id/auto-title — Generate auto title
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)\/auto-title$/,
            method: "POST",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                const sessionMessages = messages.getAll(validatedId);
                const firstUserMsg = sessionMessages.find((m: any) => m.role === "user");

                if (firstUserMsg) {
                    const rawTitle = firstUserMsg.content.replace(/\n/g, " ").trim();
                    const title = rawTitle.length > 50
                        ? rawTitle.slice(0, 47) + "..."
                        : rawTitle;
                    const updated = sessions.update(validatedId, { title });

                    if (updated) {
                        wsManager.broadcast({
                            type: "session.updated",
                            payload: { session: updated },
                            timestamp: Date.now(),
                            sessionId: validatedId,
                        } satisfies WSMessage);
                    }

                    return json({ ok: true, data: { title } }, 200);
                }

                return json({ ok: true, data: { title: "New Session" } }, 200);
            },
        },

        // GET /api/sessions/:id/running — Check if session is running
        {
            path: /^\/api\/sessions\/(?<id>[^/]+)\/running$/,
            method: "GET",
            handler: async (req, params, ctx) => {
                const id = params.get("id");
                if (!id) return json({ ok: false, error: "Session ID required" }, 400);

                const validatedId = validateSessionId(id);
                if (!validatedId) return json({ ok: false, error: "Invalid session ID" }, 400);

                return json(
                    { ok: true, data: { running: kory.isSessionRunning(validatedId) } },
                    200
                );
            },
        },
    ];
}