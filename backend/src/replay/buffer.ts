/**
 * Message Replay Buffer - Main Buffer
 * Event sourcing system for agent conversations
 */

import { nanoid } from 'nanoid';
import { EventStore } from './event-store';
import {
  type AgentEvent,
  type AgentEventType,
  type ExportedSession,
  type ReplayState,
  type TimelineEntry,
  type TimelineFilter,
  type UserMessageEvent,
  type LLMResponseEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type StateChangeEvent,
  ReplayBufferError,
  SessionNotFoundError,
  InvalidSequenceError,
  ForkError,
} from './types';

// ============================================================================
// Replay Buffer
// ============================================================================

export class ReplayBuffer {
  constructor(private eventStore: EventStore) {}

  // ============================================================================
  // Event Appending
  // ============================================================================

  /**
   * Append an event to a session (auto-assigns sequence and ID)
   */
  async append(sessionId: string, event: Omit<AgentEvent, 'id' | 'sequence'>): Promise<AgentEvent> {
    const sequence = await this.eventStore.getNextSequence(sessionId);

    const fullEvent: AgentEvent = {
      ...event,
      id: nanoid(),
      sequence,
      sessionId,
    };

    await this.eventStore.append(sessionId, fullEvent);
    return fullEvent;
  }

  /**
   * Append a user message event
   */
  async appendUserMessage(
    sessionId: string,
    content: string,
    attachments?: UserMessageEvent['attachments'],
  ): Promise<AgentEvent> {
    const payload: UserMessageEvent = {
      type: 'user_message',
      content,
      attachments,
    };

    return this.append(sessionId, {
      sessionId,
      timestamp: Date.now(),
      type: 'user_message',
      payload,
    });
  }

  /**
   * Append an LLM response event
   */
  async appendLLMResponse(
    sessionId: string,
    content: string,
    model: string,
    provider: string,
    tokensIn: number,
    tokensOut: number,
    latencyMs: number,
    options?: {
      cost?: number;
      finishReason?: string;
    },
  ): Promise<AgentEvent> {
    const payload: LLMResponseEvent = {
      type: 'llm_response',
      content,
      model,
      provider,
      tokensIn,
      tokensOut,
      latencyMs,
      cost: options?.cost,
      finishReason: options?.finishReason,
    };

    return this.append(sessionId, {
      sessionId,
      timestamp: Date.now(),
      type: 'llm_response',
      payload,
    });
  }

  /**
   * Append a tool call event
   */
  async appendToolCall(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ): Promise<AgentEvent> {
    const payload: ToolCallEvent = {
      type: 'tool_call',
      toolName,
      input,
      callId,
    };

    return this.append(sessionId, {
      sessionId,
      timestamp: Date.now(),
      type: 'tool_call',
      payload,
    });
  }

  /**
   * Append a tool result event
   */
  async appendToolResult(
    sessionId: string,
    toolName: string,
    output: unknown,
    isError: boolean,
    durationMs: number,
    callId: string,
  ): Promise<AgentEvent> {
    const payload: ToolResultEvent = {
      type: 'tool_result',
      toolName,
      output,
      isError,
      durationMs,
      callId,
    };

    return this.append(sessionId, {
      sessionId,
      timestamp: Date.now(),
      type: 'tool_result',
      payload,
    });
  }

  /**
   * Append a state change event
   */
  async appendStateChange(
    sessionId: string,
    key: string,
    previousValue: unknown,
    newValue: unknown,
    reason?: string,
  ): Promise<AgentEvent> {
    const payload: StateChangeEvent = {
      type: 'state_change',
      key,
      previousValue,
      newValue,
      reason,
    };

    return this.append(sessionId, {
      sessionId,
      timestamp: Date.now(),
      type: 'state_change',
      payload,
    });
  }

  // ============================================================================
  // Replay Operations
  // ============================================================================

  /**
   * Replay events to reconstruct state
   */
  async replay(sessionId: string, upToSequence?: number): Promise<ReplayState> {
    const hasEvents = await this.eventStore.hasEvents(sessionId);
    if (!hasEvents) {
      throw new SessionNotFoundError(sessionId);
    }

    const events =
      upToSequence !== undefined
        ? await this.eventStore.getEventsUpTo(sessionId, upToSequence)
        : await this.eventStore.getEvents(sessionId);

    return this.reconstructState(sessionId, events);
  }

  /**
   * Replay events and return the state at a specific sequence
   */
  async replayAt(sessionId: string, sequence: number): Promise<ReplayState> {
    const maxSequence = await this.eventStore.getLatestSequence(sessionId);

    if (sequence < 1 || sequence > maxSequence) {
      throw new InvalidSequenceError(sequence, maxSequence);
    }

    return this.replay(sessionId, sequence);
  }

  // ============================================================================
  // Fork Operations
  // ============================================================================

  /**
   * Fork a conversation at a specific point
   */
  async fork(sourceSessionId: string, atSequence: number, newSessionId: string): Promise<void> {
    // Verify source session exists
    const hasEvents = await this.eventStore.hasEvents(sourceSessionId);
    if (!hasEvents) {
      throw new SessionNotFoundError(sourceSessionId);
    }

    // Verify sequence is valid
    const maxSequence = await this.eventStore.getLatestSequence(sourceSessionId);
    if (atSequence < 1 || atSequence > maxSequence) {
      throw new InvalidSequenceError(atSequence, maxSequence);
    }

    // Check if target session already exists
    const targetHasEvents = await this.eventStore.hasEvents(newSessionId);
    if (targetHasEvents) {
      throw new ForkError(
        `Target session ${newSessionId} already has events. Cannot fork into existing session.`,
      );
    }

    try {
      // Copy events up to the specified sequence
      await this.eventStore.copyEvents(sourceSessionId, newSessionId, atSequence);
    } catch (error) {
      throw new ForkError(
        `Failed to fork session ${sourceSessionId} at sequence ${atSequence}`,
        error,
      );
    }
  }

  /**
   * Create a fork with a state change marker
   */
  async forkWithMarker(
    sourceSessionId: string,
    atSequence: number,
    newSessionId: string,
    markerReason?: string,
  ): Promise<void> {
    await this.fork(sourceSessionId, atSequence, newSessionId);

    // Add a state change event to mark the fork
    await this.appendStateChange(
      newSessionId,
      'fork',
      { sourceSessionId, atSequence },
      { newSessionId, forkedAt: Date.now() },
      markerReason ?? `Forked from ${sourceSessionId} at sequence ${atSequence}`,
    );
  }

  // ============================================================================
  // Timeline Operations
  // ============================================================================

  /**
   * Get timeline for UI display
   */
  async getTimeline(sessionId: string, filter?: TimelineFilter): Promise<TimelineEntry[]> {
    const hasEvents = await this.eventStore.hasEvents(sessionId);
    if (!hasEvents) {
      return [];
    }

    const options = filter?.types ? { types: filter.types } : undefined;
    const events = await this.eventStore.getEvents(sessionId, options);

    return events
      .filter((event) => {
        if (filter?.startSequence !== undefined && event.sequence < filter.startSequence) {
          return false;
        }
        if (filter?.endSequence !== undefined && event.sequence > filter.endSequence) {
          return false;
        }
        if (filter?.startTime !== undefined && event.timestamp < filter.startTime) {
          return false;
        }
        if (filter?.endTime !== undefined && event.timestamp > filter.endTime) {
          return false;
        }
        return true;
      })
      .map((event) => this.createTimelineEntry(event));
  }

  /**
   * Get timeline entries by type
   */
  async getTimelineByType(sessionId: string, types: AgentEventType[]): Promise<TimelineEntry[]> {
    return this.getTimeline(sessionId, { types });
  }

  // ============================================================================
  // Export/Import Operations
  // ============================================================================

  /**
   * Export session to JSON
   */
  async exportSession(sessionId: string): Promise<string> {
    const hasEvents = await this.eventStore.hasEvents(sessionId);
    if (!hasEvents) {
      throw new SessionNotFoundError(sessionId);
    }

    const events = await this.eventStore.getEvents(sessionId);
    const stats = await this.eventStore.getStats(sessionId);

    const exportData: ExportedSession = {
      version: '1.0.0',
      exportedAt: Date.now(),
      sessionId,
      events,
      metadata: {
        totalEvents: stats.totalEvents,
        eventTypes: Object.entries(stats.eventsByType)
          .filter(([, count]) => count > 0)
          .map(([type]) => type as AgentEventType),
      },
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import session from JSON
   */
  async importSession(json: string, newSessionId?: string): Promise<string> {
    let data: ExportedSession;

    try {
      data = JSON.parse(json) as ExportedSession;
    } catch (error) {
      throw new ReplayBufferError('Invalid JSON format', 'INVALID_JSON', error);
    }

    // Validate version
    if (!data.version) {
      throw new ReplayBufferError('Missing version in export data', 'INVALID_EXPORT_FORMAT');
    }

    // Validate events array
    if (!Array.isArray(data.events)) {
      throw new ReplayBufferError('Missing or invalid events array', 'INVALID_EXPORT_FORMAT');
    }

    const targetSessionId = newSessionId ?? data.sessionId;

    // Check if target session already exists
    const hasEvents = await this.eventStore.hasEvents(targetSessionId);
    if (hasEvents) {
      throw new ReplayBufferError(
        `Target session ${targetSessionId} already exists`,
        'SESSION_EXISTS',
      );
    }

    // Import events with new IDs
    const eventsToImport: AgentEvent[] = data.events.map((event) => ({
      ...event,
      id: nanoid(),
      sessionId: targetSessionId,
    }));

    await this.eventStore.appendMany(targetSessionId, eventsToImport);

    return targetSessionId;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get session statistics
   */
  async getSessionStats(sessionId: string) {
    const hasEvents = await this.eventStore.hasEvents(sessionId);
    if (!hasEvents) {
      throw new SessionNotFoundError(sessionId);
    }

    return this.eventStore.getStats(sessionId);
  }

  /**
   * Check if a session has replay events
   */
  async hasSession(sessionId: string): Promise<boolean> {
    return this.eventStore.hasEvents(sessionId);
  }

  /**
   * Get the latest sequence number for a session
   */
  async getLatestSequence(sessionId: string): Promise<number> {
    return this.eventStore.getLatestSequence(sessionId);
  }

  /**
   * Delete all events for a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.eventStore.deleteSession(sessionId);
  }

  /**
   * List all sessions with replay events
   */
  async listSessions(): Promise<string[]> {
    return this.eventStore.listSessions();
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private reconstructState(sessionId: string, events: AgentEvent[]): ReplayState {
    const messages: Array<{ role: string; content: string }> = [];
    const toolCalls: ToolCallEvent[] = [];
    const metadata: Record<string, unknown> = {};

    for (const event of events) {
      switch (event.type) {
        case 'user_message': {
          const payload = event.payload as UserMessageEvent;
          messages.push({
            role: 'user',
            content: payload.content,
          });
          break;
        }

        case 'llm_response': {
          const payload = event.payload as LLMResponseEvent;
          messages.push({
            role: 'assistant',
            content: payload.content,
          });
          break;
        }

        case 'tool_call': {
          const payload = event.payload as ToolCallEvent;
          toolCalls.push(payload);
          break;
        }

        case 'tool_result': {
          // Tool results don't change the message state directly
          // but could be used for debugging/replay
          break;
        }

        case 'state_change': {
          const payload = event.payload as StateChangeEvent;
          metadata[payload.key] = payload.newValue;
          break;
        }

        case 'llm_request':
          // LLM requests don't change state directly
          break;
      }
    }

    return {
      sessionId,
      messages,
      toolCalls,
      metadata,
    };
  }

  private createTimelineEntry(event: AgentEvent): TimelineEntry {
    let summary = '';

    switch (event.type) {
      case 'user_message': {
        const payload = event.payload as UserMessageEvent;
        const preview = payload.content.slice(0, 50);
        summary = payload.content.length > 50 ? `${preview}...` : preview;
        break;
      }

      case 'llm_request':
        summary = 'LLM request sent';
        break;

      case 'llm_response': {
        const payload = event.payload as LLMResponseEvent;
        const preview = payload.content.slice(0, 50);
        summary = payload.content.length > 50 ? `${preview}...` : preview;
        break;
      }

      case 'tool_call': {
        const payload = event.payload as ToolCallEvent;
        summary = `Tool: ${payload.toolName}`;
        break;
      }

      case 'tool_result': {
        const payload = event.payload as ToolResultEvent;
        summary = payload.isError
          ? `Error in ${payload.toolName}`
          : `Result from ${payload.toolName}`;
        break;
      }

      case 'state_change': {
        const payload = event.payload as StateChangeEvent;
        summary = `State: ${payload.key}`;
        break;
      }

      default:
        summary = 'Unknown event';
    }

    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
      summary,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let replayBufferInstance: ReplayBuffer | null = null;

export function getReplayBuffer(): ReplayBuffer {
  if (!replayBufferInstance) {
    const { getEventStore } = require('./event-store');
    replayBufferInstance = new ReplayBuffer(getEventStore());
  }
  return replayBufferInstance;
}

export function setReplayBuffer(buffer: ReplayBuffer | null): void {
  replayBufferInstance = buffer;
}
