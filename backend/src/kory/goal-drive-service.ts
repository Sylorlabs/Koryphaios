import type { Goal, GoalExecutionConfig } from '@koryphaios/shared';
import type { GoalStore } from '../stores/goal-store';
import type { SessionStore } from '../stores/session-store';
import type { WSManager } from '../ws/ws-manager';
import type { KoryManager } from './manager';
import { GoalRunner, goalProviderPolicy } from './goal-runner';
import { koryLog } from '../logger';
import { getWorkflowDefinition, listWorkflowRuns, workflowNextInstruction } from './workflows';

const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  constructor(
    private goals: GoalStore,
    private sessions: SessionStore,
    private kory: KoryManager,
    private wsManager: WSManager,
  ) {}

  private publish(goal: Goal | undefined) {
    if (!goal) return;
    this.wsManager.broadcast({
      type: 'goals.updated',
      payload: { goal },
      timestamp: Date.now(),
      sessionId: goal.sessionId,
    });
  }

  async start(goalId: string, execution: GoalExecutionConfig): Promise<Goal> {
    const prior = await this.goals.get(goalId);
    if (!prior) throw new Error('Goal not found');
    if (prior.status === 'completed' || prior.status === 'cancelled')
      throw new Error('Terminal goals cannot be restarted; create a new goal.');
    const linkedSessionIds = prior.linkedSessionIds.includes(execution.sessionId)
      ? prior.linkedSessionIds
      : [...prior.linkedSessionIds, execution.sessionId];
    const updated = await this.goals.update(goalId, {
      status: 'queued',
      blocker: undefined,
      execution,
      linkedSessionIds,
    });
    if (!updated) throw new Error('Goal not found');
    this.publish(updated);
    this.schedule(goalId);
    return updated;
  }

  async pause(goalId: string, reason = 'Paused by user'): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
    const paused = await this.goals.update(goalId, {
      status: 'paused',
      blocker: reason,
      activity: [
        ...goal.activity,
        { id: crypto.randomUUID(), type: 'goal_paused', message: reason, createdAt: Date.now() },
      ],
    });
    if (!paused) throw new Error('Goal not found');
    if (goal.execution?.sessionId) this.kory.cancelSessionWorkers(goal.execution.sessionId);
    this.publish(paused);
    return paused;
  }

  async resume(goalId: string): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
    if (!goal.execution) throw new Error('Choose a provider model before resuming this goal');
    return this.start(goalId, goal.execution);
  }

  async stop(goalId: string): Promise<Goal> {
    const goal = await this.goals.get(goalId);
    if (!goal) throw new Error('Goal not found');
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
    if (goal.execution?.sessionId) this.kory.cancelSessionWorkers(goal.execution.sessionId);
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
    for (const goal of await this.goals.list()) {
      if (!ACTIVE_STATUSES.has(goal.status) || !goal.execution) continue;
      const running = goal.checklist.find((item) => item.status === 'running');
      if (running)
        await this.goals.resetItem(
          goal.id,
          running.id,
          'Recovered after restart; replaying the interrupted checklist item.',
        );
      this.schedule(goal.id);
    }
  }

  private schedule(goalId: string) {
    if (this.active.has(goalId)) return;
    this.active.add(goalId);
    void this.run(goalId)
      .catch(async (error) => {
        koryLog.error({ goalId, error }, 'Goal Mode durable loop failed');
        const goal = await this.goals.get(goalId);
        const item = goal?.checklist.find((entry) => entry.status === 'running');
        const message = error instanceof Error ? error.message : String(error);
        if (goal && item && goal.execution) {
          const recorded = await this.goals.addActivity(
            goalId,
            'driver_error',
            `${item.id}|${message}`,
            goal.execution.sessionId,
          );
          const repeats =
            recorded?.activity.filter(
              (event) => event.type === 'driver_error' && event.message === `${item.id}|${message}`,
            ).length ?? 0;
          if (repeats >= 3) {
            const adjudication = await this.kory.verifyGoalBlocker(
              goal.execution.sessionId,
              goal.objective,
              item.title,
              `Repeated execution failure: ${message}`,
              goal.execution.model,
            );
            if (adjudication.passed) {
              const prefix = adjudication.skipped
                ? 'Critic disabled; failure repeated across 3 attempts'
                : 'Critic confirmed repeated execution failure';
              const blocked = await this.goals.update(goalId, {
                status: 'blocked',
                blocker: `${prefix}: ${message}`,
              });
              this.publish(blocked);
            } else {
              this.publish(
                await this.goals.resetItem(
                  goalId,
                  item.id,
                  adjudication.feedback ??
                    'The Critic rejected the execution failure as a terminal blocker; retrying.',
                ),
              );
            }
          }
        }
        await sleep(1_000);
      })
      .finally(async () => {
        this.active.delete(goalId);
        const goal = await this.goals.get(goalId);
        if (goal?.execution && ACTIVE_STATUSES.has(goal.status)) this.schedule(goalId);
      });
  }

  private async waitUntilSessionIdle(sessionId: string, goalId: string): Promise<boolean> {
    while (this.kory.isSessionRunning(sessionId)) {
      const goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return false;
      await sleep(250);
    }
    return true;
  }

  private blockerCandidates(goal: Goal, itemId: string): string[] {
    return goal.activity
      .filter(
        (event) => event.type === 'blocker_candidate' && event.message.startsWith(`${itemId}|`),
      )
      .map((event) => event.message.slice(itemId.length + 1));
  }

  private evidenceCandidates(goal: Goal, itemId: string): string[] {
    return goal.activity
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

  private async run(goalId: string): Promise<void> {
    let verificationFeedback = '';
    while (true) {
      let goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return;
      const execution = goal.execution;
      if (!execution) return;
      const session = await this.sessions.get(execution.sessionId);
      if (!session) {
        const blocked = await this.goals.update(goalId, {
          status: 'blocked',
          blocker: 'The execution chat no longer exists. Choose another chat to resume.',
        });
        this.publish(blocked);
        return;
      }
      if (!(await this.waitUntilSessionIdle(execution.sessionId, goalId))) return;

      const policy = goalProviderPolicy(execution.provider, execution.remotePlanApproved === true);
      if (!policy.allowed) {
        const paused = await this.goals.update(goalId, {
          status: 'paused',
          blocker: policy.reason,
        });
        this.publish(paused);
        return;
      }

      let item = goal.checklist.find((entry) => entry.status === 'running');
      if (!item) {
        if (goal.checklist.every((entry) => entry.status === 'completed')) {
          const finalized = await new GoalRunner(this.goals).finalize(goalId);
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

      const workflowRoot =
        (session as { workingDirectory?: string }).workingDirectory ??
        currentGoal.projectPath ??
        process.cwd();
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
      await this.goals.addActivity(
        goalId,
        'provider_dispatched',
        `${execution.provider}: ${policy.verification}`,
        execution.sessionId,
      );
      await this.kory.processTask(
        execution.sessionId,
        prompt,
        execution.model,
        execution.reasoningLevel,
        undefined,
        undefined,
        undefined,
        {
          goalId: currentGoal.id,
          objective: currentGoal.objective,
          itemId: currentItem.id,
          itemTitle: currentItem.title,
          verification: policy.verification,
        },
      );

      goal = await this.goals.get(goalId);
      if (!goal || !ACTIVE_STATUSES.has(goal.status)) return;
      const linkedAfter = listWorkflowRuns(workflowRoot, execution.sessionId).filter(
        (run) => run.goalId === goal!.id && run.goalItemId === currentItem.id,
      );
      const blockedWorkflow = linkedAfter.find((run) => run.status === 'blocked');
      if (blockedWorkflow) {
        const candidate = `Workflow ${blockedWorkflow.id} blocked: ${blockedWorkflow.blocker ?? 'No concrete blocker was recorded'}`;
        await this.goals.addActivity(
          goalId,
          'blocker_candidate',
          `${item.id}|${candidate}`,
          execution.sessionId,
        );
        goal = (await this.goals.get(goalId)) ?? goal;
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
          await this.goals.addActivity(
            goalId,
            'workflow_linked',
            `${runningWorkflow.id}|${getWorkflowDefinition(runningWorkflow.workflowId)?.name ?? runningWorkflow.workflowId}`,
            execution.sessionId,
          );
        }
        verificationFeedback = `The linked ${getWorkflowDefinition(runningWorkflow.workflowId)?.name ?? 'workflow'} is not complete. ${workflowNextInstruction(runningWorkflow)}`;
        const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback);
        this.publish(retrying);
        await sleep(1_000);
        continue;
      }
      for (const completedWorkflow of linkedAfter.filter((run) => run.status === 'completed')) {
        const alreadyPromoted = goal.activity.some(
          (event) =>
            event.type === 'workflow_evidence' &&
            event.message.startsWith(`${completedWorkflow.id}|`),
        );
        if (alreadyPromoted) continue;
        const evidence = completedWorkflow.evidence
          .map((entry) => `${entry.stageId}: ${entry.value}`)
          .join('\n');
        await this.goals.addActivity(
          goalId,
          'workflow_evidence',
          `${completedWorkflow.id}|${completedWorkflow.workflowId}|${completedWorkflow.evidence.length} stages`,
          execution.sessionId,
        );
        await this.goals.addActivity(
          goalId,
          'evidence_candidate',
          `${item.id}|Completed linked workflow ${completedWorkflow.id}:\n${evidence}`,
          execution.sessionId,
        );
        goal = (await this.goals.get(goalId)) ?? goal;
      }
      const blocker = this.repeatedBlocker(goal, item.id);
      if (blocker) {
        const adjudication = await this.kory.verifyGoalBlocker(
          execution.sessionId,
          goal.objective,
          item.title,
          blocker,
          execution.model,
        );
        if (adjudication.passed) {
          const prefix = adjudication.skipped
            ? 'Critic disabled; blocker repeated across 3 attempts'
            : 'Critic confirmed after 3 attempts';
          const blocked = await this.goals.update(goalId, {
            status: 'blocked',
            blocker: `${prefix}: ${blocker}`,
          });
          this.publish(blocked);
          return;
        }
        verificationFeedback =
          adjudication.feedback ??
          'The Critic rejected the proposed blocker; continue with another approach.';
        const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback);
        this.publish(retrying);
        await sleep(1_000);
        continue;
      }
      if (this.blockerCandidates(goal, item.id).length > blockerCountBefore) {
        verificationFeedback =
          'The proposed blocker is not yet established. Continue trying safe alternatives.';
        const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback);
        this.publish(retrying);
        await sleep(1_000);
        continue;
      }

      const evidenceCandidates = this.evidenceCandidates(goal, item.id);
      if (evidenceCandidates.length === evidenceCountBefore) {
        verificationFeedback =
          'No concrete completion evidence was recorded. Continue the item and call update_goal with the checks or artifacts that prove it is complete.';
        const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback);
        this.publish(retrying);
        await sleep(1_000);
        continue;
      }

      // Even native-passthrough and remote producers may finish an item when a
      // separate managed critic can verify their concrete local result.
      const verification = await this.kory.verifyGoalItem(
        execution.sessionId,
        goal.objective,
        item.title,
        execution.model,
      );
      if (verification.passed) {
        const completed = await this.goals.completeItem(goalId, item.id, {
          kind: 'check',
          value: verification.skipped
            ? `Critic disabled by user; producer evidence accepted without a critic pass: ${evidenceCandidates.at(-1)}`
            : `Producer evidence: ${evidenceCandidates.at(-1)}\nIndependent Goal Mode critic PASS${verification.feedback ? `: ${verification.feedback}` : ''}`,
        });
        this.publish(completed);
        verificationFeedback = '';
        continue;
      }

      verificationFeedback =
        verification.feedback ?? 'The item lacks independently verified completion evidence.';
      const retrying = await this.goals.resetItem(goalId, item.id, verificationFeedback);
      this.publish(retrying);
      await sleep(1_000);
    }
  }
}
