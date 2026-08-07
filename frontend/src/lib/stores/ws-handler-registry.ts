// WebSocket message handler registry.
//
// Replaces the giant switch statement in websocket.svelte.ts with a Map of
// event type → handler function. Each handler receives a context object
// with the message and shared state/helpers.
//
// Benefits:
//   - O(1) dispatch instead of linear switch
//   - Handlers are independently testable
//   - New event types are registered, not wedged into a 700-line switch
//   - Clear ownership: each handler file owns its event logic
//
// Usage:
//   import { wsHandlers } from './ws-handler-registry';
//   const handler = wsHandlers.get(msg.type);
//   if (handler) handler(ctx);
//   // else: unhandled event, optionally log

import type { WSMessage, WSEventType } from '@koryphaios/shared';

export interface WSHandlerContext {
  msg: WSMessage;
  activeSessionId: string;
  isForActiveSession: boolean;
  orderedMetadata: (metadata: Record<string, unknown>) => Record<string, unknown>;
  // Run-phase transitions are owned by runStateStore. Handlers that need to
  // force a stop delegate through here.
  markSessionAgentsStopped: (sessionId: string) => void;
  // Stores (typed as `any` to avoid circular imports with the stores that
  // import this registry. The actual stores are passed at dispatch time
  // from websocket.svelte.ts, which has the correct types.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feedStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toastStore: any;
}

export type WSHandler = (ctx: WSHandlerContext) => void;

/** Registry mapping WS event types to handler functions. */
export const wsHandlers = new Map<WSEventType, WSHandler>();

/** Register a handler for a specific event type. */
export function registerHandler(type: WSEventType, handler: WSHandler): void {
  wsHandlers.set(type, handler);
}

/** Register multiple handlers at once. */
export function registerHandlers(handlers: Partial<Record<WSEventType, WSHandler>>): void {
  for (const [type, handler] of Object.entries(handlers)) {
    if (handler) wsHandlers.set(type as WSEventType, handler);
  }
}
