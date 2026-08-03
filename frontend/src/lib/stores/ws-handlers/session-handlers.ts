// Session event handlers — extracted from the giant switch in websocket.svelte.ts.
// Each handler is a pure function that receives the WSHandlerContext.

import type { WSHandlerContext, WSHandler } from '../ws-handler-registry';
import { registerHandler } from '../ws-handler-registry';
import type { SessionIdlePayload, Session } from '@koryphaios/shared';

/** session.idle — definitive "session is done working" signal from the backend. */
export const handleSessionIdle: WSHandler = (ctx: WSHandlerContext) => {
  const { msg, feedStore, markSessionAgentsStopped, clearSessionBusy } = ctx;
  const p = msg.payload as SessionIdlePayload;
  if (p.sessionId) {
    // Tag live manager content entries with the persisted message id
    // before clearing busy, so the dedup in loadSessionMessages can match
    // by ID instead of falling back to text comparison.
    if (p.messageId) feedStore.tagManagerMessageId(p.messageId);
    markSessionAgentsStopped(p.sessionId);
    clearSessionBusy(p.sessionId);
  }
};

/** session.updated — update session metadata in the store. */
export const handleSessionUpdated: WSHandler = (ctx: WSHandlerContext) => {
  const { msg, sessionStore } = ctx;
  const p = msg.payload as { session: Session };
  if (p.session) sessionStore.handleSessionUpdate(p.session);
};

/** session.deleted — remove session from the store. */
export const handleSessionDeleted: WSHandler = (ctx: WSHandlerContext) => {
  const { msg, sessionStore } = ctx;
  const p = msg.payload as { sessionId: string };
  if (p.sessionId) sessionStore.handleSessionDeleted(p.sessionId);
};

/** Register all session event handlers with the global registry. */
export function registerSessionHandlers(): void {
  registerHandler('session.idle', handleSessionIdle);
  registerHandler('session.updated', handleSessionUpdated);
  registerHandler('session.deleted', handleSessionDeleted);
}
