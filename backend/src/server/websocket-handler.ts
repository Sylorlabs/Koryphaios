// WebSocket Handler
// Domain: WebSocket connection lifecycle and message processing
// Extracted from server.ts lines 1258-1322

import type { WSMessage } from '@koryphaios/shared';
import type { ServerWebSocket } from 'bun';
import type { WSManager } from '../ws/ws-manager';
import type { ISessionStore } from '../stores/session-store';
import type { KoryManager } from '../kory/manager';
import type { ProviderRegistry } from '../providers';
import { validateSessionId } from '../security';
import { serverLog } from '../logger';
import { getOrderedEventLog } from '../ws/ordered-event-log';

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
  deps: WebSocketHandlerDependencies,
): Promise<void> {
  try {
    const { wsManager, providers } = deps;

    wsManager.add(ws);
    serverLog.info({ clientId: ws.data.id, clients: wsManager.clientCount }, 'WS client connected');

    // Send initial provider status
    try {
      const initialStatus = providers.getStatus();
      ws.send(
        JSON.stringify({
          type: 'provider.status',
          payload: { providers: initialStatus },
          timestamp: Date.now(),
        } satisfies WSMessage),
      );
    } catch (err) {
      serverLog.error(
        { err, event: 'ws.open.init_status', clientId: ws?.data?.id },
        'WS init status error',
      );
    }
  } catch (err) {
    serverLog.error({ err, event: 'ws.open', clientId: ws?.data?.id }, 'WS open error');
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
  deps: WebSocketHandlerDependencies,
): Promise<void> {
  try {
    const { wsManager, sessions, kory } = deps;
    const msg = JSON.parse(String(message));
    // Helper to assert the session exists for this local single-user app.
    const assertSessionAccess = async (sessionId: string): Promise<boolean> => {
      if (!sessionId || !validateSessionId(sessionId)) return false;
      const session = await sessions.get(sessionId);
      return !!session;
    };

    // Route message by type
    switch (msg.type) {
      case 'subscribe_session': {
        const sessionId = msg.sessionId;
        if (sessionId && validateSessionId(sessionId) && (await sessions.get(sessionId))) {
          wsManager.subscribeClientToSession(ws.data.id, sessionId);
          const eventLog = getOrderedEventLog();
          const cursor = eventLog.getCursor(sessionId);
          const requestedEpoch = Number.isSafeInteger(msg.epoch) ? Number(msg.epoch) : undefined;
          const requestedAfter = Number.isSafeInteger(msg.afterSequence)
            ? Math.max(0, Number(msg.afterSequence))
            : undefined;

          // A newly opened frontend has no local cursor. It still needs the
          // operational transcript (thinking, tools, and partial output), not
          // merely the persisted chat messages, after a renderer crash or
          // reload. Start that client from the beginning of the current epoch.
          const replayEpoch = requestedEpoch ?? cursor.epoch;
          const replayAfter = requestedAfter ?? 0;
          if (replayEpoch !== cursor.epoch || replayAfter > cursor.latestSequence) {
            ws.send(
              JSON.stringify({
                type: 'session.integrity_error',
                sessionId,
                timestamp: Date.now(),
                payload: {
                  code: replayEpoch !== cursor.epoch ? 'EPOCH_MISMATCH' : 'CURSOR_AHEAD',
                  cursor,
                },
              } satisfies WSMessage),
            );
          } else {
            let after = replayAfter;
            do {
              const events = eventLog.getAfter(sessionId, cursor.epoch, after);
              if (events.length > 0) after = events.at(-1)!.sequence!;
              const complete = after >= cursor.latestSequence || events.length === 0;
              ws.send(
                JSON.stringify({
                  type: 'session.replay',
                  sessionId,
                  timestamp: Date.now(),
                  payload: {
                    epoch: cursor.epoch,
                    events,
                    throughSequence: after,
                    latestSequence: cursor.latestSequence,
                    complete,
                  },
                } satisfies WSMessage),
              );
              if (complete) break;
            } while (true);
          }
          serverLog.debug({ clientId: ws.data.id, sessionId }, 'Client subscribed to session');
        }
        break;
      }

      case 'user_input':
        if (await assertSessionAccess(msg.sessionId)) {
          kory.handleUserInput(msg.sessionId, msg.selection, msg.text);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized user_input attempt',
          );
        }
        break;

      case 'session.accept_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          kory.handleSessionResponse(msg.sessionId, true);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized session.accept_changes attempt',
          );
        }
        break;

      case 'session.reject_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          kory.handleSessionResponse(msg.sessionId, false);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized session.reject_changes attempt',
          );
        }
        break;

      case 'toggle_yolo':
        kory.setYoloMode(!!msg.enabled);
        serverLog.info({ enabled: msg.enabled }, 'YOLO mode toggled via WebSocket');
        break;

      default:
        serverLog.warn({ type: msg.type }, 'Unknown WebSocket message type');
    }
  } catch (err) {
    serverLog.error(
      {
        err,
        event: 'ws.message',
        clientId: ws?.data?.id,
        raw: String(message).slice(0, 500),
      },
      'WS message error',
    );
  }
}

/**
 * Handle WebSocket connection close.
 *
 * @param ws - WebSocket instance
 * @param wsManager - WebSocket manager instance
 */
export function handleWSClose(ws: ServerWebSocket<WSClientData>, wsManager: WSManager): void {
  wsManager.remove(ws);
  serverLog.info({ clients: wsManager.clientCount }, 'WS client disconnected');
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
