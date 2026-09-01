import type { ProcessLifecycleEvent } from '../../process-supervisor/supervisor';
import { isAgentBackgroundProcess } from '@koryphaios/shared';

export interface ProcessCompletionCoordinatorOptions {
  isSessionBusy: (sessionId: string) => boolean;
  hasActiveAgentProcess: (sessionId: string) => boolean;
  wakeSession: (sessionId: string, events: ProcessLifecycleEvent[]) => Promise<void>;
  onWakeError?: (sessionId: string, error: unknown) => void;
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
  private readonly cancelled = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(private readonly options: ProcessCompletionCoordinatorOptions) {}

  enqueue(event: ProcessLifecycleEvent): void {
    if (!event.sessionId) return;
    if (this.cancelled.has(event.sessionId)) return;
    if (
      event.type !== 'exited' ||
      event.willRestart ||
      event.terminalReason === 'session-cancelled' ||
      event.terminalReason === 'killed-for-restart' ||
      !isAgentBackgroundProcess(event)
    ) {
      return;
    }
    this.enqueueAccepted(event);
  }

  /**
   * Rebuild a terminal batch from durable process rows after restart.
   *
   * The authoritative waiting continuation proves these exact ids belong to
   * this run. Cancellation/restart terminals remain excluded and are
   * reconciled as terminal run outcomes by the manager. The wake path rehydrates the entire
   * continuation again before resuming, preventing a partial callback batch
   * from producing an incomplete provider summary.
   */
  enqueueRecoveredBatch(events: readonly ProcessLifecycleEvent[]): number {
    const first = events[0];
    if (!first?.sessionId || this.waking.has(first.sessionId)) return 0;
    let accepted = 0;
    for (const event of events) {
      if (
        event.sessionId !== first.sessionId ||
        event.type !== 'exited' ||
        event.willRestart ||
        event.terminalReason === 'session-cancelled' ||
        event.terminalReason === 'killed-for-restart' ||
        !isAgentBackgroundProcess(event)
      ) {
        continue;
      }
      accepted += this.enqueueAccepted(event) ? 1 : 0;
    }
    return accepted;
  }

  private enqueueAccepted(event: ProcessLifecycleEvent): boolean {
    if (!event.sessionId || this.cancelled.has(event.sessionId)) return false;
    // A new authoritative terminal event is a concrete state change and may
    // retry a previously failed wake batch.
    this.failed.delete(event.sessionId);
    const events = this.pending.get(event.sessionId) ?? [];
    if (events.some((candidate) => candidate.id === event.id)) return false;
    events.push(event);
    this.pending.set(event.sessionId, events);
    this.scheduleDrain(event.sessionId);
    return true;
  }

  notifySessionIdle(sessionId: string): void {
    if (this.cancelled.has(sessionId) || this.failed.has(sessionId)) return;
    this.scheduleDrain(sessionId);
  }

  /** Discard terminal work before aborting/killing a cancelled session. */
  cancelSession(sessionId: string): void {
    this.cancelled.add(sessionId);
    this.pending.delete(sessionId);
    this.failed.delete(sessionId);
  }

  /** A new human/Goal turn establishes a fresh cancellation generation. */
  resumeSession(sessionId: string): void {
    this.cancelled.delete(sessionId);
    this.failed.delete(sessionId);
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
    if (
      this.cancelled.has(sessionId) ||
      this.waking.has(sessionId) ||
      this.options.isSessionBusy(sessionId) ||
      this.options.hasActiveAgentProcess(sessionId)
    ) {
      return;
    }
    const events = this.pending.get(sessionId);
    if (!events?.length) return;

    this.pending.delete(sessionId);
    this.waking.add(sessionId);
    let failed = false;
    try {
      await this.options.wakeSession(sessionId, events);
    } catch (error) {
      failed = true;
      this.failed.add(sessionId);
      if (!this.cancelled.has(sessionId)) {
        this.pending.set(sessionId, [...events, ...(this.pending.get(sessionId) ?? [])]);
      }
      this.options.onWakeError?.(sessionId, error);
    } finally {
      this.waking.delete(sessionId);
      // A successful wake may have received more terminal events while it was
      // running. A failed batch is retained but only retried after a concrete
      // later idle/process-state notification, avoiding a hot retry loop.
      if (
        !failed &&
        this.pending.has(sessionId) &&
        !this.options.hasActiveAgentProcess(sessionId)
      ) {
        this.scheduleDrain(sessionId);
      }
    }
  }
}
