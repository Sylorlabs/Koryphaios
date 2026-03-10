// Message routes — handles message sending and processing

import type { WSMessage, StoredMessage } from "@koryphaios/shared";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { validateSessionId, sanitizeString } from "../security";
import { checkSpendCaps, checkGlobalSpendCaps, getSpendCaps } from "../security/spend-caps";
import { SESSION, MESSAGE, ID } from "../constants";
import { nanoid } from "nanoid";
import { getDb } from "../db/sqlite";
import { z } from "zod";
import { serverLog } from "../logger";

// Validation schema for message requests
const messageRequestSchema = z.object({
    sessionId: z.string().min(1).max(64),
    content: z.string().min(1).max(MESSAGE.MAX_CONTENT_LENGTH),
    model: z.string().max(100).optional(),
    reasoningLevel: z.string().max(20).optional(),
});

export function createMessageRoutes(deps: RouteDependencies): RouteHandler[] {
    const { sessions, messages, wsManager, kory } = deps;

    return [
        // POST /api/messages — Send a message
        {
            path: "/api/messages",
            method: "POST",
            handler: async (req, _params, ctx) => {
                // Validate request body with Zod
                let body: z.infer<typeof messageRequestSchema>;
                try {
                    const rawBody = await req.json();
                    body = messageRequestSchema.parse(rawBody);
                } catch (err) {
                    if (err instanceof z.ZodError) {
                        return json({ 
                            ok: false, 
                            error: "Validation failed", 
                            details: err.issues.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`)
                        }, 400);
                    }
                    return json({ ok: false, error: "Invalid request body" }, 400);
                }

                const sessionId = validateSessionId(body.sessionId);
                const content = sanitizeString(body.content, MESSAGE.MAX_CONTENT_LENGTH);

                if (!sessionId || !content) {
                    return json({ ok: false, error: "Valid sessionId and content are required" }, 400);
                }

                // Check global spend caps (system-wide limits)
                const globalCheck = checkGlobalSpendCaps();
                if (!globalCheck.allowed) {
                    serverLog.warn({ reason: globalCheck.reason }, "Global spend cap exceeded");
                    return json({
                        ok: false,
                        error: globalCheck.reason,
                        shutoff: true,
                        stats: globalCheck.stats,
                    }, 429);
                }

                // Check session-specific spend caps
                const sessionCheck = checkSpendCaps(sessionId, getSpendCaps());
                if (!sessionCheck.allowed) {
                    serverLog.warn({ sessionId, reason: sessionCheck.reason }, "Session spend cap exceeded");
                    return json({
                        ok: false,
                        error: sessionCheck.reason,
                        shutoff: true,
                        usage: sessionCheck.currentUsage,
                    }, 429);
                }

                // Ensure session exists
                let session = sessions.get(sessionId);
                if (!session) {
                    return json({ ok: false, error: "Session not found" }, 404);
                }

                // Persist user message + update session atomically with optimistic locking
                const userMsg: StoredMessage = {
                    id: nanoid(ID.SESSION_ID_LENGTH),
                    sessionId: sessionId,
                    role: "user",
                    content,
                    createdAt: Date.now(),
                };

                const currentCount = session.messageCount ?? 0;
                const needsTitle = currentCount === 0 || session.title === SESSION.DEFAULT_TITLE;
                let newTitle: string | undefined;
                if (needsTitle) {
                    const rawTitle = content.replace(/\n/g, " ").trim();
                    newTitle = rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
                }

                try {
                    const txn = getDb().transaction(() => {
                        messages.add(sessionId, userMsg);
                        // Use optimistic locking with version
                        sessions.update(sessionId, { messageCount: currentCount + 1 }, session.version);
                        if (newTitle) {
                            sessions.update(sessionId, { title: newTitle }, session.version! + 1);
                        }
                    });
                    txn();
                } catch (err: any) {
                    serverLog.error({ error: err.message, sessionId }, "Transaction failed");
                    return json({ ok: false, error: "Failed to save message. Please retry." }, 409);
                }

                if (newTitle) {
                    const updated = sessions.get(sessionId);
                    if (updated) {
                        wsManager.broadcast({
                            type: "session.updated",
                            payload: { session: updated },
                            timestamp: Date.now(),
                            sessionId: sessionId,
                        } satisfies WSMessage);
                    }
                }

                // Process task asynchronously with proper error handling
                const requestId = ctx.requestId;
                kory.processTask(sessionId, content, body.model, body.reasoningLevel)
                    .then(() => {
                        serverLog.info({ requestId, sessionId }, "Task processing completed");
                    })
                    .catch((err: Error) => {
                        const errorPayload = { 
                            error: err.message, 
                            sessionId, 
                            requestId,
                            timestamp: Date.now()
                        };
                        serverLog.error(errorPayload, "Task processing failed");
                        wsManager.broadcast({
                            type: "system.error",
                            payload: errorPayload,
                            timestamp: Date.now(),
                            sessionId: sessionId,
                        });
                    });

                return json({ ok: true, data: { sessionId: sessionId, status: "processing" } }, 202);
            },
        },
    ];
}