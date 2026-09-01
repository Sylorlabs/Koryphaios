import type { Goal, GoalExecutionConfig } from '@koryphaios/shared';
import { sanitizeGoalEvidence, type GoalStore } from '../stores/goal-store';
import type { SessionStore } from '../stores/session-store';
import type { WSManager } from '../ws/ws-manager';
import type { KoryManager } from './manager';
import { GoalRunner, goalProviderPolicy } from './goal-runner';
import { koryLog } from '../logger';
import { getWorkflowDefinition, listWorkflowRuns, workflowNextInstruction } from './workflows';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { processSupervisor, type AgentToolBarrierLease } from '../process-supervisor/supervisor';
import type { CheckpointStore } from './checkpoint-store';

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type GoalCheckpointStore = Pick<CheckpointStore, 'createGhostCommit'>;

export interface GoalDriveServiceOptions {
  checkpointIntervalMs?: number;
  checkpointStoreFactory?: (
    workingDirectory: string,
  ) => GoalCheckpointStore | Promise<GoalCheckpointStore>;
  acquireSessionMutationBarrier?: (sessionId: string) => { release(): void } | null;
  acquireAgentToolBarrier?: (sessionId: string) => AgentToolBarrierLease | null;
  /** Test/diagnostic override; production retries remain one second apart. */
  retryDelayMs?: number;
}

export interface GoalSessionErasureLease {
  waitForIdle(timeoutMs?: number): Promise<void>;
  complete(): void;
  rollback(): Promise<void>;
}

/**
 * Backend-owned durable Goal Mode loop.
 *
 * A browser tab is never responsible for continuation. Execution routing is
 * persisted with the goal, every item is independently critic-gated, and the
 * loop exits only for completion, an explicit human pause/stop, or a repeated
 * concrete blocker.
 */
export class GoalDriveService {
  private active = new Set<string>();
  /** Per-goal periodic checkpoint timers (30 min interval). */
  private checkpointTimers = new Map<string, NodeJS.Timeout>();
  private checkpointInFlight = new Set<string>();
  private goalTurnInFlight = new Set<string>();
  private erasingSessions = new Set<string>();
  private static readonly CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;

  constructor(
    private goals: GoalStore,
    private sessions: SessionStore,
    private kory: KoryManager,
    private wsManager: WSManager,
    private options: GoalDriveServiceOptions = {},
  ) {}

  private publish(goal: Goal | undefined) {
    if (!goal) return;
    if (
      (goal.sessionId && this.erasingSessions.has(goal.sessionId)) ||
      (goal.execution?.sessionId && this.erasingSessions.has(goal.execution.sessionId))
    ) {
      return;
    }
    this.wsManager.broadcast({
      type: 'goals.updated',
      payload: { goal },
      timestamp: Date.now(),
      sessionId: goal.sessionId,
    });
  }

  async start(goalId: string, execution: GoalExecutionConfig): Promise<Goal> {
    if (this.erasingSessions.has(execution.sessionId)) {
      throw new Error('Goal execution refused because this session is being deleted');
    }
    let prior = await this.goals.get(goalId);
    if (!prior) throw new Error('Goal not found');
    if (prior.status === 'completed' || prior.status === 'cancelled')
      throw new Error('Terminal goals cannot be restarted; create a new goal.');
    if (this.active.has(goalId) || prior.status === 'running' || prior.status === 'planning') {
      throw new Error('Goal is already running');
    }
    if (!execution.provider.trim() || !execution.model.trim()) {
      throw new Error('Goal execution requires an explicit provider and model');
    }
    if (prior.scope === 'session' && prior.sessionId !== execution.sessionId) {
      throw new Error('This session goal can only run in its owning chat');
    }
    const hasExecution =
      typeof this.kory.hasActiveSessionExecution === 'function'
        ? this.kory.hasActiveSessionExecution(execution.sessionId)
        : this.kory.isSessionRunning(execution.sessionId);
    const admissionLease = hasExecution
      ? null
      : (
          this.options.acquireSessionMutationBarrier ??
          ((sessionId: string) => this.kory.tryAcquireSessionMutationBarrier(sessionId))
        )(execution.sessionId);
    if (!hasExecution && !admissionLease) {
      throw new Error('Goal start refused while the chat archive or recovery state is changing');
    }
    try {
      const session = await this.sessions.getActive(execution.sessionId);
      if (!session)
        throw new Error('Recover the archived execution chat before starting this Goal');
      this.resolveWorkingDirectory(prior, session);
      const resumed = prior.status === 'paused' || prior.status === 'blocked';
      prior = (await this.goals.reopenUnverifiedItems(goalId)) ?? prior;
      const attemptStartedAt = Date.now();
      const attemptId = crypto.randomUUID();
      const executionAttempt: GoalExecutionConfig = {
        ...execution,
        attemptId,
        attemptStartedAt,
      };
      const linkedSessionIds = prior.linkedSessionIds.includes(execution.sessionId)
        ? prior.linkedSessionIds
        : [...prior.linkedSessionIds, execution.sessionId];
      let updated = await this.goals.update(goalId, {
        status: 'queued',
        blocker: undefined,
        execution: executionAttempt,
        linkedSessionIds,
        activity: [
          ...prior.activity,
          {
            id: crypto.randomUUID(),
            type: 'execution_attempt_started',
            message: `${attemptId}|${resumed ? 'resumed' : 'started'}`,
            sessionId: execution.sessionId,
            createdAt: attemptStartedAt,
          },
        ],
      });
      if (!updated) throw new Error('Goal not found');
      const interrupted = updated.checklist.find((item) => item.status === 'running');
      if (interrupted) {
        updated = await this.goals.resetItem(
          goalId,
          interrupted.id,
          resumed
            ? 'Resumed in a fresh execution attempt; replaying the interrupted checklist item.'
            : 'Starting in a fresh execution attempt; replaying the interrupted checklist item.',
          attemptId,
        );
        if (!updated) throw new Error('Goal execution attempt changed before it could start');
      }
      this.publish(updated);
      this.schedule(goalId);
      return updated;
    } finally {
      admissionLease?.release();
    }
  }

  async pause(goalId: string, reason = 'Paused by user'): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
    if (goal.status === 'completed' || goal.status === 'cancelled') {
      throw new Error('Terminal goals cannot be paused');
    }
    if (goal.status === 'paused') return goal;
    const paused = await this.goals.update(goalId, {
      status: 'paused',
      blocker: reason,
      activity: [
        ...goal.activity,
        { id: crypto.randomUUID(), type: 'goal_paused', message: reason, createdAt: Date.now() },
      ],
    });
    if (!paused) throw new Error('Goal not found');
    this.stopCheckpointTimer(goalId);
    if (goal.execution?.sessionId) await this.kory.cancelSessionWorkers(goal.execution.sessionId);
    this.publish(paused);
    return paused;
  }

  async resume(goalId: string): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
    if (goal.status !== 'paused' && goal.status !== 'blocked') {
      throw new Error('Only paused or blocked goals can be resumed');
    }
    if (!goal.execution) throw new Error('Choose a provider model before resuming this goal');
    return this.start(goalId, goal.execution);
  }

  async stop(goalId: string): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
    if (goal.status === 'completed') throw new Error('Completed goals cannot be stopped');
    if (goal.status === 'cancelled') return goal;
    const stopped = await this.goals.update(goalId, {
      status: 'cancelled',
      blocker: 'Stopped by user',
      activity: [
        ...goal.activity,
        {
          id: crypto.randomUUID(),
          type: 'goal_cancelled',
          message: 'Goal stopped by user',
          createdAt: Date.now(),
        },
      ],
    });
    if (!stopped) throw new Error('Goal not found');
    this.stopCheckpointTimer(goalId);
    if (goal.execution?.sessionId) await this.kory.cancelSessionWorkers(goal.execution.sessionId);
    this.publish(stopped);
    return stopped;
  }

  async pauseForSession(sessionId: string): Promise<void> {
    const goals = await this.goals.list();
    for (const goal of goals) {
      if (ACTIVE_STATUSES.has(goal.status) && goal.execution?.sessionId === sessionId) {
        await this.pause(goal.id, 'Paused because the human interrupted its active chat');
      }
    }
  }

  async recover(): Promise<void> {
    for (let goal of await this.goals.list()) {
      if (!ACTIVE_STATUSES.has(goal.status) || !goal.execution) continue;
      if (this.erasingSessions.has(goal.execution.sessionId)) continue;
      if (!goal.execution.attemptId || !goal.execution.attemptStartedAt) {
        const attemptStartedAt = Date.now();
        const attemptId = crypto.randomUUID();
        goal =
          (await this.goals.update(goal.id, {
            execution: { ...goal.execution, attemptId, attemptStartedAt },
            activity: [
              ...goal.activity,
              {
                id: crypto.randomUUID(),
                type: 'execution_attempt_started',
                message: `${attemptId}|recovered`,
                sessionId: goal.execution.sessionId,
                createdAt: attemptStartedAt,
              },
            ],
          })) ?? goal;
      }
      goal = (await this.goals.reopenUnverifiedItems(goal.id)) ?? goal;
      const attemptId = goal.execution?.attemptId;
      if (!attemptId) continue;
      const running = goal.checklist.find((item) => item.status === 'running');
      if (running) {
        const recovered = await this.goals.resetItem(
          goal.id,
          running.id,
          'Recovered after restart; replaying the interrupted checklist item.',
          attemptId,
        );
        if (!recovered) continue;
      }
      this.schedule(goal.id);
    }
  }

  private schedule(goalId: string) {
    if (this.active.has(goalId)) return;
    this.active.add(goalId);
    this.startCheckpointTimer(goalId);
    void this.run(goalId)
      .catch(async (error) => {
        koryLog.error({ goalId, error }, 'Goal Mode durable loop failed');
        const goal = await this.goals.get(goalId);
        const item = goal?.checklist.find((entry) => entry.status === 'running');
        const message = error instanceof Error ? error.message : String(error);
        const attemptId = goal?.execution?.attemptId;
        if (goal && item && goal.execution && attemptId && ACTIVE_STATUSES.has(goal.status)) {
          const recorded = await this.goals.addActivityForActiveAttempt(
            goalId,
            attemptId,
            'driver_error',
            `${item.id}|${message}`,
            goal.execution.sessionId,
          );
          if (!recorded) return;
          const repeats = this.attemptActivity(recorded).filter(
            (event) => event.type === 'driver_error' && event.message === `${item.id}|${message}`,
          ).length;
          if (repeats >= 3) {
            const adjudication = await this.kory.verifyGoalBlocker(
              goal.execution.sessionId,
              goal.objective,
              item.title,
              `Repeated execution failure: ${message}`,
              goal.execution.model,
              goal.execution.provider,
            );
            if (adjudication.skipped) {
              const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
                status: 'paused',
                blocker:
                  'Independent blocker verification is disabled. Enable the Goal Mode critic and resume to adjudicate the repeated execution failure.',
              });
              if (!paused) return;
              this.publish(paused);
              return;
            }
            if (adjudication.passed) {
              const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
                status: 'blocked',
                blocker: `Critic confirmed repeated execution failure: ${message}`,
              });
              if (!blocked) return;
              this.publish(blocked);
              return;
            } else {
              const retrying = await this.goals.resetItem(
                goalId,
                item.id,
                adjudication.feedback ??
                  'The Critic rejected the execution failure as a terminal blocker; retrying.',
                attemptId,
              );
              if (!retrying) return;
              this.publish(retrying);
            }
          }
        }
        await sleep(this.options.retryDelayMs ?? 1_000);
      })
      .finally(async () => {
        this.active.delete(goalId);
        const goal = await this.goals.get(goalId);
        if (goal?.execution && ACTIVE_STATUSES.has(goal.status)) {
          this.schedule(goalId);
        } else {
          // Goal is done/blocked/cancelled — stop the periodic checkpoint timer.
          this.stopCheckpointTimer(goalId);
        }
      });
  }

  /** Stop Goal producers before session data is erased and keep a tombstone so
   * a stale scheduled callback cannot recreate activity after commit. */
  tryBeginSessionErasure(sessionId: string): GoalSessionErasureLease | null {
    if (this.erasingSessions.has(sessionId)) return null;
    this.erasingSessions.add(sessionId);
    let settled = false;
    return {
      waitForIdle: async (timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          const related = (await this.goals.list()).filter(
            (goal) => goal.sessionId === sessionId || goal.execution?.sessionId === sessionId,
          );
          for (const goal of related) this.stopCheckpointTimer(goal.id);
          const inFlight = related.some(
            (goal) => this.goalTurnInFlight.has(goal.id) || this.checkpointInFlight.has(goal.id),
          );
          if (!inFlight) return;
          if (Date.now() >= deadline) {
            throw new Error('Session erasure timed out waiting for Goal activity to settle');
          }
          await sleep(10);
        }
      },
      complete: () => {
        if (settled) return;
        settled = true;
        // Keep the process-lifetime tombstone. Session IDs are unique and a
        // late Goal callback must never publish or persist against this chat.
        this.erasingSessions.add(sessionId);
      },
      rollback: async () => {
        if (settled) return;
        settled = true;
        this.erasingSessions.delete(sessionId);
        await this.recover();
      },
    };
  }

  /**
   * Start a periodic 30-minute checkpoint timer for a goal.
   * Checkpoints are intentionally deferred while an agent turn or owned
   * background process may still be writing the workspace.
   */
  private startCheckpointTimer(goalId: string): void {
    if (this.checkpointTimers.has(goalId)) return;
    const timer = setInterval(
      () => void this.createGoalCheckpoint(goalId),
      this.options.checkpointIntervalMs ?? GoalDriveService.CHECKPOINT_INTERVAL_MS,
    );
    timer.unref?.();
    this.checkpointTimers.set(goalId, timer);
  }

  private stopCheckpointTimer(goalId: string): void {
    const timer = this.checkpointTimers.get(goalId);
    if (timer) {
      clearInterval(timer);
      this.checkpointTimers.delete(goalId);
    }
  }

  /** Create a periodic goal checkpoint using the goal's session and working directory. */
  private async createGoalCheckpoint(goalId: string): Promise<void> {
    if (this.checkpointInFlight.has(goalId) || this.goalTurnInFlight.has(goalId)) return;
    this.checkpointInFlight.add(goalId);
    let sessionLease: { release(): void } | null = null;
    let processLease: AgentToolBarrierLease | null = null;
    try {
      const goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status) || !goal.execution) {
        this.stopCheckpointTimer(goalId);
        return;
      }
      if (this.erasingSessions.has(goal.execution.sessionId)) return;
      const session = await this.sessions.getActive(goal.execution.sessionId);
      if (!session) throw new Error('Goal execution chat is missing or archived');
      const workingDirectory = this.resolveWorkingDirectory(goal, session);
      if (this.kory.isSessionRunning(goal.execution.sessionId)) {
        koryLog.debug({ goalId }, 'Deferred periodic goal checkpoint until the session is idle');
        return;
      }
      sessionLease = (
        this.options.acquireSessionMutationBarrier ??
        ((sessionId: string) => this.kory.tryAcquireSessionMutationBarrier(sessionId))
      )(goal.execution.sessionId);
      if (!sessionLease) {
        koryLog.debug({ goalId }, 'Deferred periodic goal checkpoint until manager work is idle');
        return;
      }
      processLease = (
        this.options.acquireAgentToolBarrier ??
        ((sessionId: string) => processSupervisor.tryAcquireAgentToolBarrier(sessionId))
      )(goal.execution.sessionId);
      if (!processLease) {
        koryLog.debug({ goalId }, 'Deferred periodic goal checkpoint until agent tools are idle');
        return;
      }
      const changedFiles = this.kory.getRecordedSessionChanges(goal.execution.sessionId);
      if (changedFiles.length === 0) {
        koryLog.debug({ goalId }, 'Skipped periodic goal checkpoint with no owned file changes');
        return;
      }
      // Re-read status immediately before publication so pause/stop takes
      // effect without waiting for another timer tick.
      const current = await this.goals.get(goalId);
      if (
        !current ||
        this.erasingSessions.has(goal.execution.sessionId) ||
        !ACTIVE_STATUSES.has(current.status) ||
        current.execution?.sessionId !== goal.execution.sessionId ||
        this.goalTurnInFlight.has(goalId)
      )
        return;
      const store = this.options.checkpointStoreFactory
        ? await this.options.checkpointStoreFactory(workingDirectory)
        : new (await import('./checkpoint-store')).CheckpointStore(workingDirectory);
      const label = `Goal checkpoint: ${goal.objective.slice(0, 60)}`;
      const hash = await store.createGhostCommit(label, {
        agentId: goal.execution.sessionId,
        checkpointType: 'goal_checkpoint',
        model: goal.execution.model,
        provider: goal.execution.provider,
        summary: label,
        changedFiles,
      });
      if (!hash) throw new Error('Checkpoint publication returned no hash');
      const stillActive = await this.goals.get(goalId);
      if (!stillActive || !ACTIVE_STATUSES.has(stillActive.status)) return;
      const acknowledged = await this.goals.addActivity(
        goalId,
        'goal_checkpoint',
        `${hash}|${changedFiles.length} owned file change${changedFiles.length === 1 ? '' : 's'} checkpointed`,
        goal.execution.sessionId,
      );
      this.publish(acknowledged);
      koryLog.info(
        { goalId, sessionId: goal.execution.sessionId, hash },
        'Periodic goal checkpoint created',
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      koryLog.warn({ goalId, err }, 'Failed to create periodic goal checkpoint — non-fatal');
      const current = await this.goals.get(goalId).catch(() => undefined);
      if (current && ACTIVE_STATUSES.has(current.status)) {
        const recorded = await this.goals
          .addActivity(
            goalId,
            'goal_checkpoint_failed',
            `Periodic checkpoint was not published: ${detail}`,
            current.execution?.sessionId,
          )
          .catch(() => undefined);
        this.publish(recorded);
      }
    } finally {
      processLease?.release();
      sessionLease?.release();
      this.checkpointInFlight.delete(goalId);
    }
  }

  private resolveWorkingDirectory(
    goal: Goal,
    session: { workingDirectory?: string | null },
  ): string {
    const configured = session.workingDirectory?.trim();
    if (!configured) throw new Error('Goal session has no durable project directory');
    const absolute = resolve(configured);
    const stat = lstatSync(absolute);
    if (!stat.isDirectory()) throw new Error('Goal session working directory is not a directory');
    const canonical = realpathSync(absolute);
    if (goal.scope === 'project') {
      if (!goal.projectPath?.trim()) throw new Error('Project goal has no project directory');
      const project = realpathSync(resolve(goal.projectPath));
      if (canonical !== project) {
        throw new Error('This project goal must run in a chat scoped to its project');
      }
    }
    return canonical;
  }

  private async waitUntilCheckpointIdle(goalId: string): Promise<boolean> {
    while (this.checkpointInFlight.has(goalId)) {
      const goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return false;
      await sleep(25);
    }
    return true;
  }

  private async waitUntilSessionIdle(sessionId: string, goalId: string): Promise<boolean> {
    if (this.erasingSessions.has(sessionId)) return false;
    while (this.kory.isSessionRunning(sessionId)) {
      if (this.erasingSessions.has(sessionId)) return false;
      const goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return false;
      await sleep(250);
    }
    return true;
  }

  private blockerCandidates(goal: Goal, itemId: string): string[] {
    return this.attemptActivity(goal)
      .filter(
        (event) => event.type === 'blocker_candidate' && event.message.startsWith(`${itemId}|`),
      )
      .map((event) => event.message.slice(itemId.length + 1));
  }

  private evidenceCandidates(goal: Goal, itemId: string): string[] {
    return this.attemptActivity(goal)
      .filter(
        (event) => event.type === 'evidence_candidate' && event.message.startsWith(`${itemId}|`),
      )
      .map((event) => event.message.slice(itemId.length + 1));
  }

  private repeatedBlocker(goal: Goal, itemId: string): string | undefined {
    const candidates = this.blockerCandidates(goal, itemId);
    const latest = candidates.at(-1);
    return latest && candidates.filter((candidate) => candidate === latest).length >= 3
      ? latest
      : undefined;
  }

  private attemptActivity(goal: Goal): Goal['activity'] {
    const attemptId = goal.execution?.attemptId;
    const attemptStartedAt = goal.execution?.attemptStartedAt;
    if (!attemptId || !attemptStartedAt) return goal.activity;
    const marker = goal.activity.findLastIndex(
      (event) =>
        event.type === 'execution_attempt_started' && event.message.startsWith(`${attemptId}|`),
    );
    return marker >= 0
      ? goal.activity.slice(marker + 1)
      : goal.activity.filter((event) => event.createdAt >= attemptStartedAt);
  }

  private async run(goalId: string): Promise<void> {
    let verificationFeedback = '';
    while (true) {
      let goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return;
      const execution = goal.execution;
      if (!execution) return;
      if (this.erasingSessions.has(execution.sessionId)) return;
      const attemptId = execution.attemptId;
      if (!attemptId) return;
      const session = await this.sessions.getActive(execution.sessionId);
      if (!session) {
        const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'blocked',
          blocker: 'The execution chat is missing or archived. Recover it or choose another chat.',
        });
        if (!blocked) return;
        this.publish(blocked);
        return;
      }
      let workflowRoot: string;
      try {
        workflowRoot = this.resolveWorkingDirectory(goal, session);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'blocked',
          blocker: `Goal execution directory is unavailable: ${detail}`,
        });
        if (!blocked) return;
        this.publish(blocked);
        return;
      }
      if (!(await this.waitUntilSessionIdle(execution.sessionId, goalId))) return;

      const policy = goalProviderPolicy(execution.provider, execution.remotePlanApproved === true);
      if (!policy.allowed) {
        const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'paused',
          blocker: policy.reason,
        });
        if (!paused) return;
        this.publish(paused);
        return;
      }

      let item = goal.checklist.find((entry) => entry.status === 'running');
      if (!item) {
        if (goal.checklist.every((entry) => entry.status === 'completed')) {
          const finalized = await new GoalRunner(this.goals).finalize(goalId);
          if (finalized.blocked) {
            const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
              status: 'paused',
              blocker: finalized.blocked,
            });
            if (!paused) return;
            this.publish(paused);
            return;
          }
          this.publish(finalized.goal);
          return;
        }
        const started = await new GoalRunner(this.goals).startNext(goalId);
        if (!started.item || !started.goal) {
          this.publish(started.goal);
          return;
        }
        item = started.item;
        goal = started.goal;
        this.publish(goal);
      }

      if (!goal || !item) return;
      const currentGoal = goal;
      const currentItem = item;

      const linkedBefore = listWorkflowRuns(workflowRoot, execution.sessionId).filter(
        (run) => run.goalId === currentGoal.id && run.goalItemId === currentItem.id,
      );
      const activeWorkflow = linkedBefore.find((run) => run.status === 'running');
      const prompt = `[GOAL MODE — durable autonomous goal ${currentGoal.id}]
Objective: ${currentGoal.objective}
Active checklist item: ${currentItem.title}
Provider verification status: ${policy.verification}.
${execution.instructions?.trim() ? `User direction for this goal: ${execution.instructions.trim()}\n` : ''}
Continue until this checklist item is genuinely complete. You may invoke a registered workflow when it is relevant; the host links it to this Goal item and requires its evidence gates before accepting completion. Record concrete checks/artifacts with update_goal. Use get_resource_budget when provider capacity or cost affects a decision; missing balance data is unknown, never zero. Do not end merely because progress was made. Report a blocker only after exhausting safe alternatives; a blocker must be authorization, required human input, safety, unavailable external state, or an impossible environment dependency.${activeWorkflow ? `\nContinue the already-linked workflow run ${activeWorkflow.id}: ${workflowNextInstruction(activeWorkflow)}` : ''}${verificationFeedback ? `\nPrevious independent verification failed. Fix these findings before reporting completion:\n${verificationFeedback}` : ''}`;

      const blockerCountBefore = this.blockerCandidates(currentGoal, currentItem.id).length;
      const evidenceCountBefore = this.evidenceCandidates(currentGoal, currentItem.id).length;
      const turnOrdinal = this.attemptActivity(currentGoal).filter(
        (event) => event.type === 'provider_dispatched',
      ).length;
      if (!(await this.waitUntilCheckpointIdle(goalId))) return;
      this.goalTurnInFlight.add(goalId);
      let turnOutcome: Awaited<ReturnType<KoryManager['submitSessionTurn']>>;
      try {
        turnOutcome = await this.kory.submitSessionTurn({
          sessionId: execution.sessionId,
          source: 'goal',
          sourceCommandId: `${goalId}:${attemptId}:${currentItem.id}:${turnOrdinal}`,
          userMessage: prompt,
          preferredModel: execution.model,
          reasoningLevel: execution.reasoningLevel,
          goalContext: {
            goalId: currentGoal.id,
            objective: currentGoal.objective,
            itemId: currentItem.id,
            itemTitle: currentItem.title,
            verification: policy.verification,
          },
        });
      } finally {
        this.goalTurnInFlight.delete(goalId);
      }

      if (turnOutcome.status === 'rejected') {
        throw new Error('Goal turn admission lost a race with another session operation');
      }
      const dispatched = await this.goals.addActivityForActiveAttempt(
        goalId,
        attemptId,
        'provider_dispatched',
        `${execution.provider}: ${policy.verification}; run=${turnOutcome.runId || 'recovered'}`,
        execution.sessionId,
      );
      if (!dispatched) return;
      if (turnOutcome.status === 'waiting') return;
      if (turnOutcome.status === 'cancelled') return;
      if (turnOutcome.status !== 'completed') {
        const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'paused',
          blocker: `The provider turn failed after admission (${turnOutcome.reason ?? turnOutcome.phase}). Automatic replay is disabled because tool side effects may already have occurred. Review the chat and resume explicitly.`,
        });
        if (paused) this.publish(paused);
        return;
      }

      if (this.erasingSessions.has(execution.sessionId)) return;

      goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status) || goal.execution?.attemptId !== attemptId)
        return;
      const linkedAfter = listWorkflowRuns(workflowRoot, execution.sessionId).filter(
        (run) => run.goalId === goal!.id && run.goalItemId === currentItem.id,
      );
      const blockedWorkflow = linkedAfter.find((run) => run.status === 'blocked');
      if (blockedWorkflow) {
        const candidate = `Workflow ${blockedWorkflow.id} blocked: ${blockedWorkflow.blocker ?? 'No concrete blocker was recorded'}`;
        const recorded = await this.goals.addActivityForActiveAttempt(
          goalId,
          attemptId,
          'blocker_candidate',
          `${item.id}|${candidate}`,
          execution.sessionId,
        );
        if (!recorded) return;
        goal = recorded;
      }
      const runningWorkflow = linkedAfter.find((run) => run.status === 'running');
      if (runningWorkflow) {
        if (
          !goal.activity.some(
            (event) =>
              event.type === 'workflow_linked' &&
              event.message.startsWith(`${runningWorkflow.id}|`),
          )
        ) {
          const linked = await this.goals.addActivityForActiveAttempt(
            goalId,
            attemptId,
            'workflow_linked',
            `${runningWorkflow.id}|${getWorkflowDefinition(runningWorkflow.workflowId)?.name ?? runningWorkflow.workflowId}`,
            execution.sessionId,
          );
          if (!linked) return;
          goal = linked;
        }
        verificationFeedback = `The linked ${getWorkflowDefinition(runningWorkflow.workflowId)?.name ?? 'workflow'} is not complete. ${workflowNextInstruction(runningWorkflow)}`;
        const retrying = await this.goals.resetItem(
          goalId,
          item.id,
          verificationFeedback,
          attemptId,
        );
        if (!retrying) return;
        this.publish(retrying);
        await sleep(this.options.retryDelayMs ?? 1_000);
        continue;
      }
      for (const completedWorkflow of linkedAfter.filter((run) => run.status === 'completed')) {
        const alreadyPromoted = this.attemptActivity(goal).some(
          (event) =>
            event.type === 'workflow_evidence' &&
            event.message.startsWith(`${completedWorkflow.id}|`),
        );
        if (alreadyPromoted) continue;
        const evidence = completedWorkflow.evidence
          .map((entry) => `${entry.stageId}: ${entry.value}`)
          .join('\n');
        const promoted = await this.goals.addActivityForActiveAttempt(
          goalId,
          attemptId,
          'workflow_evidence',
          `${completedWorkflow.id}|${completedWorkflow.workflowId}|${completedWorkflow.evidence.length} stages`,
          execution.sessionId,
        );
        if (!promoted) return;
        const recorded = await this.goals.addActivityForActiveAttempt(
          goalId,
          attemptId,
          'evidence_candidate',
          `${item.id}|Completed linked workflow ${completedWorkflow.id}:\n${evidence}`,
          execution.sessionId,
        );
        if (!recorded) return;
        goal = recorded;
      }
      const blocker = this.repeatedBlocker(goal, item.id);
      if (blocker) {
        const adjudication = await this.kory.verifyGoalBlocker(
          execution.sessionId,
          goal.objective,
          item.title,
          blocker,
          execution.model,
          execution.provider,
        );
        if (adjudication.skipped) {
          const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
            status: 'paused',
            blocker:
              'Independent blocker verification is disabled. Enable the Goal Mode critic and resume to adjudicate the submitted blocker.',
          });
          if (!paused) return;
          this.publish(paused);
          return;
        }
        if (adjudication.passed) {
          const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
            status: 'blocked',
            blocker: `Critic confirmed after 3 attempts: ${blocker}`,
          });
          if (!blocked) return;
          this.publish(blocked);
          return;
        }
        verificationFeedback =
          adjudication.feedback ??
          'The Critic rejected the proposed blocker; continue with another approach.';
        const retrying = await this.goals.resetItem(
          goalId,
          item.id,
          verificationFeedback,
          attemptId,
        );
        if (!retrying) return;
        this.publish(retrying);
        await sleep(this.options.retryDelayMs ?? 1_000);
        continue;
      }
      if (this.blockerCandidates(goal, item.id).length > blockerCountBefore) {
        verificationFeedback =
          'The proposed blocker is not yet established. Continue trying safe alternatives.';
        const retrying = await this.goals.resetItem(
          goalId,
          item.id,
          verificationFeedback,
          attemptId,
        );
        if (!retrying) return;
        this.publish(retrying);
        await sleep(this.options.retryDelayMs ?? 1_000);
        continue;
      }

      const evidenceCandidates = this.evidenceCandidates(goal, item.id);
      if (evidenceCandidates.length === evidenceCountBefore) {
        const missingEvidence =
          'No concrete completion evidence was recorded. Continue the item and call update_goal with the checks or artifacts that prove it is complete.';
        const recorded = await this.goals.addActivityForActiveAttempt(
          goalId,
          attemptId,
          'evidence_missing',
          `${item.id}|${missingEvidence}`,
          execution.sessionId,
        );
        if (!recorded) return;
        const repeats = this.attemptActivity(recorded).filter(
          (event) =>
            event.type === 'evidence_missing' && event.message === `${item.id}|${missingEvidence}`,
        ).length;
        if (repeats >= 3) {
          const adjudication = await this.kory.verifyGoalBlocker(
            execution.sessionId,
            goal.objective,
            item.title,
            'The producer returned from three consecutive attempts without submitting any concrete completion evidence.',
            execution.model,
            execution.provider,
          );
          if (adjudication.skipped) {
            const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
              status: 'paused',
              blocker:
                'Independent blocker verification is disabled. Enable the Goal Mode critic and resume to adjudicate repeated missing producer evidence.',
            });
            if (!paused) return;
            this.publish(paused);
            return;
          }
          if (adjudication.passed) {
            const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
              status: 'blocked',
              blocker:
                'Critic confirmed the producer repeatedly returned without concrete completion evidence.',
            });
            if (!blocked) return;
            this.publish(blocked);
            return;
          }
          verificationFeedback = adjudication.feedback
            ? sanitizeGoalEvidence(adjudication.feedback)
            : missingEvidence;
        } else {
          verificationFeedback = missingEvidence;
        }
        const retrying = await this.goals.resetItem(
          goalId,
          item.id,
          verificationFeedback,
          attemptId,
        );
        if (!retrying) return;
        this.publish(retrying);
        await sleep(this.options.retryDelayMs ?? 1_000);
        continue;
      }

      // Even native-passthrough and remote producers may finish an item when a
      // separate managed critic can verify their concrete local result.
      let verification: Awaited<ReturnType<KoryManager['verifyGoalItem']>>;
      try {
        verification = await this.kory.verifyGoalItem(
          execution.sessionId,
          goal.objective,
          item.title,
          evidenceCandidates.at(-1)!,
          execution.model,
          execution.provider,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        verification = {
          passed: false,
          feedback: sanitizeGoalEvidence(`Independent verifier failed to run: ${detail}`),
        };
      }
      const reviewed = await this.goals.completeItem(
        goalId,
        item.id,
        {
          producer: {
            kind: 'check',
            value: evidenceCandidates.at(-1)!,
            provider: execution.provider,
            model: execution.model,
          },
          verifier: verification,
        },
        attemptId,
      );
      if (!reviewed) return;
      this.publish(reviewed);
      const reviewedItem = reviewed.checklist.find((entry) => entry.id === item.id);
      if (reviewedItem?.status === 'completed') {
        verificationFeedback = '';
        continue;
      }

      if (verification.skipped) {
        const paused = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'paused',
          blocker:
            'Independent verification is disabled. Enable the Goal Mode critic and resume to verify the submitted producer evidence.',
        });
        if (!paused) return;
        this.publish(paused);
        return;
      }

      const persistedVerdict = reviewedItem?.evidence.findLast(
        (evidence) => evidence.source === 'verifier',
      )?.value;
      verificationFeedback = persistedVerdict
        ? sanitizeGoalEvidence(persistedVerdict)
        : verification.feedback
          ? sanitizeGoalEvidence(verification.feedback)
          : 'The item lacks independently verified completion evidence.';
      const recordedFailure = await this.goals.addActivityForActiveAttempt(
        goalId,
        attemptId,
        'verification_failure',
        `${item.id}|${verificationFeedback}`,
        execution.sessionId,
      );
      if (!recordedFailure) return;
      const repeatedVerificationFailures = this.attemptActivity(recordedFailure).filter(
        (event) =>
          event.type === 'verification_failure' &&
          event.message === `${item.id}|${verificationFeedback}`,
      ).length;
      if (repeatedVerificationFailures >= 3) {
        const blocked = await this.goals.transitionActiveAttempt(goalId, attemptId, {
          status: 'blocked',
          blocker: `Independent verification failed with the same concrete result after 3 attempts: ${verificationFeedback}`,
        });
        if (!blocked) return;
        this.publish(blocked);
        return;
      }
      const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback, attemptId);
      if (!retrying) return;
      this.publish(retrying);
      await sleep(this.options.retryDelayMs ?? 1_000);
    }
  }
}
