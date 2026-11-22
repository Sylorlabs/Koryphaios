import { OrderedEventBuffer, type SequencedEvent } from './ordered-event-buffer';

export interface SessionSequencedEvent {
  sessionId?: string;
  epoch?: number;
  sequence?: number;
}

export interface OrderedSessionCursor {
  epoch: number;
  sequence: number;
}

export interface OrderedSessionReplayRequest extends OrderedSessionCursor {
  sessionId: string;
}

export interface OrderedSessionIngressResult<T> {
  events: T[];
  replayFrom?: OrderedSessionReplayRequest;
}

/**
 * Applies the durable per-session event sequence before UI reducers see a
 * message. WebSocket transport ordinarily preserves order, but replay and
 * reconnect paths must not let a late N-1 be discarded after N has already
 * advanced the subscription cursor.
 */
export class OrderedSessionEventIngress<T extends SessionSequencedEvent> {
  private readonly buffers = new Map<string, OrderedEventBuffer<T & SequencedEvent>>();
  private readonly cursors = new Map<string, OrderedSessionCursor>();
  private readonly replayRequestedForGap = new Set<string>();

  ingest(event: T): T[] {
    return this.ingestWithReplayRequest(event).events;
  }

  /**
   * Return a cursor-based replay request the first time a sequence gap is
   * observed. The caller owns transport; replayed events pass through this
   * same buffer and release the pending tail once the gap is filled.
   */
  ingestWithReplayRequest(event: T): OrderedSessionIngressResult<T> {
    if (
      !event.sessionId ||
      !Number.isSafeInteger(event.epoch) ||
      !Number.isSafeInteger(event.sequence)
    ) {
      return { events: [event] };
    }

    const sessionId = event.sessionId;
    const epoch = Number(event.epoch);
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      const cursor = this.cursors.get(sessionId);
      buffer = new OrderedEventBuffer(epoch, cursor?.epoch === epoch ? cursor.sequence : 0, true);
      this.buffers.set(sessionId, buffer);
    } else if (epoch > buffer.epoch) {
      // A server epoch reset starts a fresh contiguous sequence at one.
      buffer = new OrderedEventBuffer(epoch, 0, true);
      this.buffers.set(sessionId, buffer);
      this.replayRequestedForGap.delete(sessionId);
    } else if (epoch < buffer.epoch) {
      // An old replay cannot regress a newer session epoch.
      return { events: [] };
    }

    const result = buffer.ingest(event as T & SequencedEvent);
    if (result.events.length > 0) {
      const last = result.events[result.events.length - 1];
      this.cursors.set(sessionId, { epoch: last.epoch, sequence: last.sequence });
    }
    if (!buffer.isWaitingForGap) {
      this.replayRequestedForGap.delete(sessionId);
      return { events: result.events };
    }
    if (result.kind !== 'gap' || this.replayRequestedForGap.has(sessionId)) {
      return { events: result.events };
    }

    this.replayRequestedForGap.add(sessionId);
    const cursor = this.cursors.get(sessionId);
    return {
      events: result.events,
      replayFrom: {
        sessionId,
        epoch,
        sequence: cursor?.epoch === epoch ? cursor.sequence : buffer.lastApplied,
      },
    };
  }

  /**
   * Apply a server `session.history_pruned` marker: history through
   * `throughSequence` no longer exists, so the buffer jumps past it instead of
   * waiting on a gap that can never fill. `missed` is true only when this
   * client had already applied part of that epoch and is now missing events it
   * never saw; a fresh renderer (cursor 0) loads persisted history over HTTP
   * and has nothing to recover.
   */
  skipPrunedHistory(
    sessionId: string,
    epoch: number,
    throughSequence: number,
  ): { events: T[]; missed: boolean } {
    if (!sessionId || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(throughSequence)) {
      return { events: [], missed: false };
    }
    const cursor = this.cursors.get(sessionId);
    const applied = cursor?.epoch === epoch ? cursor.sequence : 0;
    const missed = applied > 0 && applied < throughSequence;
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = new OrderedEventBuffer(epoch, applied, true);
      this.buffers.set(sessionId, buffer);
    }
    const events = buffer.skipTo(epoch, throughSequence);
    const last = events.at(-1);
    this.cursors.set(sessionId, {
      epoch,
      sequence: last ? last.sequence : Math.max(applied, throughSequence),
    });
    if (!buffer.isWaitingForGap) this.replayRequestedForGap.delete(sessionId);
    return { events, missed };
  }

  getCursor(sessionId: string): OrderedSessionCursor | undefined {
    return this.cursors.get(sessionId);
  }

  /** Keep the durable cursor across a reconnect, but discard a partial gap so
   * the server replay can supply it again from the last applied event. */
  clearPending(): void {
    this.buffers.clear();
    this.replayRequestedForGap.clear();
  }

  resetSession(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.cursors.delete(sessionId);
    this.replayRequestedForGap.delete(sessionId);
  }

  /** Establish the authoritative empty cursor returned by a timeline rewrite.
   * Late traffic from the prior epoch is rejected instead of repopulating the
   * newly rebuilt transcript. */
  resetSessionToEpoch(sessionId: string, epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1) return;
    this.buffers.set(sessionId, new OrderedEventBuffer(epoch, 0, true));
    this.cursors.set(sessionId, { epoch, sequence: 0 });
    this.replayRequestedForGap.delete(sessionId);
  }
}
