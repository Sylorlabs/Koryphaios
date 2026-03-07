// WebSocket Handler
// Domain: WebSocket connection lifecycle and message processing
// Extracted from server.ts lines 1258-1322

import type { WSMessage } from "@koryphaios/shared";
import type { ServerWebSocket } from "bun";
import type { WSManager } from "../ws/ws-manager";
import type { ISessionStore } from "../stores/session-store";
import type { KoryManager } from "../kory/manager-refactored";
import type { ProviderRegistry } from "../providers";
import { validateSessionId } from "../security";
import { serverLog } from "../logger";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface WSClientData {
  id: string;
  userId?: string;
}

export interface WebSocketHandlerDependencies {
  wsManager: WSManager;
  sessions: ISessionStore;
  kory: KoryManager;
  providers: ProviderRegistry;
}

// ─── WebSocket Handler Functions ─────────────────────────────────────────────────

/**
 * Handle new WebSocket connection.
 *
 * @param ws - WebSocket instance
 * @param deps - Handler dependencies
 */
export async function handleWSOpen(
  ws: ServerWebSocket<WSClientData>,
  deps: WebSocketHandlerDependencies
): Promise<void> {
  try {
    const { wsManager, providers } = deps;

    wsManager.add(ws);
    serverLog.info({ clientId: ws.data.id, clients: wsManager.clientCount }, "WS client connected");

    // Send initial provider status
    try {
      const initialStatus = providers.getStatus();
      ws.send(JSON.stringify({
        type: "provider.status",
        payload: { providers: initialStatus },
        timestamp: Date.now(),
      } satisfies WSMessage));
    } catch (err) {
      serverLog.error({ err, event: "ws.open.init_status", clientId: ws?.data?.id }, "WS init status error");
    }
  } catch (err) {
    serverLog.error({ err, event: "ws.open", clientId: ws?.data?.id }, "WS open error");
  }
}

/**
 * Handle incoming WebSocket message.
 *
 * @param ws - WebSocket instance
 * @param message - Message content (string or buffer)
 * @param deps - Handler dependencies
 */
export async function handleWSMessage(
  ws: ServerWebSocket<WSClientData>,
  message: string | Buffer,
  deps: WebSocketHandlerDependencies
): Promise<void> {
  try {
    const { wsManager, sessions, kory } = deps;
    const msg = JSON.parse(String(message));
    const userId = ws.data.userId ?? "local";

    // Helper to assert session ownership
    const assertSessionOwnership = (sessionId: string): boolean => {
      if (!sessionId || !validateSessionId(sessionId)) return false;
      const session = sessions.getForUser(sessionId, userId);
      return !!session;
    };

    // Route message by type
    switch (msg.type) {
      case "subscribe_session":
        const sessionId = msg.sessionId;
        if (sessionId && validateSessionId(sessionId) && sessions.getForUser(sessionId, userId)) {
          wsManager.subscribeClientToSession(ws.data.id, sessionId);
          serverLog.debug({ clientId: ws.data.id, sessionId }, "Client subscribed to session");
        }
        break;

      case "user_input":
        if (assertSessionOwnership(msg.sessionId)) {
          kory.handleUserInput(msg.sessionId, msg.selection, msg.text);
        } else {
          serverLog.warn({ sessionId: msg.sessionId, userId }, "Unauthorized user_input attempt");
        }
        break;

      case "session.accept_changes":
        if (assertSessionOwnership(msg.sessionId)) {
          kory.handleSessionResponse(msg.sessionId, true);
        } else {
          serverLog.warn({ sessionId: msg.sessionId, userId }, "Unauthorized session.accept_changes attempt");
        }
        break;

      case "session.reject_changes":
        if (assertSessionOwnership(msg.sessionId)) {
          kory.handleSessionResponse(msg.sessionId, false);
        } else {
          serverLog.warn({ sessionId: msg.sessionId, userId }, "Unauthorized session.reject_changes attempt");
        }
        break;

      case "toggle_yolo":
        kory.setYoloMode(!!msg.enabled);
        serverLog.info({ enabled: msg.enabled }, "YOLO mode toggled via WebSocket");
        break;

      default:
        serverLog.warn({ type: msg.type }, "Unknown WebSocket message type");
    }
  } catch (err) {
    serverLog.error({
      err,
      event: "ws.message",
      clientId: ws?.data?.id,
      raw: String(message).slice(0, 500)
    }, "WS message error");
  }
}

/**
 * Handle WebSocket connection close.
 *
 * @param ws - WebSocket instance
 * @param wsManager - WebSocket manager instance
 */
export function handleWSClose(
  ws: ServerWebSocket<WSClientData>,
  wsManager: WSManager
): void {
  wsManager.remove(ws);
  serverLog.info({ clients: wsManager.clientCount }, "WS client disconnected");
}

/**
 * Create WebSocket handlers object for Bun.serve configuration.
 *
 * @param deps - Handler dependencies
 * @returns WebSocket handlers object
 */
export function createWebSocketHandlers(deps: WebSocketHandlerDependencies) {
  return {
    open: (ws: ServerWebSocket<WSClientData>) => handleWSOpen(ws, deps),
    message: (ws: ServerWebSocket<WSClientData>, message: string | Buffer) =>
      handleWSMessage(ws, message, deps),
    close: (ws: ServerWebSocket<WSClientData>) => handleWSClose(ws, deps.wsManager),
  };
}
