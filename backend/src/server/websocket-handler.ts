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
import { turnEventFromWSMessage } from '@koryphaios/shared';
import type { ServerWebSocket } from 'bun';
import type { WSManager } from '../ws/ws-manager';
import type { ISessionStore } from '../stores/session-store';
import type { IMessageStore } from '../stores/message-store';
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
import { toolApprovalQueue } from '../tools/approval-queue';

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
  /** Message store consulted to skip replaying turns already durable as `parts`. */
  messages?: IMessageStore;
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
  reviewRevision: string | undefined,
): boolean {
  if (event.type === 'kory.ask_user') {
    return !!questionId && (event.payload as Partial<KoryAskUserPayload>).questionId === questionId;
  }
  if (event.type === 'session.changes') {
    return (
      !!reviewId && !!reviewRevision &&
      (event.payload as Partial<KorySessionChangesPayload>).reviewId === reviewId &&
      (event.payload as Partial<KorySessionChangesPayload>).reviewRevision === reviewRevision
    );
  }
  return true;
}

/**
 * A fresh renderer already loads the durable message projection over HTTP, and
 * a persisted turn's `parts` are `reduceTurnParts` folded over exactly the
 * `stream.*` events stamped with that turn's `messageId` (transcript-integrity
 * Invariants 1–2). Replaying those events rebuilds rows the projection already
 * carries — per token, on the main thread — only to have them replaced by id.
 * So the only events safe to suppress are the ones the fold itself would have
 * consumed: the predicate below is the shared fold, not a parallel list, so it
 * can never drift from what `parts` covers.
 *
 * Everything else keeps replaying: the in-flight turn (its messageId is not
 * persisted until completion), worker streams (never stamped), `kory.*` /
 * `agent.*` operational rows (not in `parts` at all), and stamped-but-unfolded
 * types like `stream.usage` and `stream.file_*`.
 */
function isReplayCoveredByPersistedParts(
  event: WSMessage,
  persistedMessageIds: ReadonlySet<string>,
): boolean {
  const payload = event.payload as { messageId?: unknown } | null;
  const messageId = payload && typeof payload === 'object' ? payload.messageId : undefined;
  if (typeof messageId !== 'string' || !persistedMessageIds.has(messageId)) return false;
  return (
    turnEventFromWSMessage({
      type: event.type,
      payload: event.payload,
      timestamp: event.timestamp,
    }) !== null
  );
}

/**
 * Only turns durable well before the subscribe go into the coverage set. The
 * renderer's HTTP projection read races this lookup by milliseconds; a turn
 * that committed inside the margin may be absent from that projection, so its
 * events must replay. Thirty seconds dwarfs any request skew and costs at most
 * one recent turn's events.
 */
const REPLAY_COVERAGE_MARGIN_MS = 30_000;

/** The coverage set for a fresh renderer, or null when it cannot be read —
 * an unfiltered replay is always correct, the filter is only an optimization. */
async function listPersistedMessageIds(
  messages: IMessageStore | undefined,
  sessionId: string,
): Promise<ReadonlySet<string> | null> {
  if (!messages?.listPersistedIds) return null;
  try {
    return new Set(
      await messages.listPersistedIds(sessionId, Date.now() - REPLAY_COVERAGE_MARGIN_MS),
    );
  } catch (err: unknown) {
    serverLog.warn(
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      'Persisted-id lookup for transcript replay filter failed; replaying unfiltered',
    );
    return null;
  }
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
          // Only a renderer with no cursor replays the retained log from zero —
          // and it always pairs the subscription with an HTTP message load that
          // carries every persisted turn's `parts`. A cursor-carrying client
          // resumes incrementally instead; events it missed for a turn that
          // persisted while it was away are the only copy left, so its replay
          // stays unfiltered.
          const freshRenderer =
            msg.replayHistory !== false &&
            !Number.isSafeInteger(msg.epoch) &&
            !Number.isSafeInteger(msg.sequence);
          const persistedMessageIds = freshRenderer
            ? await listPersistedMessageIds(deps.messages, sessionId)
            : null;
          wsManager.subscribeClientToSession(
            ws.data.id,
            sessionId,
            {
              epoch: Number.isSafeInteger(msg.epoch) ? msg.epoch : undefined,
              sequence: Number.isSafeInteger(msg.sequence) ? msg.sequence : undefined,
            },
            (event) =>
              isCurrentActionableReplay(
                event,
                isCurrentQuestion(initialRun, initialPending)
                  ? initialPending.questionId
                  : undefined,
                initialReview?.reviewId,
                initialReview?.reviewRevision,
              ) &&
              !(
                persistedMessageIds &&
                isReplayCoveredByPersistedParts(event, persistedMessageIds)
              ),
            msg.replayHistory !== false,
          );

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
              reviewRevision: review.reviewRevision,
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

      case 'permission.response': {
        const id = typeof msg.payload?.id === 'string' ? msg.payload.id : '';
        const response = msg.payload?.response === 'granted' ? 'Allow once' : 'Reject';
        const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
        if (sessionId && (await assertSessionAccess(sessionId))) {
          toolApprovalQueue.respond(sessionId, id, response);
        } else {
          serverLog.warn({ sessionId, clientId: ws.data.id }, 'Unauthorized permission response');
        }
        break;
      }

      case 'session.accept_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          await kory.handleSessionResponse(msg.sessionId, true, {
            reviewId: msg.reviewId, reviewRevision: msg.reviewRevision,
          });
        } else {
          serverLog.warn(
            { sessionId: msg.sessionId, clientId: ws.data.id },
            'Unauthorized session.accept_changes attempt',
          );
        }
        break;

      case 'session.reject_changes':
        if (await assertSessionAccess(msg.sessionId)) {
          await kory.handleSessionResponse(msg.sessionId, false, {
            reviewId: msg.reviewId, reviewRevision: msg.reviewRevision,
          });
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
        kory.setYoloMode(!!msg.enabled, msg.sessionId);
        serverLog.info(
          { enabled: msg.enabled, sessionId: msg.sessionId },
          'YOLO mode mirror updated via WebSocket',
        );
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
