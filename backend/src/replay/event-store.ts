/**
 * Message Replay Buffer - Event Store
 */

import { db, replayEvents } from '../db';
import { eq, and, lte, asc, sql, count } from 'drizzle-orm';
import {
  type AgentEvent,
  type AgentEventType,
  type EventQueryOptions,
  type EventStoreStats,
  ReplayBufferError,
} from './types';

export class EventStore {
  async append(sessionId: string, event: AgentEvent): Promise<void> {
    try {
      await db.insert(replayEvents).values({
        id: event.id,
        sessionId,
        sequence: event.sequence,
        timestamp: new Date(event.timestamp),
        type: event.type,
        payload: JSON.stringify(event.payload),
        parentEventId: event.parentEventId ?? null,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE'))
        throw new ReplayBufferError(
          `Duplicate sequence ${event.sequence}`,
          'DUPLICATE_SEQUENCE',
          error,
        );
      throw error;
    }
  }

  async appendMany(sessionId: string, events: AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    await db.transaction(async (tx) => {
      for (const event of events) {
        await tx.insert(replayEvents).values({
          id: event.id,
          sessionId,
          sequence: event.sequence,
          timestamp: new Date(event.timestamp),
          type: event.type,
          payload: JSON.stringify(event.payload),
          parentEventId: event.parentEventId ?? null,
        });
      }
    });
  }

  async getEvents(sessionId: string, options?: EventQueryOptions): Promise<AgentEvent[]> {
    let q = db
      .select()
      .from(replayEvents)
      .where(eq(replayEvents.sessionId, sessionId))
      .orderBy(asc(replayEvents.sequence));
    if (options?.limit) q = q.limit(options.limit) as any;
    const rows = await q;
    return rows.map((r) => this.rowToEvent(r));
  }

  async getEventsUpTo(sessionId: string, sequence: number): Promise<AgentEvent[]> {
    const rows = await db
      .select()
      .from(replayEvents)
      .where(and(eq(replayEvents.sessionId, sessionId), lte(replayEvents.sequence, sequence)))
      .orderBy(asc(replayEvents.sequence));
    return rows.map((r) => this.rowToEvent(r));
  }

  async hasEvents(sessionId: string): Promise<boolean> {
    const [row] = await db
      .select({ val: count() })
      .from(replayEvents)
      .where(eq(replayEvents.sessionId, sessionId));
    return (row?.val ?? 0) > 0;
  }

  async getLatestSequence(sessionId: string): Promise<number> {
    const [row] = await db
      .select({ max_seq: sql<number>`MAX(sequence)` })
      .from(replayEvents)
      .where(eq(replayEvents.sessionId, sessionId));
    return row?.max_seq ?? 0;
  }

  async getNextSequence(sessionId: string): Promise<number> {
    const latest = await this.getLatestSequence(sessionId);
    return latest + 1;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await db.delete(replayEvents).where(eq(replayEvents.sessionId, sessionId));
  }

  async listSessions(): Promise<string[]> {
    const rows = await db
      .select({ sessionId: replayEvents.sessionId })
      .from(replayEvents)
      .groupBy(replayEvents.sessionId);
    return rows.map((r) => r.sessionId);
  }

  async getStats(sessionId: string): Promise<EventStoreStats> {
    const [total] = await db
      .select({ val: count() })
      .from(replayEvents)
      .where(eq(replayEvents.sessionId, sessionId));
    return {
      totalEvents: total?.val ?? 0,
      eventsByType: {} as any,
      firstEventAt: 0,
      lastEventAt: 0,
    };
  }

  async copyEvents(
    sourceSessionId: string,
    targetSessionId: string,
    upToSequence?: number,
  ): Promise<number> {
    const events = await this.getEvents(sourceSessionId);
    await db.transaction(async (tx) => {
      for (const e of events) {
        await tx.insert(replayEvents).values({
          id: `fork_${e.id}_${Date.now()}`,
          sessionId: targetSessionId,
          sequence: e.sequence,
          timestamp: new Date(e.timestamp),
          type: e.type,
          payload: JSON.stringify(e.payload),
          parentEventId: e.parentEventId ?? null,
        });
      }
    });
    return events.length;
  }

  private rowToEvent(row: any): AgentEvent {
    return {
      id: row.id,
      sessionId: row.sessionId,
      sequence: row.sequence,
      timestamp: row.timestamp.getTime(),
      type: row.type as AgentEventType,
      payload: JSON.parse(row.payload),
      parentEventId: row.parentEventId ?? undefined,
    };
  }
}

let instance: EventStore | null = null;
export function getEventStore(): EventStore {
  if (!instance) instance = new EventStore();
  return instance;
}
export function setEventStore(s: EventStore | null): void {
  instance = s;
}
