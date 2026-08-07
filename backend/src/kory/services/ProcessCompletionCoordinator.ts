import type { ProcessLifecycleEvent } from '../../process-supervisor/supervisor';

export interface ProcessCompletionCoordinatorOptions {
  isSessionBusy: (sessionId: string) => boolean;
  wakeSession: (sessionId: string, events: ProcessLifecycleEvent[]) => Promise<void>;
}

/**
 * Serializes background-process completion turns per session.
 *
 * Exit events are never discarded because the manager happens to be busy.
 * They remain queued until notifySessionIdle() is called, and exits arriving
 * during a wake turn are drained by a following turn.
 */
export class ProcessCompletionCoordinator {
  private readonly pending = new Map<string, ProcessLifecycleEvent[]>();
  private readonly waking = new Set<string>();

  constructor(private readonly options: ProcessCompletionCoordinatorOptions) {}

  enqueue(event: ProcessLifecycleEvent): void {
    if (!event.sessionId) return;
    const events = this.pending.get(event.sessionId) ?? [];
    events.push(event);
    this.pending.set(event.sessionId, events);
    this.scheduleDrain(event.sessionId);
  }

  notifySessionIdle(sessionId: string): void {
    this.scheduleDrain(sessionId);
  }

  isWaking(sessionId: string): boolean {
    return this.waking.has(sessionId);
  }

  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0;
  }

  private scheduleDrain(sessionId: string): void {
    queueMicrotask(() => {
      void this.drain(sessionId);
    });
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.waking.has(sessionId) || this.options.isSessionBusy(sessionId)) return;
    const events = this.pending.get(sessionId);
    if (!events?.length) return;

    this.pending.delete(sessionId);
    this.waking.add(sessionId);
    try {
      await this.options.wakeSession(sessionId, events);
    } finally {
      this.waking.delete(sessionId);
      if (this.pending.has(sessionId)) this.scheduleDrain(sessionId);
    }
  }
}
