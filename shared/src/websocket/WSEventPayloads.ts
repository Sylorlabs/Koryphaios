// Payload type for every WebSocket event type.
//
// `WSEventType` is the set of event names; this map says what each one carries.
// Events whose payload has no named type yet map to `unknown` (the intersection
// with `Record<WSEventType, unknown>` keeps every event present, so a new event
// type cannot be added without appearing here). docs/api-contract.md lists the
// same mapping for consumers.

import type { WSEventType } from './WSEvents';
import type {
  AgentHeartbeatPayload,
  AgentMessageEventPayload,
  AgentSpawnedPayload,
  AgentStatusPayload,
  AgentSteeringQueuePayload,
  AgentThreadMessagePayload,
  AgentUpdatedPayload,
  CompactionProgressPayload,
  ContextDetectedPayload,
  ErrorPayload,
  KoryAskUserPayload,
  KoryAskUserResolvedPayload,
  KoryRoutingPayload,
  KorySessionChangesPayload,
  KorySessionChangesResolvedPayload,
  KorySkillPayload,
  KoryTaskBreakdownPayload,
  KoryThoughtPayload,
  KoryVerificationPayload,
  MessagePendingPayload,
  NativeCommandPayload,
  NotificationPayload,
  ProviderStatusPayload,
  RateLimitPayload,
  SessionActionableWaitsPayload,
  SessionCreatedPayload,
  SessionHistoryPrunedPayload,
  SessionIdlePayload,
  SessionTimelineRewrittenPayload,
  SessionUpdatedPayload,
  StreamClearContentPayload,
  StreamCompletePayload,
  StreamDeltaPayload,
  StreamFileCompletePayload,
  StreamFileDeltaPayload,
  StreamToolResultPayload,
  StreamUsagePayload,
  ThinkingPayload,
  ToolCallPayload,
  TurnProviderCompletedPayload,
} from './WSPayloads';
import type { RunSettledPayload } from './WSPayloads';
import type { SessionRunStatePayload } from '../run/SessionRun';

export type WSEventPayloads = Record<WSEventType, unknown> & {
  'agent.spawned': AgentSpawnedPayload;
  'agent.status': AgentStatusPayload;
  'agent.updated': AgentUpdatedPayload;
  'agent.heartbeat': AgentHeartbeatPayload;
  'agent.thread_message': AgentThreadMessagePayload;
  'agent.steering_queue': AgentSteeringQueuePayload;
  'agent.message': AgentMessageEventPayload;
  'stream.delta': StreamDeltaPayload;
  'stream.thinking': ThinkingPayload;
  'stream.tool_call': ToolCallPayload;
  'stream.tool_result': StreamToolResultPayload;
  'stream.usage': StreamUsagePayload;
  'stream.complete': StreamCompletePayload;
  'stream.clear_content': StreamClearContentPayload;
  'stream.file_delta': StreamFileDeltaPayload;
  'stream.file_complete': StreamFileCompletePayload;
  'context.detected': ContextDetectedPayload;
  'session.created': SessionCreatedPayload;
  'session.updated': SessionUpdatedPayload;
  'session.changes': KorySessionChangesPayload;
  'session.changes_resolved': KorySessionChangesResolvedPayload;
  'session.actionable_waits': SessionActionableWaitsPayload;
  'session.timeline_rewritten': SessionTimelineRewrittenPayload;
  'session.idle': SessionIdlePayload;
  'session.history_pruned': SessionHistoryPrunedPayload;
  'turn.provider_completed': TurnProviderCompletedPayload;
  'run.state': SessionRunStatePayload;
  'run.settled': RunSettledPayload;
  'compaction.progress': CompactionProgressPayload;
  'provider.status': ProviderStatusPayload;
  'provider.rate_limit': RateLimitPayload;
  'system.error': ErrorPayload;
  'system.notification': NotificationPayload;
  'kory.thought': KoryThoughtPayload;
  'kory.routing': KoryRoutingPayload;
  'kory.skill': KorySkillPayload;
  'kory.verification': KoryVerificationPayload;
  'kory.task_breakdown': KoryTaskBreakdownPayload;
  'kory.ask_user': KoryAskUserPayload;
  'kory.ask_user_resolved': KoryAskUserResolvedPayload;
  'native.command': NativeCommandPayload;
};
