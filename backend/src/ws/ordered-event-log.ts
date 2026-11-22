import type { Database, Statement } from 'bun:sqlite';
import type { SessionTimelineRewrittenPayload, WSMessage, WSEventType } from '@koryphaios/shared';
import { getDb } from '../db';

export interface SessionEventCursor {
  epoch: number;
  latestSequence: number;
}

/** Events older than this are eligible for pruning (B7). */
export const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Newest events kept per session regardless of age (B7). */
export const EVENT_RETENTION_KEEP_PER_SESSION = 500;
/** Fixed allowance per event for the wire envelope around the stored payload. */
export const REPLAY_ENVELOPE_BYTES = 256;

/** Highest (epoch, sequence) ever pruned for a session. Any cursor at or below it has lost events. */
export interface SessionPruneMark {
  epoch: number;
  sequence: number;
}

export interface ReplayPageBudget {
  maxEvents: number;
  maxBytes: number;
}

/**
 * The current-epoch prune mark when a cursor (or a fresh subscription, which
 * starts at zero) sits below it, meaning events it needs were pruned. A cursor
 * from another epoch counts as below the mark. A mark from an older epoch does
 * not touch the current epoch's replay, so it returns null.
 */
export function prunedBoundaryAhead(
  mark: SessionPruneMark | null,
  current: SessionEventCursor,
  cursor?: { epoch?: number; sequence?: number },
): SessionPruneMark | null {
  if (!mark || mark.epoch !== current.epoch || mark.sequence <= 0) return null;
  const start = cursor?.epoch === current.epoch ? Math.max(0, cursor?.sequence ?? 0) : 0;
  return start < mark.sequence ? mark : null;
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
  private readonly readEventById: Statement;
  private readonly markEventDispatched: Statement;
  private readonly recordCause: Statement;
  private readonly readCause: Statement;
  private readonly readCursor: Statement;
  private readonly readAfter: Statement;
  private readonly advanceCursorEpoch: Statement;
  private readonly clearCauses: Statement;
  private readonly readPruneMark: Statement;
  private readonly raisePruneMark: Statement;
  private readonly selectPrunable: Statement;
  private readonly deleteEvent: Statement;
  private readonly pruneTransaction: (now: number) => number;
  private readonly appendTransaction: (message: WSMessage, eventId: string) => WSMessage;
  private readonly resetEpochTransaction: (sessionId: string) => SessionEventCursor;
  private readonly rewriteTimelineTransaction: (
    sessionId: string,
    timestamp: number,
    eventId: string,
  ) => WSMessage<SessionTimelineRewrittenPayload>;

  constructor(private readonly sqlite: Database) {
    // The prune mark is owned by the log, so a log built on a bare schema
    // (tests, fresh databases) can still answer cursor checks. Mirrors migration 0057.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ordered_session_prune_marks (
        session_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        pruned_at INTEGER NOT NULL
      )
    `);
    this.readPruneMark = sqlite.prepare(
      'SELECT epoch, sequence FROM ordered_session_prune_marks WHERE session_id = ?',
    );
    this.raisePruneMark = sqlite.prepare(`
      INSERT INTO ordered_session_prune_marks(session_id, epoch, sequence, pruned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        epoch = excluded.epoch, sequence = excluded.sequence, pruned_at = excluded.pruned_at
      WHERE excluded.epoch > ordered_session_prune_marks.epoch
         OR (excluded.epoch = ordered_session_prune_marks.epoch
             AND excluded.sequence > ordered_session_prune_marks.sequence)
    `);
    // Recency rank counts from the newest event of each session. Anything
    // beyond the kept window AND older than the retention cutoff is prunable.
    this.selectPrunable = sqlite.prepare(`
      WITH ranked AS (
        SELECT event_id, session_id, epoch, sequence, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY session_id ORDER BY epoch DESC, sequence DESC
               ) AS recency
        FROM ordered_session_events
      )
      SELECT event_id, session_id, epoch, sequence FROM ranked
      WHERE recency > ? AND created_at < ?
    `);
    this.deleteEvent = sqlite.prepare('DELETE FROM ordered_session_events WHERE event_id = ?');
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
    this.readEventById = sqlite.prepare(`
      SELECT event_id, session_id, epoch, sequence, timestamp, type, agent_id,
             parent_sequence, payload
      FROM ordered_session_events
      WHERE event_id = ?
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
      const existing = this.readEventById.get(eventId) as OrderedEventRow | null;
      if (existing) {
        const payload = JSON.stringify(message.payload);
        if (
          existing.session_id !== sessionId ||
          existing.type !== message.type ||
          existing.timestamp !== message.timestamp ||
          existing.agent_id !== (message.agentId ?? null) ||
          existing.payload !== payload
        ) {
          throw new Error(`Refusing to reuse ordered event id ${eventId} for different content`);
        }
        return orderedEventFromRow(existing);
      }
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
    this.rewriteTimelineTransaction = sqlite.transaction(
      (sessionId: string, timestamp: number, eventId: string) => {
        const now = Date.now();
        this.ensureCursor.run(sessionId, now);
        const epochRow = this.advanceCursorEpoch.get(now, sessionId) as { epoch: number } | null;
        if (!epochRow) throw new Error(`Failed to advance event epoch for ${sessionId}`);
        this.clearCauses.run(sessionId);

        // Allocate sequence one inside the same transaction as the epoch
        // advance. A backend crash can therefore never leave a rewritten epoch
        // without the durable control row that tells reconnecting clients to
        // discard the prior operational branch.
        const allocated = this.allocateSequence.get(now, sessionId) as {
          epoch: number;
          next_sequence: number;
        } | null;
        if (!allocated || allocated.epoch !== epochRow.epoch) {
          throw new Error(`Failed to allocate timeline rewrite event for ${sessionId}`);
        }
        const sequence = allocated.next_sequence - 1;
        const payload: SessionTimelineRewrittenPayload = {
          eventEpoch: epochRow.epoch,
          reason: 'conversation_rewind',
        };
        const ordered: WSMessage<SessionTimelineRewrittenPayload> = {
          type: 'session.timeline_rewritten',
          sessionId,
          eventId,
          epoch: epochRow.epoch,
          sequence,
          timestamp,
          payload,
        };
        this.insertEvent.run(
          eventId,
          sessionId,
          epochRow.epoch,
          sequence,
          timestamp,
          ordered.type,
          null,
          null,
          JSON.stringify(payload),
          now,
        );
        return ordered;
      },
    );
    this.pruneTransaction = sqlite.transaction((now: number) => {
      const doomed = this.selectPrunable.all(
        EVENT_RETENTION_KEEP_PER_SESSION,
        now - EVENT_RETENTION_MS,
      ) as Array<{ event_id: string; session_id: string; epoch: number; sequence: number }>;
      for (const row of doomed) {
        // Raise the mark before deleting so a cursor check never sees a gap without a mark.
        this.raisePruneMark.run(row.session_id, row.epoch, row.sequence, now);
        this.deleteEvent.run(row.event_id);
      }
      return doomed.length;
    });
  }

  append(message: WSMessage): WSMessage {
    if (!message.sessionId || message.sequence !== undefined) return message;
    return this.appendTransaction(message, message.eventId ?? crypto.randomUUID());
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

  /** Atomically rotate the session epoch and append its sequence-one rewrite
   * control event so every connected or reconnecting renderer can invalidate
   * the discarded branch. */
  rewriteTimeline(
    sessionId: string,
    timestamp = Date.now(),
  ): WSMessage<SessionTimelineRewrittenPayload> {
    return this.rewriteTimelineTransaction(sessionId, timestamp, crypto.randomUUID());
  }

  /** Highest pruned (epoch, sequence) for the session, or null when nothing was pruned. */
  getPruneMark(sessionId: string): SessionPruneMark | null {
    const row = this.readPruneMark.get(sessionId) as SessionPruneMark | null;
    return row ? { epoch: row.epoch, sequence: row.sequence } : null;
  }

  /**
   * Delete events older than EVENT_RETENTION_MS, except each session's newest
   * EVENT_RETENTION_KEEP_PER_SESSION events, and raise the prune mark. Returns
   * the number of deleted rows.
   */
  prune(now = Date.now()): { deleted: number } {
    return { deleted: this.pruneTransaction(now) };
  }

  /**
   * Read the next replay page after `afterSequence`, bounded by event count and
   * by serialized bytes. A page always holds at least one event, so one oversized
   * event cannot stall replay. A cut that would split one assistant turn (same
   * payload.messageId on both sides) moves back to the turn's first event. A
   * turn that starts at the page head and exceeds the byte budget is still cut.
   */
  getPage(
    sessionId: string,
    epoch: number,
    afterSequence: number,
    budget: ReplayPageBudget,
  ): WSMessage[] {
    const maxEvents = Math.max(1, Math.min(2_048, Math.trunc(budget.maxEvents)));
    const rows = this.readAfter.all(
      sessionId,
      epoch,
      afterSequence,
      maxEvents,
    ) as OrderedEventRow[];
    let count = 0;
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload) + REPLAY_ENVELOPE_BYTES;
      if (count > 0 && bytes + size > budget.maxBytes) break;
      bytes += size;
      count++;
    }
    return rows.slice(0, keepTurnWhole(rows, count)).map(orderedEventFromRow);
  }

  getAfter(sessionId: string, epoch: number, afterSequence: number, limit = 512): WSMessage[] {
    const safeLimit = Math.max(1, Math.min(2_048, Math.trunc(limit)));
    const rows = this.readAfter.all(
      sessionId,
      epoch,
      afterSequence,
      safeLimit,
    ) as OrderedEventRow[];
    return rows.map(orderedEventFromRow);
  }
}

function turnIdOf(row: OrderedEventRow): string | undefined {
  const id = (JSON.parse(row.payload) as { messageId?: unknown } | null)?.messageId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Move a page cut back to the start of a turn it would split. A cut that lands
 * inside a turn starting at the page head cannot move without emptying the
 * page, so it stays, and the caller reports the split.
 */
function keepTurnWhole(rows: OrderedEventRow[], count: number): number {
  if (count <= 0 || count >= rows.length) return count;
  const turn = turnIdOf(rows[count - 1]);
  if (turn === undefined || turn !== turnIdOf(rows[count])) return count;
  let start = count - 1;
  while (start > 0 && turnIdOf(rows[start - 1]) === turn) start--;
  return start > 0 ? start : count;
}

function orderedEventFromRow(row: OrderedEventRow): WSMessage {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    epoch: row.epoch,
    sequence: row.sequence,
    timestamp: row.timestamp,
    type: row.type as WSEventType,
    agentId: row.agent_id ?? undefined,
    parentSequence: row.parent_sequence ?? undefined,
    payload: JSON.parse(row.payload),
  };
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
