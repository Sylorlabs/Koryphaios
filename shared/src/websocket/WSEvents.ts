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
  | 'run.state'
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
  | 'native.command';

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
  | StreamUsagePayload

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
} from './WSPayloads';

export type { ChangeSummary, StreamUsage } from './WSPayloads';
