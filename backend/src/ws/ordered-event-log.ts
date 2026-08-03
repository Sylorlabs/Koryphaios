import type { Database, Statement } from 'bun:sqlite';
import type { WSMessage, WSEventType } from '@koryphaios/shared';
import { getDb } from '../db';

export interface SessionEventCursor {
  epoch: number;
  latestSequence: number;
}

interface CursorRow {
  epoch: number;
  next_sequence: number;
}

interface OrderedEventRow {
  event_id: string;
  session_id: string;
  epoch: number;
  sequence: number;
  timestamp: number;
  type: string;
  agent_id: string | null;
  parent_sequence: number | null;
  payload: string;
}

/**
 * Synchronous prepared SQLite hot path. Bun runs JavaScript on one event-loop
 * thread, while BEGIN IMMEDIATE + UPDATE RETURNING keeps allocation correct if
 * a second process ever shares the database.
 */
export class OrderedEventLog {
  private readonly ensureCursor: Statement;
  private readonly allocateSequence: Statement;
  private readonly insertEvent: Statement;
  private readonly markEventDispatched: Statement;
  private readonly recordCause: Statement;
  private readonly readCause: Statement;
  private readonly readCursor: Statement;
  private readonly readAfter: Statement;
  private readonly advanceCursorEpoch: Statement;
  private readonly clearCauses: Statement;
  private readonly appendTransaction: (message: WSMessage, eventId: string) => WSMessage;
  private readonly resetEpochTransaction: (sessionId: string) => SessionEventCursor;

  constructor(private readonly sqlite: Database) {
    this.ensureCursor = sqlite.prepare(`
      INSERT INTO session_event_cursors(session_id, epoch, next_sequence, updated_at)
      VALUES (?, 1, 1, ?)
      ON CONFLICT(session_id) DO NOTHING
    `);
    this.allocateSequence = sqlite.prepare(`
      UPDATE session_event_cursors
      SET next_sequence = next_sequence + 1, updated_at = ?
      WHERE session_id = ?
      RETURNING epoch, next_sequence
    `);
    this.insertEvent = sqlite.prepare(`
      INSERT INTO ordered_session_events(
        event_id, session_id, epoch, sequence, timestamp, type, agent_id,
        parent_sequence, payload, dispatched, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    this.markEventDispatched = sqlite.prepare(
      'UPDATE ordered_session_events SET dispatched = 1 WHERE event_id = ?',
    );
    this.recordCause = sqlite.prepare(`
      INSERT INTO session_event_causes(session_id, epoch, cause_key, sequence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, epoch, cause_key) DO UPDATE SET sequence = excluded.sequence
    `);
    this.readCause = sqlite.prepare(`
      SELECT sequence FROM session_event_causes
      WHERE session_id = ? AND epoch = ? AND cause_key = ?
    `);
    this.readCursor = sqlite.prepare(
      'SELECT epoch, next_sequence FROM session_event_cursors WHERE session_id = ?',
    );
    this.readAfter = sqlite.prepare(`
      SELECT event_id, session_id, epoch, sequence, timestamp, type, agent_id,
             parent_sequence, payload
      FROM ordered_session_events
      WHERE session_id = ? AND epoch = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
    this.advanceCursorEpoch = sqlite.prepare(`
      UPDATE session_event_cursors
      SET epoch = epoch + 1, next_sequence = 1, updated_at = ?
      WHERE session_id = ?
      RETURNING epoch
    `);
    this.clearCauses = sqlite.prepare('DELETE FROM session_event_causes WHERE session_id = ?');

    this.appendTransaction = sqlite.transaction((message: WSMessage, eventId: string) => {
      const sessionId = message.sessionId!;
      const now = Date.now();
      this.ensureCursor.run(sessionId, now);
      const allocated = this.allocateSequence.get(now, sessionId) as {
        epoch: number;
        next_sequence: number;
      } | null;
      if (!allocated) throw new Error(`Failed to allocate event sequence for ${sessionId}`);
      // UPDATE increments first; the allocated sequence is the prior value.
      const sequence = allocated.next_sequence - 1;
      const cause = causalIdentity(message);
      if (cause?.invalid) {
        throw new Error(`Refusing malformed ${message.type} without a causal identity`);
      }
      let parentSequence: number | undefined;
      if (cause?.requires) {
        const parent = this.readCause.get(sessionId, allocated.epoch, cause.requires) as {
          sequence: number;
        } | null;
        if (!parent) {
          throw new Error(
            `Refusing ${message.type} without causal parent ${cause.requires} in ${sessionId}`,
          );
        }
        parentSequence = parent.sequence;
      }
      const ordered: WSMessage = {
        ...message,
        eventId,
        epoch: allocated.epoch,
        sequence,
        ...(parentSequence !== undefined ? { parentSequence } : {}),
      };
      this.insertEvent.run(
        eventId,
        sessionId,
        allocated.epoch,
        sequence,
        message.timestamp,
        message.type,
        message.agentId ?? null,
        parentSequence ?? null,
        JSON.stringify(message.payload),
        now,
      );
      if (cause?.provides) {
        this.recordCause.run(sessionId, allocated.epoch, cause.provides, sequence);
      }
      return ordered;
    });
    this.resetEpochTransaction = sqlite.transaction((sessionId: string) => {
      const now = Date.now();
      this.ensureCursor.run(sessionId, now);
      const row = this.advanceCursorEpoch.get(now, sessionId) as { epoch: number } | null;
      if (!row) throw new Error(`Failed to advance event epoch for ${sessionId}`);
      this.clearCauses.run(sessionId);
      return { epoch: row.epoch, latestSequence: 0 };
    });
  }

  append(message: WSMessage): WSMessage {
    if (!message.sessionId || message.sequence !== undefined) return message;
    return this.appendTransaction(message, crypto.randomUUID());
  }

  markDispatched(eventId: string | undefined): void {
    if (eventId) this.markEventDispatched.run(eventId);
  }

  getCursor(sessionId: string): SessionEventCursor {
    const row = this.readCursor.get(sessionId) as CursorRow | null;
    return row
      ? { epoch: row.epoch, latestSequence: row.next_sequence - 1 }
      : { epoch: 1, latestSequence: 0 };
  }

  /** Invalidate every prior cursor after an intentional conversation rewrite. */
  resetEpoch(sessionId: string): SessionEventCursor {
    return this.resetEpochTransaction(sessionId);
  }

  getAfter(sessionId: string, epoch: number, afterSequence: number, limit = 512): WSMessage[] {
    const safeLimit = Math.max(1, Math.min(2_048, Math.trunc(limit)));
    const rows = this.readAfter.all(
      sessionId,
      epoch,
      afterSequence,
      safeLimit,
    ) as OrderedEventRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      epoch: row.epoch,
      sequence: row.sequence,
      timestamp: row.timestamp,
      type: row.type as WSEventType,
      agentId: row.agent_id ?? undefined,
      parentSequence: row.parent_sequence ?? undefined,
      payload: JSON.parse(row.payload),
    }));
  }
}

function causalIdentity(
  message: WSMessage,
): { provides?: string; requires?: string; invalid?: true } | null {
  if (message.type === 'stream.tool_call') {
    const id = (message.payload as { toolCall?: { id?: string } }).toolCall?.id;
    return id ? { provides: `tool:${id}` } : { invalid: true };
  }
  if (message.type === 'stream.tool_result') {
    // Legacy internal emitters called the parent field `id`; the public wire
    // contract calls it `callId`. Accept both at this boundary so every real
    // producer receives the same fail-closed causal validation.
    const result = (message.payload as { toolResult?: { callId?: string; id?: string } })
      .toolResult;
    const id = result?.callId ?? result?.id;
    return id ? { requires: `tool:${id}` } : { invalid: true };
  }
  return null;
}

let orderedEventLog: OrderedEventLog | null = null;

export function getOrderedEventLog(): OrderedEventLog {
  if (!orderedEventLog) orderedEventLog = new OrderedEventLog(getDb());
  return orderedEventLog;
}

export function setOrderedEventLogForTests(log: OrderedEventLog | null): void {
  orderedEventLog = log;
}
