// Message routes — handles message sending and processing

import type { WSMessage, StoredMessage } from "@koryphaios/shared";
import type { RouteHandler, RouteDependencies } from "./types";
import { json } from "./types";
import { validateSessionId, sanitizeString } from "../security";
import { SESSION, MESSAGE, ID } from "../constants";
import { nanoid } from "nanoid";

export function createMessageRoutes(deps: RouteDependencies): RouteHandler[] {
    const { sessions, messages, wsManager, kory } = deps;

    return [
        // POST /api/messages — Send a message
        {
            path: "/api/messages",
            method: "POST",
            handler: async (req, _params, ctx) => {
                const body = await req.json() as {
                    sessionId: string;
                    content: string;
                    model?: string;
                    reasoningLevel?: string;
                };

                const sessionId = validateSessionId(body.sessionId);
                const content = sanitizeString(body.content, MESSAGE.MAX_CONTENT_LENGTH);

                if (!sessionId || !content) {
                    return json({ ok: false, error: "Valid sessionId and content are required" }, 400);
                }

                // Ensure session exists
                let session = sessions.get(sessionId);
                let activeSessionId = sessionId;
                if (!session) {
                    session = sessions.create(SESSION.DEFAULT_TITLE);
                    activeSessionId = session.id;
                }

                // Persist user message
                const userMsg: StoredMessage = {
                    id: nanoid(ID.SESSION_ID_LENGTH),
                    sessionId: activeSessionId,
                    role: "user",
                    content,
                    createdAt: Date.now(),
                };
                messages.add(activeSessionId, userMsg);

                // Increment message count
                const currentCount = session.messageCount ?? 0;
                sessions.update(activeSessionId, {
                    messageCount: currentCount + 1,
                });

                // AUTO-TITLE: If this was the first message or it's still the default title
                if (currentCount === 0 || session.title === SESSION.DEFAULT_TITLE) {
                    const rawTitle = content.replace(/\n/g, " ").trim();
                    const newTitle = rawTitle.length > 50
                        ? rawTitle.slice(0, 47) + "..."
                        : rawTitle;

                    const updated = sessions.update(activeSessionId, { title: newTitle });
                    if (updated) {
                        wsManager.broadcast({
                            type: "session.updated",
                            payload: { session: updated },
                            timestamp: Date.now(),
                            sessionId: activeSessionId,
                        } satisfies WSMessage);
                    }
                }

                // Process task asynchronously
                kory.processTask(activeSessionId, content, body.model, body.reasoningLevel)
                    .then(() => {
                        // Task completed successfully
                    })
                    .catch((err: Error) => {
                        wsManager.broadcast({
                            type: "system.error",
                            payload: { error: err.message },
                            timestamp: Date.now(),
                            sessionId: activeSessionId,
                        });
                    });

                return json({ ok: true, data: { sessionId: activeSessionId, status: "processing" } }, 202);
            },
        },
    ];
}