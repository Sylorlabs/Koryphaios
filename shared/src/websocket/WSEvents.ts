// WebSocket Protocol Types
// Domain: Real-time communication protocol between frontend and backend

export type WSEventType =
  | 'device.event'
  // Agent lifecycle
  | 'agent.spawned'
  | 'agent.status'
  | 'agent.completed'
  | 'agent.error'
  | 'agent.thread_message'
  | 'agent.updated'
  | 'agent.message'
  | 'agent.steering_queue'
  | 'agent.heartbeat'
  // Streaming content
  | 'stream.delta'
  | 'stream.thinking'
  | 'stream.tool_call'
  | 'stream.tool_result'
  | 'stream.usage'
  | 'stream.complete'
  | 'stream.clear_content'
  // File edit streaming (Cursor-style per-token preview)
  | 'stream.file_delta'
  | 'stream.file_complete'
  // Context detection
  | 'context.detected'
  // Session events
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.changes'
  | 'session.changes_resolved'
  | 'session.accept_changes'
  | 'session.user_message'
  | 'session.idle'
  | 'session.actionable_waits'
  | 'session.actionable_waits.request'
  | 'session.timeline_rewritten'
  // Ephemeral replay placeholder for a filtered durable sequence position.
  | 'session.replay_skipped'
  // Unsequenced control row: history through payload.throughSequence was
  // pruned and can never be replayed; clients advance past it.
  | 'session.history_pruned'
  | 'run.state'
  // Provider work ended for a manager turn; follow-up work (critic, checkpoint, persistence) may still run.
  | 'turn.provider_completed'
  // The run is terminal and every follow-up step has finished.
  | 'run.settled'
  | 'compaction.started'
  | 'compaction.progress'
  | 'compaction.completed'
  | 'compaction.failed'
  // Permission events
  | 'permission.request'
  | 'permission.response'
  // Provider status
  | 'provider.status'
  // Rate limiting
  | 'provider.rate_limit'
  // System
  | 'system.error'
  | 'system.notification'
  | 'system.info'
  | 'system.config_updated'
  // Process supervision
  | 'process.status'
  // Kory-specific
  | 'kory.thought'
  | 'kory.routing'
  | 'kory.skill'
  | 'kory.verification'
  | 'kory.task_breakdown'
  | 'kory.ask_user'
  | 'kory.ask_user_resolved'
  | 'process.started'
  | 'process.exited'
  // Notes network
  | 'notes.updated'
  // Workspace navigation (authoritative desktop workspace snapshots)
  | 'workspace.updated'
  // Desktop UI settings controlled by another connected client
  | 'desktop.ui.updated'
  // Goal mode
  | 'goals.updated'
  // App-wide checklists
  | 'checklists.updated'
  // Native CLI slash command output (attributed to a CLI provider harness)
  | 'native.command'
  // Integrated terminal (PTY). Session-scoped; live only, restored from scrollback.
  | 'terminal.output'
  | 'terminal.exit';

export type RemoteProtocolOperationState =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_uncertain'
  | 'expired'
  | 'rejected';

export interface RemoteOperationEnvelope {
  protocol: 2;
  commandId: string;
  operationId: string;
  target: import('../remote-target').ExecutionTarget;
  state: RemoteProtocolOperationState;
  cursor?: string;
  issuedAt: number;
  attempt: number;
}

export interface RemoteReplayRequest {
  protocol: 2;
  sessionId: string;
  target: import('../remote-target').ExecutionTarget;
  afterCursor?: string;
  commandId?: string;
}

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: number;
  sessionId?: string;
  agentId?: string;
  /** Durable per-session ordering metadata. Present on replayable session events. */
  eventId?: string;
  epoch?: number;
  sequence?: number;
  parentSequence?: number;
  /** True when the server is replaying a previously persisted event. */
  replayed?: boolean;
}

export type WSMessagePayload =
  // Session payloads
  | import('../run/SessionRun').SessionRunStatePayload
  | SessionCreatedPayload
  | SessionUpdatedPayload
  | SessionIdlePayload
  | SessionTimelineRewrittenPayload
  | ChangeSummaryPayload
  | KorySessionChangesPayload
  | KorySessionChangesResolvedPayload
  | SessionActionableWaitsPayload
  | KoryAskUserResolvedPayload
  | TurnProviderCompletedPayload
  | RunSettledPayload
  | StreamUsagePayload

  // Terminal payloads
  | TerminalOutputPayload
  | TerminalExitPayload

  // Message payloads
  | MessagePendingPayload
  | MessageDeltaPayload
  | MessageCompletePayload

  // Agent payloads
  | AgentSpawnedPayload
  | AgentStatusPayload
  | AgentUpdatedPayload
  | AgentHeartbeatPayload
  | AgentThreadMessagePayload
  | AgentSteeringQueuePayload
  | AgentMessageEventPayload
  | ThinkingPayload
  | ToolCallPayload
  | StreamToolResultPayload

  // Provider payloads
  | RateLimitPayload

  // System payloads
  | ErrorPayload
  | NotificationPayload;

import type { TerminalExitPayload, TerminalOutputPayload } from '../terminal';

// Re-export commonly used payload types
import type {
  ChangeSummary,
  StreamUsage,
  SessionCreatedPayload,
  SessionUpdatedPayload,
  SessionIdlePayload,
  SessionTimelineRewrittenPayload,
  ChangeSummaryPayload,
  StreamUsagePayload,
  MessagePendingPayload,
  MessageDeltaPayload,
  MessageCompletePayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentUpdatedPayload,
  AgentHeartbeatPayload,
  AgentThreadMessagePayload,
  AgentSteeringQueuePayload,
  AgentMessageEventPayload,
  ThinkingPayload,
  ToolCallPayload,
  StreamToolResultPayload,
  ErrorPayload,
  NotificationPayload,
  KorySessionChangesPayload,
  KorySessionChangesResolvedPayload,
  SessionActionableWaitsPayload,
  KoryAskUserResolvedPayload,
  RateLimitPayload,
  TurnProviderCompletedPayload,
  RunSettledPayload,
} from './WSPayloads';

export type { ChangeSummary, StreamUsage } from './WSPayloads';

// ============== Session identity (docs/architecture/transcript-integrity.md, Invariant 4) ==============

/**
 * Every event that touches a chat transcript, agent, run or review. The backend
 * refuses to publish one of these without a sessionId, and the frontend drops one.
 *
 * Deliberately excluded:
 * - `session.actionable_waits`: the response to a global index request carries no sessionId.
 * - `session.actionable_waits.request`: a client request, not a session event.
 * - `session.created` / `session.updated` / `session.deleted`: session lifecycle, handled by
 *   the session list rather than a transcript.
 * - `permission.request` / `permission.response`: session-bound at every emitter, but
 *   not yet part of the scoped contract.
 */
export const SESSION_SCOPED_EVENT_TYPES: ReadonlySet<WSEventType> = new Set<WSEventType>([
  // Agent lifecycle
  'agent.spawned',
  'agent.status',
  'agent.completed',
  'agent.error',
  'agent.thread_message',
  'agent.updated',
  'agent.message',
  'agent.steering_queue',
  'agent.heartbeat',
  // Streaming content
  'stream.delta',
  'stream.thinking',
  'stream.tool_call',
  'stream.tool_result',
  'stream.usage',
  'stream.complete',
  'stream.clear_content',
  'stream.file_delta',
  'stream.file_complete',
  // Context
  'context.detected',
  // Session transcript and review
  'session.changes',
  'session.changes_resolved',
  'session.accept_changes',
  'session.user_message',
  'session.idle',
  'session.timeline_rewritten',
  'session.replay_skipped',
  'session.history_pruned',
  'run.state',
  'turn.provider_completed',
  'run.settled',
  // Compaction
  'compaction.started',
  'compaction.progress',
  'compaction.completed',
  'compaction.failed',
  // Kory
  'kory.thought',
  'kory.routing',
  'kory.skill',
  'kory.verification',
  'kory.task_breakdown',
  'kory.ask_user',
  'kory.ask_user_resolved',
  'permission.request',
  'permission.response',
  // Integrated terminal. Never persisted; see backend/src/terminal.
  'terminal.output',
  'terminal.exit',
]);

/** A WebSocket message whose type is session-scoped. The sessionId is required. */
export type SessionWSMessage<T = unknown> = WSMessage<T> & { sessionId: string };

export function isSessionScopedEventType(type: WSEventType): boolean {
  return SESSION_SCOPED_EVENT_TYPES.has(type);
}

/**
 * True when the message is not session-scoped, or when it is session-scoped and
 * carries a non-empty sessionId. False only for a scoped message missing its identity.
 */
export function hasRequiredSessionIdentity(msg: WSMessage): boolean {
  if (!isSessionScopedEventType(msg.type)) return true;
  return typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0;
}
