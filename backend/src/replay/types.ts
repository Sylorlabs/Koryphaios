/**
 * Message Replay Buffer - Types
 * Event sourcing system for agent conversations
 */

// ============================================================================
// Event Types
// ============================================================================

export type AgentEventType =
  | 'user_message'
  | 'llm_request'
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'state_change';

export interface AgentEvent {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  type: AgentEventType;
  payload: unknown;
  parentEventId?: string; // For forks
}

// ============================================================================
// Event Payload Types
// ============================================================================

export interface UserMessageEvent {
  type: 'user_message';
  content: string;
  attachments?: Array<{
    name: string;
    type: string;
    size: number;
  }>;
}

export interface LLMRequestEvent {
  type: 'llm_request';
  model: string;
  provider: string;
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponseEvent {
  type: 'llm_response';
  content: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  cost?: number;
  finishReason?: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: Record<string, unknown>;
  callId: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolName: string;
  output: unknown;
  isError: boolean;
  durationMs: number;
  callId: string;
}

export interface StateChangeEvent {
  type: 'state_change';
  key: string;
  previousValue: unknown;
  newValue: unknown;
  reason?: string;
}

// Union type for all event payloads
export type AgentEventPayload =
  | UserMessageEvent
  | LLMRequestEvent
  | LLMResponseEvent
  | ToolCallEvent
  | ToolResultEvent
  | StateChangeEvent;

// ============================================================================
// Replay Buffer Types
// ============================================================================

export interface ReplayState {
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
  toolCalls: ToolCallEvent[];
  metadata: Record<string, unknown>;
  checkpoint?: string;
}

export interface TimelineEntry {
  sequence: number;
  timestamp: number;
  type: AgentEventType;
  summary: string;
}

export interface TimelineFilter {
  types?: AgentEventType[];
  startSequence?: number;
  endSequence?: number;
  startTime?: number;
  endTime?: number;
}

// ============================================================================
// Replay Player Types
// ============================================================================

export interface PlayOptions {
  speed?: 'normal' | 'fast' | 'instant';
  startSequence?: number;
  endSequence?: number;
  breakpoints?: AgentEventType[];
  onEvent?: (event: AgentEvent, state: PlayState) => void | Promise<void>;
}

export interface PlayState {
  currentEvent: AgentEvent | null;
  currentSequence: number;
  totalEvents: number;
  isPaused: boolean;
  isComplete: boolean;
  replayState: ReplayState;
}

export type PlaySpeed = 'normal' | 'fast' | 'instant';

// ============================================================================
// Export/Import Types
// ============================================================================

export interface ExportedSession {
  version: string;
  exportedAt: number;
  sessionId: string;
  parentSessionId?: string;
  events: AgentEvent[];
  metadata: {
    title?: string;
    createdAt?: number;
    totalEvents: number;
    eventTypes: AgentEventType[];
  };
}

export interface ShareableConversation {
  id: string;
  title: string;
  createdAt: number;
  summary: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: number;
  }>;
  stats: {
    totalMessages: number;
    totalToolCalls: number;
    totalTokens?: number;
  };
}

export interface ExportOptions {
  includeMetadata?: boolean;
  includeSystemEvents?: boolean;
  anonymize?: boolean;
}

// ============================================================================
// Event Store Types
// ============================================================================

export interface EventStoreStats {
  totalEvents: number;
  eventsByType: Record<AgentEventType, number>;
  firstEventAt?: number;
  lastEventAt?: number;
}

export interface EventQueryOptions {
  limit?: number;
  offset?: number;
  types?: AgentEventType[];
  startSequence?: number;
  endSequence?: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class ReplayBufferError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ReplayBufferError';
  }
}

export class EventNotFoundError extends ReplayBufferError {
  constructor(eventId: string) {
    super(`Event not found: ${eventId}`, 'EVENT_NOT_FOUND');
    this.name = 'EventNotFoundError';
  }
}

export class SessionNotFoundError extends ReplayBufferError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND');
    this.name = 'SessionNotFoundError';
  }
}

export class InvalidSequenceError extends ReplayBufferError {
  constructor(sequence: number, maxSequence: number) {
    super(`Invalid sequence number: ${sequence} (max: ${maxSequence})`, 'INVALID_SEQUENCE');
    this.name = 'InvalidSequenceError';
  }
}

export class ForkError extends ReplayBufferError {
  constructor(message: string, cause?: unknown) {
    super(message, 'FORK_ERROR', cause);
    this.name = 'ForkError';
  }
}
