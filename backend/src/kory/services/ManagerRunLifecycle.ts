import type { KoryAskUserPayload, SessionRunActivePhase } from '@koryphaios/shared';
import type { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import type {
  BeginSessionTurnCommandInput,
  SessionTurnCommandRecord,
} from '../../runs/session-run-store';
import type { DurableProcessWait } from '../../runs/session-run-store';
import type { SessionRunRestartHandoff } from '../../runs/session-run-store';
import type { RestartHandoffConversationBoundary } from '../../runs/session-run-store';
import { answerPendingQuestion, createPendingQuestion } from '../../stores/pending-question-store';

interface ManagerRunLease {
  runId: string;
  revision: number;
  phase: string;
  processIds?: string[];
}

declare const managerRunHandleBrand: unique symbol;

/**
 * Opaque capability for one specific manager-run generation.
 *
 * Callers may inspect the ids for logging and correlation, but only
 * `ManagerRunLifecycle` can create a value assignable to this type. Keeping the
 * run id in every writer prevents a callback retained by run A from borrowing
 * the current session lease after run B has replaced it.
 */
export type ManagerRunHandle = Readonly<{
  sessionId: string;
  runId: string;
  [managerRunHandleBrand]: true;
}>;

export interface ManagerQuestionAnswer {
  question: KoryAskUserPayload;
  /** Present when answering resumed the still-live run in this process. */
  handle: ManagerRunHandle | null;
  /** Present when a restarted backend must execute a durable replacement turn. */
  handoff: SessionRunRestartHandoff | null;
}

export interface ManagerProcessWaitResume {
  handle: ManagerRunHandle | null;
  processIds: string[];
  continuationId: string | null;
  expectedBoundary: RestartHandoffConversationBoundary | null;
}

export type ManagerSessionTurnCommandBegin =
  | {
      disposition: 'started';
      command: SessionTurnCommandRecord;
      handle: ManagerRunHandle;
    }
  | {
      disposition: 'existing';
      command: SessionTurnCommandRecord;
      handle: null;
    };

/**
 * Serialized process-local leases over the durable SessionRun aggregate.
 *
 * The promise tail is not lifecycle truth; it only prevents two callbacks in
 * this process from racing the aggregate CAS while one is publishing. SQLite,
 * run id, and revision remain authoritative across processes and restarts.
 */
export class ManagerRunLifecycle {
  private detached = false;
  private readonly leases = new Map<string, ManagerRunLease>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly runs?: SessionRunCoordinator) {}

  begin(sessionId: string, reason: string): Promise<ManagerRunHandle> {
    return this.serialized(sessionId, async () => {
      this.assertAttached();
      if (!this.runs) {
        if (this.leases.has(sessionId)) {
          throw new Error(`Session ${sessionId} already has a manager run lease`);
        }
        const runId = crypto.randomUUID();
        this.leases.set(sessionId, { runId, revision: 1, phase: 'analyzing' });
        return this.createHandle(sessionId, runId);
      }
      const snapshot = await this.runs.start(sessionId, reason);
      if (!snapshot.runId) throw new Error(`Session run ${sessionId} started without a run id`);
      return this.remember(snapshot);
    });
  }

  /**
   * Atomically starts a durable producer command and adopts its SessionRun as
   * the process-local lease. Existing receipts are never adopted or replayed.
   */
  beginCommand(input: BeginSessionTurnCommandInput): Promise<ManagerSessionTurnCommandBegin> {
    return this.serialized(input.sessionId, async () => {
      this.assertAttached();
      if (!this.runs) {
        throw new Error('Session turn command ledger is unavailable');
      }
      const result = await this.runs.beginSessionTurnCommand(input);
      if (result.disposition === 'existing') {
        return { disposition: 'existing', command: result.command, handle: null };
      }
      const snapshot = result.runTransition?.payload.snapshot;
      if (!snapshot || snapshot.runId !== result.command.runId) {
        throw new Error(
          `Session turn command ${result.command.commandKey} started without its run snapshot`,
        );
      }
      return {
        disposition: 'started',
        command: result.command,
        handle: this.remember(snapshot),
      };
    });
  }

  phase(
    handle: ManagerRunHandle,
    phase: SessionRunActivePhase,
    reason?: string,
    activeAgentIds?: string[],
  ): Promise<void> {
    return this.serialized(handle.sessionId, async () => {
      if (this.detached) return;
      const lease = this.ownedLease(handle);
      // An agent membership change is a durable lifecycle fact even when the
      // provider phase itself stays the same (for example, a worker starts
      // while the manager remains in tool_calling).
      if (!lease || (lease.phase === phase && activeAgentIds === undefined)) return;
      if (!this.runs) {
        this.updateLocalLease(handle, { phase });
        return;
      }
      const snapshot = await this.runs.phase(
        handle.sessionId,
        handle.runId,
        lease.revision,
        phase,
        reason,
        activeAgentIds,
      );
      this.remember(snapshot);
    });
  }

  waitForQuestion(
    handle: ManagerRunHandle,
    question: Omit<KoryAskUserPayload, 'questionId'>,
  ): Promise<KoryAskUserPayload> {
    return this.serialized(handle.sessionId, async () => {
      if (this.detached) throw new Error('Manager run lifecycle is shut down');
      const lease = this.requireOwnedLease(handle);
      if (!this.runs) {
        const pending = await createPendingQuestion(handle.sessionId, question);
        this.updateLocalLease(handle, { phase: 'waiting_user' });
        return pending;
      }
      const result = await this.runs.waitForQuestion(
        handle.sessionId,
        handle.runId,
        lease.revision,
        question,
      );
      this.remember(result.snapshot);
      return result.question;
    });
  }

  answerQuestion(
    sessionId: string,
    answer: string,
    questionId: string | undefined,
    resumeLiveWaiter: boolean,
  ): Promise<ManagerQuestionAnswer | null> {
    return this.serialized(sessionId, async () => {
      if (this.detached) return null;
      if (!this.runs) {
        const question = await answerPendingQuestion(sessionId, answer, 'answered', questionId);
        if (!question) return null;
        const lease = this.leases.get(sessionId);
        if (resumeLiveWaiter && lease?.phase === 'waiting_user') {
          const handle = this.createHandle(sessionId, lease.runId);
          this.updateLocalLease(handle, { phase: 'analyzing' });
          return { question, handle, handoff: null };
        }
        this.leases.delete(sessionId);
        return { question, handle: null, handoff: null };
      }
      const result = await this.runs.answerQuestion(
        sessionId,
        answer,
        questionId,
        resumeLiveWaiter,
      );
      if (!result) return null;
      const handle = result.snapshot.status === 'active' ? this.remember(result.snapshot) : null;
      if (!handle) this.releaseRun(sessionId, result.snapshot.runId);
      return { question: result.question, handle, handoff: result.handoff };
    });
  }

  waitForProcesses(handle: ManagerRunHandle, processIds: readonly string[]): Promise<void> {
    return this.serialized(handle.sessionId, async () => {
      if (this.detached) return;
      const lease = this.ownedLease(handle);
      if (!lease) return;
      if (!this.runs) {
        this.updateLocalLease(handle, {
          phase: 'waiting_terminal',
          processIds: [...new Set(processIds)].filter(Boolean).sort(),
        });
        return;
      }
      const snapshot = await this.runs.waitForProcesses(
        handle.sessionId,
        handle.runId,
        lease.revision,
        processIds,
      );
      this.remember(snapshot);
    });
  }

  resumeProcessWait(sessionId: string): Promise<ManagerProcessWaitResume> {
    return this.serialized(sessionId, async () => {
      if (this.detached) {
        return { handle: null, processIds: [], continuationId: null, expectedBoundary: null };
      }
      if (!this.runs) {
        const lease = this.leases.get(sessionId);
        if (!lease || lease.phase !== 'waiting_terminal') {
          return { handle: null, processIds: [], continuationId: null, expectedBoundary: null };
        }
        const processIds = lease.processIds ?? [];
        const handle = this.createHandle(sessionId, lease.runId);
        this.updateLocalLease(handle, { phase: 'analyzing', processIds: undefined });
        return { handle, processIds, continuationId: null, expectedBoundary: null };
      }
      const current = this.runs.get(sessionId);
      if (!current?.runId || current.phase !== 'waiting_terminal') {
        throw new Error(`Session ${sessionId} is not waiting for background processes`);
      }
      const result = await this.runs.resumeProcessWait(sessionId, current.runId, current.revision);
      const handle = this.remember(result.snapshot);
      return {
        handle,
        processIds: result.processIds,
        continuationId: result.continuationId,
        expectedBoundary: result.expectedBoundary,
      };
    });
  }

  listProcessWaits(): DurableProcessWait[] {
    return this.runs?.listProcessWaits() ?? [];
  }

  finish(
    handle: ManagerRunHandle,
    outcome: 'complete' | 'fail' | 'cancel',
    reason: string,
  ): Promise<void> {
    return this.serialized(handle.sessionId, async () => {
      if (this.detached) return;
      const lease = this.ownedLease(handle);
      if (!lease) return;
      if (!this.runs) {
        this.releaseHandle(handle);
        return;
      }
      if (outcome === 'complete') {
        await this.runs.complete(handle.sessionId, handle.runId, lease.revision, reason);
      } else if (outcome === 'fail') {
        await this.runs.fail(handle.sessionId, handle.runId, lease.revision, reason);
      } else {
        await this.runs.cancel(handle.sessionId, handle.runId, lease.revision, reason);
      }
      this.releaseHandle(handle);
    });
  }

  /** Explicit user cancellation may target a durable wait after restart. */
  cancelCurrent(sessionId: string, reason: string): Promise<void> {
    return this.serialized(sessionId, async () => {
      if (this.detached) return;
      if (!this.runs) {
        this.leases.delete(sessionId);
        return;
      }
      const snapshot = await this.runs.cancelCurrent(sessionId, reason);
      this.releaseRun(sessionId, snapshot?.runId ?? null);
    });
  }

  failCurrent(sessionId: string, reason: string): Promise<void> {
    return this.serialized(sessionId, async () => {
      if (this.detached) return;
      if (!this.runs) {
        this.leases.delete(sessionId);
        return;
      }
      const snapshot = await this.runs.failCurrent(sessionId, reason);
      this.releaseRun(sessionId, snapshot?.runId ?? null);
    });
  }

  forget(sessionId: string): void {
    this.leases.delete(sessionId);
  }

  isAuthoritativelyLive(sessionId: string): boolean {
    const current = this.runs?.get(sessionId);
    return current?.status === 'active' || current?.status === 'waiting';
  }

  /** Stop all process-local writers before restart/shutdown reconciliation. */
  detach(): void {
    this.detached = true;
    this.leases.clear();
  }

  private ownedLease(handle: ManagerRunHandle): ManagerRunLease | undefined {
    const lease = this.leases.get(handle.sessionId);
    return lease?.runId === handle.runId ? lease : undefined;
  }

  private requireOwnedLease(handle: ManagerRunHandle): ManagerRunLease {
    const lease = this.ownedLease(handle);
    if (!lease) {
      throw new Error(`Manager run ${handle.runId} no longer owns session ${handle.sessionId}`);
    }
    return lease;
  }

  private assertAttached(): void {
    if (this.detached) throw new Error('Manager run lifecycle is shut down');
  }

  private remember(snapshot: {
    sessionId: string;
    runId: string | null;
    revision: number;
    phase: string;
  }): ManagerRunHandle {
    if (!snapshot.runId) throw new Error(`Session ${snapshot.sessionId} has no manager run id`);
    const handle = this.createHandle(snapshot.sessionId, snapshot.runId);
    if (this.detached) return handle;
    const existing = this.leases.get(snapshot.sessionId);
    if (existing && existing.revision > snapshot.revision) {
      return handle;
    }
    this.leases.set(snapshot.sessionId, {
      runId: snapshot.runId,
      revision: snapshot.revision,
      phase: snapshot.phase,
    });
    return handle;
  }

  private createHandle(sessionId: string, runId: string): ManagerRunHandle {
    return Object.freeze({ sessionId, runId }) as ManagerRunHandle;
  }

  private updateLocalLease(
    handle: ManagerRunHandle,
    update: { phase: string; processIds?: string[] },
  ): void {
    const lease = this.ownedLease(handle);
    if (!lease) return;
    this.leases.set(handle.sessionId, {
      ...lease,
      revision: lease.revision + 1,
      phase: update.phase,
      ...(update.processIds === undefined
        ? { processIds: undefined }
        : { processIds: update.processIds }),
    });
  }

  private releaseHandle(handle: ManagerRunHandle): void {
    this.releaseRun(handle.sessionId, handle.runId);
  }

  private releaseRun(sessionId: string, runId: string | null): void {
    if (!runId) return;
    if (this.leases.get(sessionId)?.runId === runId) this.leases.delete(sessionId);
  }

  private serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return result;
  }
}
