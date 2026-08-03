export interface SequencedEvent {
  epoch: number;
  sequence: number;
}

export type OrderedIngestResult<T> =
  | { kind: 'ready'; events: T[] }
  | { kind: 'duplicate'; events: [] }
  | { kind: 'gap'; events: T[] }
  | { kind: 'epoch_mismatch'; events: [] }
  | { kind: 'overflow'; events: [] };

/**
 * Small synchronous reorder buffer for one session. It never releases event N
 * until every event through N - 1 has been released. Network retries and UI
 * side effects deliberately live outside this class so the invariant remains
 * deterministic and cheap to test.
 */
export class OrderedEventBuffer<T extends SequencedEvent> {
  private readonly pending = new Map<number, T>();

  epoch: number;
  lastApplied: number;
  initialized: boolean;

  constructor(
    epoch: number,
    lastApplied = 0,
    initialized = false,
    readonly capacity = 4_096,
  ) {
    this.epoch = epoch;
    this.lastApplied = lastApplied;
    this.initialized = initialized;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isWaitingForGap(): boolean {
    return this.pending.size > 0;
  }

  establishCursor(epoch: number, latestSequence: number): T[] {
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.lastApplied = latestSequence;
      this.pending.clear();
    } else if (!this.initialized) {
      this.lastApplied = latestSequence;
    }
    this.initialized = true;
    return this.drain();
  }

  ingest(event: T): OrderedIngestResult<T> {
    if (event.epoch !== this.epoch) return { kind: 'epoch_mismatch', events: [] };
    if (event.sequence <= this.lastApplied || this.pending.has(event.sequence)) {
      return { kind: 'duplicate', events: [] };
    }
    if (this.pending.size >= this.capacity) return { kind: 'overflow', events: [] };

    this.pending.set(event.sequence, event);
    if (!this.initialized) return { kind: 'gap', events: [] };

    const events = this.drain();
    return this.pending.size === 0 ? { kind: 'ready', events } : { kind: 'gap', events };
  }

  private drain(): T[] {
    const ready: T[] = [];
    while (true) {
      const sequence = this.lastApplied + 1;
      const event = this.pending.get(sequence);
      if (!event) break;
      this.pending.delete(sequence);
      // Advance before returning control to callers, preventing re-entrant
      // delivery from observing a stale cursor.
      this.lastApplied = sequence;
      ready.push(event);
    }
    return ready;
  }
}
