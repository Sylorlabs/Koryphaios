// WebSocket Protocol Types
// Domain: Real-time communication protocol between frontend and backend

export type WSEventType =
  // Agent lifecycle
  | "agent.spawned"
  | "agent.status"
  | "agent.completed"
  | "agent.error"
  // Streaming content
  | "stream.delta"
  | "stream.thinking"
  | "stream.tool_call"
  | "stream.tool_result"
  | "stream.usage"
  | "stream.complete"
  // File edit streaming (Cursor-style per-token preview)
  | "stream.file_delta"
  | "stream.file_complete"
  // Session events
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.changes"
  | "session.accept_changes"
  // Permission events
  | "permission.request"
  | "permission.response"
  // Provider status
  | "provider.status"
  // System
  | "system.error"
  | "system.info"
  // Kory-specific
  | "kory.thought"
  | "kory.routing"
  | "kory.verification"
  | "kory.task_breakdown"
  | "kory.ask_user";

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: number;
  sessionId?: string;
  agentId?: string;
}

export type WSMessagePayload =
  // Session payloads
  | SessionCreatedPayload
  | SessionUpdatedPayload
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
  | ThinkingPayload
  | ToolCallPayload
  | StreamToolResultPayload

  // System payloads
  | ErrorPayload
  | NotificationPayload;

// Re-export commonly used payload types
import type {
  ChangeSummary,
  StreamUsage,
  SessionCreatedPayload,
  SessionUpdatedPayload,
  ChangeSummaryPayload,
  StreamUsagePayload,
  MessagePendingPayload,
  MessageDeltaPayload,
  MessageCompletePayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  ThinkingPayload,
  ToolCallPayload,
  StreamToolResultPayload,
  ErrorPayload,
  NotificationPayload,
  KorySessionChangesPayload,
} from "./WSPayloads";

export type { ChangeSummary, StreamUsage } from "./WSPayloads";
