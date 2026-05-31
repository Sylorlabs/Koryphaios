/**
 * Message Replay Buffer
 * Event sourcing system for agent conversations
 *
 * This module provides a complete event sourcing system for tracking and replaying
 * agent conversations. It includes:
 *
 * - Event storage and retrieval
 * - Timeline reconstruction
 * - Session forking
 * - Export/import functionality
 * - Replay with breakpoints and stepping
 */

// ============================================================================
// Core Classes
// ============================================================================

export { ReplayBuffer, getReplayBuffer, setReplayBuffer } from './buffer';
export { EventStore, getEventStore, setEventStore } from './event-store';
export { ReplayPlayer, ReplayPlayerPool, getPlayerPool, setPlayerPool } from './player';
export { ConversationExporter, getConversationExporter, setConversationExporter } from './exporter';

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Event types
  AgentEvent,
  AgentEventType,
  AgentEventPayload,
  UserMessageEvent,
  LLMRequestEvent,
  LLMResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  StateChangeEvent,

  // Buffer types
  ReplayState,
  TimelineEntry,
  TimelineFilter,

  // Player types
  PlayOptions,
  PlayState,
  PlaySpeed,

  // Export/Import types
  ExportedSession,
  ShareableConversation,
  ExportOptions,

  // Store types
  EventQueryOptions,
  EventStoreStats,
} from './types';

// ============================================================================
// Error Exports
// ============================================================================

export {
  ReplayBufferError,
  EventNotFoundError,
  SessionNotFoundError,
  InvalidSequenceError,
  ForkError,
} from './types';

// ============================================================================
// Database Migration
// ============================================================================

import { serverLog } from '../logger';

/**
 * Initialize the replay buffer tables
 * Call this during application startup
 */
export async function initializeReplayBuffer(): Promise<void> {
  // Handled by Drizzle migrations
}

/**
 * Drop replay buffer tables (useful for testing)
 */
export async function dropReplayTables(): Promise<void> {
  // Handled by Drizzle migrations
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get all replay-enabled session IDs
 */
export async function listReplaySessions(): Promise<string[]> {
  const { getEventStore } = await import('./event-store');
  return getEventStore().listSessions();
}

/**
 * Check if a session has replay events
 */
export async function hasReplayEvents(sessionId: string): Promise<boolean> {
  const { getEventStore } = await import('./event-store');
  return getEventStore().hasEvents(sessionId);
}

/**
 * Quick helper to log an event to the replay buffer
 */
export async function logEvent(
  sessionId: string,
  type: import('./types').AgentEventType,
  payload: unknown,
  parentEventId?: string,
): Promise<void> {
  const { getReplayBuffer } = await import('./buffer');
  await getReplayBuffer().append(sessionId, {
    sessionId,
    timestamp: Date.now(),
    type,
    payload,
    parentEventId,
  });
}
