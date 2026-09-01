import {
  SessionRunTransitionError,
  type KoryAskUserPayload,
  type SessionRunActivePhase,
  type SessionRunSnapshot,
  type SessionRunStatePayload,
  type WSMessage,
} from '@koryphaios/shared';
import { serverLog } from '../logger';
import {
  SessionRunStore,
  type BeginSessionTurnCommandInput,
  type BeginSessionTurnCommandResult,
  type ClaimedSessionRunRestartHandoff,
  type DurableClaimedProcessWake,
  type DurableProcessWait,
  type FinishSessionTurnCommandInput,
  type FinishSessionTurnCommandResult,
  type SessionRunRestartHandoff,
  type SessionTurnCommandRecord,
} from './session-run-store';

export type SessionRunPublisher = (sessionId: string, message: WSMessage) => void | Promise<void>;

/**
 * Application boundary for run transitions.
 *
 * The store commits snapshot + outbox first. Publication is best-effort here
 * and recoverable through `drainOutbox`, so a renderer disconnect or process
 * crash cannot roll the lifecycle fact back into inference.
 */
export class SessionRunCoordinator {
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private outboxDrainRunning = false;
  private lastOutboxPruneAt = 0;

  constructor(
    readonly store: SessionRunStore,
    private readonly publish: SessionRunPublisher,
  ) {}

  get(sessionId: string): SessionRunSnapshot | null {
    return this.store.get(sessionId);
  }

  getSessionTurnCommand(commandKey: string): SessionTurnCommandRecord | null {
    return this.store.getSessionTurnCommand(commandKey);
  }

  async beginSessionTurnCommand(
    input: BeginSessionTurnCommandInput,
    now = Date.now(),
  ): Promise<BeginSessionTurnCommandResult> {
    const result = this.store.beginSessionTurnCommand(input, now);
    if (result.runTransition) {
      await this.publishStored(result.runTransition.payload, result.runTransition.publishRequired);
    }
    return result;
  }

  async finishSessionTurnCommand(
    input: FinishSessionTurnCommandInput,
    now = Date.now(),
  ): Promise<FinishSessionTurnCommandResult> {
    const result = this.store.finishSessionTurnCommand(input, now);
    if (result.runTransition) {
      await this.publishStored(result.runTransition.payload, result.runTransition.publishRequired);
    }
    return result;
  }

  listProcessWaits(): DurableProcessWait[] {
    return this.store.listProcessWaits();
  }

  listClaimedProcessWakes(): DurableClaimedProcessWake[] {
    return this.store.listClaimedProcessWakes();
  }

  listRestartHandoffs(limit = 100): SessionRunRestartHandoff[] {
    return this.store.listRestartHandoffs(limit);
  }

  getRestartHandoff(id: string): SessionRunRestartHandoff | null {
    return this.store.getRestartHandoff(id);
  }

  listPendingRestartHandoffs(limit = 100): SessionRunRestartHandoff[] {
    return this.store.listPendingRestartHandoffs(limit);
  }

  claimRestartHandoff(
    id: string,
    claimedBy: string,
    leaseDurationMs: number,
    now = Date.now(),
  ): ClaimedSessionRunRestartHandoff | null {
    return this.store.claimRestartHandoff(id, claimedBy, leaseDurationMs, now);
  }

  renewRestartHandoff(
    id: string,
    claimToken: string,
    leaseDurationMs: number,
    now = Date.now(),
  ): ClaimedSessionRunRestartHandoff | null {
    return this.store.renewRestartHandoff(id, claimToken, leaseDurationMs, now);
  }

  requeueRestartHandoff(
    id: string,
    claimToken: string,
    reason?: string,
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    return this.store.requeueRestartHandoff(id, claimToken, reason, now);
  }

  requeueExpiredRestartHandoffs(now = Date.now(), limit = 100): number {
    return this.store.requeueExpiredRestartHandoffs(now, limit);
  }

  consumeRestartHandoff(
    id: string,
    claimToken: string,
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    return this.store.consumeRestartHandoff(id, claimToken, now);
  }

  abandonRestartHandoff(
    id: string,
    claimToken: string,
    reason: string,
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    return this.store.abandonRestartHandoff(id, claimToken, reason, now);
  }

  cancelRestartHandoffsForSession(sessionId: string, reason?: string, now = Date.now()): number {
    return this.store.cancelRestartHandoffsForSession(sessionId, reason, now);
  }

  async start(sessionId: string, reason = 'user_turn'): Promise<SessionRunSnapshot> {
    const result = this.store.transition(sessionId, {
      kind: 'start',
      runId: crypto.randomUUID(),
      reason,
      activeAgentIds: ['kory-manager'],
    });
    await this.publishStored(result.payload, result.publishRequired);
    return result.payload.snapshot;
  }

  async phase(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    phase: SessionRunActivePhase,
    reason?: string,
    activeAgentIds?: string[],
  ): Promise<SessionRunSnapshot> {
    const result = this.store.transition(sessionId, {
      kind: 'phase',
      expectedRunId: runId,
      expectedRevision,
      phase,
      reason,
      activeAgentIds,
    });
    await this.publishStored(result.payload, result.publishRequired);
    return result.payload.snapshot;
  }

  async waitForQuestion(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    question: Omit<KoryAskUserPayload, 'questionId'>,
  ): Promise<{ snapshot: SessionRunSnapshot; question: KoryAskUserPayload }> {
    const result = this.store.parkForQuestion(
      sessionId,
      runId,
      expectedRevision,
      'awaiting_user_input',
      question,
    );
    await this.publishStored(result.payload, result.publishRequired);
    return { snapshot: result.payload.snapshot, question: result.question };
  }

  async answerQuestion(
    sessionId: string,
    answer: string,
    questionId: string | undefined,
    resumeLiveWaiter: boolean,
  ): Promise<{
    snapshot: SessionRunSnapshot;
    question: KoryAskUserPayload;
    handoff: SessionRunRestartHandoff | null;
  } | null> {
    const current = this.store.get(sessionId);
    if (!current?.runId || current.status !== 'waiting' || current.phase !== 'waiting_user') {
      return null;
    }
    const result = this.store.answerQuestion(
      sessionId,
      current.runId,
      current.revision,
      questionId,
      answer,
      resumeLiveWaiter,
    );
    if (!result) return null;
    await this.publishStored(result.payload, result.publishRequired);
    return {
      snapshot: result.payload.snapshot,
      question: result.question,
      handoff: result.handoff,
    };
  }

  async waitForProcesses(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    processIds: readonly string[],
  ): Promise<SessionRunSnapshot> {
    const result = this.store.parkForProcesses(
      sessionId,
      runId,
      expectedRevision,
      processIds,
      'background process is still running',
    );
    await this.publishStored(result.payload, result.publishRequired);
    return result.payload.snapshot;
  }

  async resumeProcessWait(
    sessionId: string,
    runId: string,
    expectedRevision: number,
  ): Promise<{
    snapshot: SessionRunSnapshot;
    processIds: string[];
    continuationId: string;
    expectedBoundary: import('./session-run-store').RestartHandoffConversationBoundary | null;
  }> {
    const result = this.store.resumeProcessWait(sessionId, runId, expectedRevision);
    await this.publishStored(result.payload, result.publishRequired);
    return {
      snapshot: result.payload.snapshot,
      processIds: result.processIds,
      continuationId: result.continuationId,
      expectedBoundary: result.expectedBoundary,
    };
  }

  async complete(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    reason?: string,
  ): Promise<SessionRunSnapshot> {
    return this.terminal(sessionId, runId, expectedRevision, 'complete', reason ?? 'completed');
  }

  async fail(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    reason: string,
  ): Promise<SessionRunSnapshot> {
    return this.terminal(sessionId, runId, expectedRevision, 'fail', reason);
  }

  async cancel(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    reason = 'cancelled_by_user',
  ): Promise<SessionRunSnapshot> {
    return this.terminal(sessionId, runId, expectedRevision, 'cancel', reason);
  }

  async cancelCurrent(
    sessionId: string,
    reason = 'cancelled_by_user',
  ): Promise<SessionRunSnapshot | null> {
    const current = this.store.get(sessionId);
    if (!current?.runId || (current.status !== 'active' && current.status !== 'waiting'))
      return current;
    return this.cancel(sessionId, current.runId, current.revision, reason);
  }

  async failCurrent(sessionId: string, reason: string): Promise<SessionRunSnapshot | null> {
    const current = this.store.get(sessionId);
    if (!current?.runId || (current.status !== 'active' && current.status !== 'waiting')) {
      return current;
    }
    return this.fail(sessionId, current.runId, current.revision, reason);
  }

  /** Mark provider/compaction work that could not survive backend restart. */
  async recoverInterruptedRuns(): Promise<number> {
    let recovered = 0;
    for (const snapshot of this.store.listActive()) {
      if (!snapshot.runId) continue;
      try {
        await this.fail(
          snapshot.sessionId,
          snapshot.runId,
          snapshot.revision,
          'backend_restarted_during_active_run',
        );
        // `run.state` owns lifecycle truth, but spawned worker cards have
        // their own durable event history. Close every exact agent identity
        // carried by the interrupted aggregate so a fresh renderer cannot
        // replay an old thinking/streaming card indefinitely.
        await this.publishInterruptedAgentTerminals(
          snapshot.sessionId,
          snapshot.activeAgentIds.length > 0 ? snapshot.activeAgentIds : ['kory-manager'],
        );
        recovered++;
      } catch (error) {
        if (!(error instanceof SessionRunTransitionError && error.code === 'STALE_RUN'))
          throw error;
      }
    }
    return recovered;
  }

  /** Waiting without its exact durable continuation is corruption, not liveness. */
  async recoverOrphanedWaits(): Promise<number> {
    let recovered = 0;
    for (const snapshot of this.store.listWaiting()) {
      if (this.store.isWaitingContinuationValid(snapshot)) continue;
      const result = this.store.terminalizeOrphanedWait(snapshot, `orphaned_${snapshot.phase}`);
      await this.publishStored(result.payload, result.publishRequired);
      recovered++;
    }
    return recovered;
  }

  async drainOutbox(): Promise<number> {
    if (this.outboxDrainRunning) return 0;
    this.outboxDrainRunning = true;
    let published = 0;
    try {
      for (const payload of this.store.listUnpublished()) {
        if (await this.publishStored(payload, true)) published++;
      }
      const now = Date.now();
      if (now - this.lastOutboxPruneAt >= 60 * 60 * 1_000) {
        this.store.prunePublished(now - 7 * 24 * 60 * 60 * 1_000);
        this.lastOutboxPruneAt = now;
      }
      return published;
    } finally {
      this.outboxDrainRunning = false;
    }
  }

  startOutboxPump(intervalMs = 2_000): void {
    if (this.outboxTimer) return;
    this.outboxTimer = setInterval(() => {
      void this.drainOutbox().catch((error) =>
        serverLog.error({ error }, 'Session run outbox retry failed'),
      );
    }, intervalMs);
    this.outboxTimer.unref?.();
  }

  stopOutboxPump(): void {
    if (!this.outboxTimer) return;
    clearInterval(this.outboxTimer);
    this.outboxTimer = null;
  }

  private async terminal(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    kind: 'complete' | 'fail' | 'cancel',
    reason: string,
  ): Promise<SessionRunSnapshot> {
    const current = this.store.get(sessionId);
    if (current?.runId === runId && current.status === 'terminal') return current;
    const result = this.store.transition(
      sessionId,
      kind === 'complete'
        ? { kind, expectedRunId: runId, expectedRevision, reason }
        : kind === 'fail'
          ? { kind, expectedRunId: runId, expectedRevision, reason }
          : { kind, expectedRunId: runId, expectedRevision, reason },
    );
    await this.publishStored(result.payload, result.publishRequired);
    return result.payload.snapshot;
  }

  /**
   * These are compatibility projections, never recovery work. The durable
   * SessionRun has already transitioned to error before we publish them, so a
   * failed websocket publication cannot revive or rerun provider work.
   */
  private async publishInterruptedAgentTerminals(
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<void> {
    for (const agentId of [...new Set(agentIds.filter(Boolean))].sort()) {
      try {
        await this.publish(sessionId, {
          type: 'agent.status',
          sessionId,
          payload: {
            agentId,
            status: 'error',
            detail: 'Interrupted by backend restart',
          },
          timestamp: Date.now(),
        });
      } catch (error) {
        // The aggregate terminal state remains authoritative and is retained
        // in its outbox. Log this secondary projection failure instead of
        // preventing recovery of the remaining sessions.
        serverLog.error(
          { error, sessionId, agentId },
          'Failed to publish interrupted agent terminal status',
        );
      }
    }
  }

  private async publishStored(
    payload: SessionRunStatePayload,
    required: boolean,
  ): Promise<boolean> {
    if (!required || !payload.transition) return true;
    const eventId = payload.transition.eventId;
    try {
      await this.publish(payload.snapshot.sessionId, {
        type: 'run.state',
        sessionId: payload.snapshot.sessionId,
        eventId,
        payload,
        timestamp: payload.transition.occurredAt,
      });
      this.store.markPublished(eventId);
      return true;
    } catch (error) {
      serverLog.error(
        { error, sessionId: payload.snapshot.sessionId, eventId },
        'Session run projection publish failed; outbox row retained',
      );
      return false;
    }
  }
}
