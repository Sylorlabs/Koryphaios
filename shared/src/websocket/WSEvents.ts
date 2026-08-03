// WebSocket Protocol Types
// Domain: Real-time communication protocol between frontend and backend

export type WSEventType =
  // Agent lifecycle
  | 'agent.spawned'
  | 'agent.status'
  | 'agent.completed'
  | 'agent.error'
  | 'agent.thread_message'
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
  | 'session.accept_changes'
  | 'session.user_message'
  | 'session.cursor'
  | 'session.replay'
  | 'session.integrity_error'
  | 'session.idle'
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
  | 'process.started'
  | 'process.exited'
  // Notes network
  | 'notes.updated'
  // Goal mode
  | 'goals.updated'
  // Native CLI slash command output (attributed to a CLI provider harness)
  | 'native.command';

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: number;
  sessionId?: string;
  agentId?: string;
  /** Durable total order within one session epoch. Unscoped control events omit it. */
  sequence?: number;
  /** Changes only when a session timeline is explicitly rewritten. */
  epoch?: number;
  /** Stable idempotency key for duplicate delivery/replay. */
  eventId?: string;
  /** Sequence of the prerequisite event, for causally dependent events. */
  parentSequence?: number;
}

export type WSMessagePayload =
  // Session payloads
  | SessionCreatedPayload
  | SessionUpdatedPayload
  | SessionIdlePayload
  | ChangeSummaryPayload
  | KorySessionChangesPayload
  | StreamUsagePayload

  // Message payloads
  | MessagePendingPayload
  | MessageDeltaPayload
  | MessageCompletePayload

  // Agent payloads
  | AgentSpawnedPayload
  | AgentStatusPayload
  | AgentThreadMessagePayload
  | ThinkingPayload
  | ToolCallPayload
  | StreamToolResultPayload

  // Provider payloads
  | RateLimitPayload

  // System payloads
  | ErrorPayload
  | NotificationPayload
  | SystemInfoPayload;

// Re-export commonly used payload types
import type {
  ChangeSummary,
  StreamUsage,
  SessionCreatedPayload,
  SessionUpdatedPayload,
  SessionIdlePayload,
  ChangeSummaryPayload,
  StreamUsagePayload,
  MessagePendingPayload,
  MessageDeltaPayload,
  MessageCompletePayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentThreadMessagePayload,
  ThinkingPayload,
  ToolCallPayload,
  StreamToolResultPayload,
  ErrorPayload,
  NotificationPayload,
  SystemInfoPayload,
  KorySessionChangesPayload,
  RateLimitPayload,
} from './WSPayloads';

export type { ChangeSummary, StreamUsage } from './WSPayloads';
