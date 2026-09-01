// WebSocket Handler
// Domain: WebSocket connection lifecycle and message processing
// Extracted from server.ts lines 1258-1322

import type {
  KoryAskUserPayload,
  KoryAskUserResolvedPayload,
  KorySessionChangesPayload,
  KorySessionChangesResolvedPayload,
  SessionActionableWaitsPayload,
  WSMessage,
} from '@koryphaios/shared';
import type { ServerWebSocket } from 'bun';
import type { WSManager } from '../ws/ws-manager';
import type { ISessionStore } from '../stores/session-store';
import type { KoryManager } from '../kory/manager';
import type { ProviderRegistry } from '../providers';
import { validateSessionId } from '../security';
import { serverLog } from '../logger';
import {
  getPendingQuestion,
  listPendingQuestionSessionIds,
} from '../stores/pending-question-store';
import {
  getPendingSessionReview,
  listPendingSessionReviewSessionIds,
} from '../stores/session-review-store';
import type { SessionRunCoordinator } from '../runs/session-run-coordinator';

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
  runs: SessionRunCoordinator;
}

function isCurrentQuestion(
  run: ReturnType<SessionRunCoordinator['get']>,
  pending: KoryAskUserPayload | null,
): pending is KoryAskUserPayload {
  return !!(
    pending &&
    (!run || (run.phase === 'waiting_user' && run.continuationId === pending.questionId))
  );
}

/**
 * Old operational events remain useful transcript evidence, but they must not
 * re-open an answered question or already-resolved review on fresh hydration.
 * The post-subscription projection below closes the narrow race where state
 * changes between this initial lookup and subscription registration.
 */
function isCurrentActionableReplay(
  event: WSMessage,
  questionId: string | undefined,
  reviewId: string | undefined,
): boolean {
  if (event.type === 'kory.ask_user') {
    return (
      !!questionId &&
      (event.payload as Partial<KoryAskUserPayload>).questionId === questionId
    );
  }
  if (event.type === 'session.changes') {
    return (
      !!reviewId &&
      (event.payload as Partial<KorySessionChangesPayload>).reviewId === reviewId
    );
  }
  return true;
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
  const messageBytes = Buffer.byteLength(message);
  let messageType: string | undefined;
  try {
    const { wsManager, sessions, kory, runs } = deps;
    const msg = JSON.parse(String(message));
    messageType =
      typeof msg?.type === 'string' && /^[a-zA-Z0-9._:-]{1,64}$/.test(msg.type)
        ? msg.type
        : undefined;
    // Helper to assert the session exists for this local single-user app.
    const assertSessionAccess = async (sessionId: string): Promise<boolean> => {
      if (!sessionId || !validateSessionId(sessionId)) return false;
      const session = await sessions.get(sessionId);
      return !!session;
    };

    // Route message by type
    switch (msg.type) {
      case 'pong':
        wsManager.handlePong(ws.data.id);
        break;

      case 'subscribe_session': {
        const sessionId = msg.sessionId;
        if (sessionId && validateSessionId(sessionId) && (await sessions.get(sessionId))) {
          const initialRun = runs.get(sessionId);
          const [initialPending, initialReview] = await Promise.all([
            getPendingQuestion(sessionId),
            getPendingSessionReview(sessionId),
          ]);
          wsManager.subscribeClientToSession(ws.data.id, sessionId, {
            epoch: Number.isSafeInteger(msg.epoch) ? msg.epoch : undefined,
            sequence: Number.isSafeInteger(msg.sequence) ? msg.sequence : undefined,
          }, (event) =>
            isCurrentActionableReplay(
              event,
              isCurrentQuestion(initialRun, initialPending) ? initialPending.questionId : undefined,
              initialReview?.reviewId,
            ));

          // Re-read after subscription. If a question/review changed during
          // the initial projection lookup, this current snapshot wins over the
          // filtered replay without forcing a renderer to subscribe to every
          // historical session.
          const run = runs.get(sessionId);
          if (run) {
            wsManager.sendToClientEphemeral(ws.data.id, {
              type: 'run.state',
              sessionId,
              payload: { snapshot: run, transition: null },
              timestamp: Date.now(),
            });
          }
          const [pending, review] = await Promise.all([
            getPendingQuestion(sessionId),
            getPendingSessionReview(sessionId),
          ]);
          if (isCurrentQuestion(run, pending)) {
            wsManager.sendToClientEphemeral(ws.data.id, {
              type: 'kory.ask_user',
              sessionId,
              payload: pending,
              timestamp: Date.now(),
            });
          } else {
            const resolved: KoryAskUserResolvedPayload = { status: 'not_pending' };
            wsManager.sendToClientEphemeral(ws.data.id, {
              type: 'kory.ask_user_resolved',
              sessionId,
              payload: resolved,
              timestamp: Date.now(),
            });
          }
          if (review) {
            const payload: KorySessionChangesPayload = {
              changes: review.changes,
              reviewId: review.reviewId,
            };
            wsManager.sendToClientEphemeral(ws.data.id, {
              type: 'session.changes',
              sessionId,
              payload,
              timestamp: Date.now(),
            });
          } else {
            const resolved: KorySessionChangesResolvedPayload = { status: 'not_pending' };
            wsManager.sendToClientEphemeral(ws.data.id, {
              type: 'session.changes_resolved',
              sessionId,
              payload: resolved,
              timestamp: Date.now(),
            });
          }
          serverLog.debug({ clientId: ws.data.id, sessionId }, 'Client subscribed to session');
        }
        break;
      }

      case 'user_input':
        if (await assertSessionAccess(msg.sessionId)) {
          await kory.handleUserInput(msg.sessionId, msg.selection, msg.text, msg.questionId);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized user_input attempt',
          );
        }
        break;

      case 'session.accept_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          await kory.handleSessionResponse(msg.sessionId, true);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized session.accept_changes attempt',
          );
        }
        break;

      case 'session.reject_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          await kory.handleSessionResponse(msg.sessionId, false);
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized session.reject_changes attempt',
          );
        }
        break;

      case 'session.actionable_waits.request': {
        const [questionSessionIds, reviewSessionIds] = await Promise.all([
          listPendingQuestionSessionIds(),
          listPendingSessionReviewSessionIds(),
        ]);
        const payload: SessionActionableWaitsPayload = {
          questionSessionIds,
          reviewSessionIds,
        };
        wsManager.sendToClientEphemeral(ws.data.id, {
          type: 'session.actionable_waits',
          payload,
          timestamp: Date.now(),
        });
        break;
      }

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
        event: 'ws.message',
        clientId: ws?.data?.id,
        messageBytes,
        messageType,
        errorType: err instanceof Error ? err.name : typeof err,
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
