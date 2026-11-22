/**
 * Session subscription mediator.
 *
 * `sessions.svelte.ts` needs to tell the websocket to drop per-session state,
 * while `websocket.svelte.ts` already depends on the session store for its
 * identity. Importing the websocket back from the session store made those two
 * modules cyclic, which made initialization order fragile. The session store
 * now publishes this one notification and the websocket registers a handler,
 * so the dependency stays one-way.
 */

export type SessionUnsubscribedHandler = (sessionId: string) => void;

const handlers = new Set<SessionUnsubscribedHandler>();

/** Register a handler; returns an unsubscribe function. */
export function onSessionUnsubscribed(handler: SessionUnsubscribedHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Best-effort notification: losing per-session cleanup must not fail a deletion. */
export function notifySessionUnsubscribed(sessionId: string): void {
  for (const handler of handlers) {
    try {
      handler(sessionId);
    } catch {
      // A websocket cleanup handler must never break session deletion.
    }
  }
}
