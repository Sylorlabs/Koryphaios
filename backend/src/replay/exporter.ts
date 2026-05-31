/**
 * Message Replay Buffer - Exporter
 */

import { EventStore } from './event-store';
import { type ExportedSession, type AgentEventType, SessionNotFoundError } from './types';

export class ConversationExporter {
  constructor(private eventStore: EventStore) {}

  async exportSession(sessionId: string): Promise<ExportedSession> {
    const hasEvents = await this.eventStore.hasEvents(sessionId);
    if (!hasEvents) throw new SessionNotFoundError(sessionId);
    const events = await this.eventStore.getEvents(sessionId);
    const stats = await this.eventStore.getStats(sessionId);
    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      sessionId,
      events,
      metadata: {
        totalEvents: stats.totalEvents,
        eventTypes: [] as AgentEventType[],
      },
    };
  }
}

let instance: ConversationExporter | null = null;
export function getConversationExporter(): ConversationExporter {
  if (!instance) {
    const { getEventStore } = require('./event-store');
    instance = new ConversationExporter(getEventStore());
  }
  return instance;
}
export function setConversationExporter(e: ConversationExporter | null): void {
  instance = e;
}
