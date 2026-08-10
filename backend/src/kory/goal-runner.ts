import type { Goal, GoalChecklistItem } from '@koryphaios/shared';
import { GoalStore } from '../stores/goal-store';
import { getProviderHarnessCapabilities } from '../providers/provider-harness';

export interface GoalProviderPolicy {
  allowed: boolean;
  verification: 'eligible' | 'unverified' | 'remote-pending-review';
  reason?: string;
}

/** Goal execution never upgrades an untrusted provider result to verified evidence. */
export function goalProviderPolicy(
  provider: string,
  remotePlanApproved = false,
): GoalProviderPolicy {
  if (provider === 'jules') {
    return remotePlanApproved
      ? {
          allowed: true,
          verification: 'remote-pending-review',
          reason:
            'Jules runs remotely and may only create a reviewable PR; local verification is still required.',
        }
      : {
          allowed: false,
          verification: 'remote-pending-review',
          reason: 'Jules requires explicit plan approval before a cloud run starts.',
        };
  }
  const harness = getProviderHarnessCapabilities(provider);
  return harness.verificationEligible
    ? { allowed: true, verification: 'eligible' }
    : {
        allowed: true,
        verification: 'unverified',
        reason:
          'Native CLI execution lacks OS filesystem isolation; use a managed verifier before completing the goal.',
      };
}

/** Deterministic Goal Mode scheduler; callers execute at most one item per turn. */
export class GoalRunner {
  constructor(private goals: GoalStore) {}
  nextReady(goal: Goal): GoalChecklistItem | undefined {
    return goal.checklist
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.order - b.order)
      .find((item) =>
        item.dependsOn.every(
          (id) => goal.checklist.find((candidate) => candidate.id === id)?.status === 'completed',
        ),
      );
  }
  /** Cross-goal scheduler: priority first, then the user-controlled ordering. */
  async nextEligible(): Promise<Goal | undefined> {
    const goals = await this.goals.list();
    return goals.find(
      (goal) => ['queued', 'planning', 'running'].includes(goal.status) && !!this.nextReady(goal),
    );
  }
  async startNextEligible(): Promise<{ goal?: Goal; item?: GoalChecklistItem; blocked?: string }> {
    const goal = await this.nextEligible();
    return goal ? this.startNext(goal.id) : { blocked: 'No eligible active goals' };
  }
  async startNext(
    goalId: string,
  ): Promise<{ goal?: Goal; item?: GoalChecklistItem; blocked?: string }> {
    const goal = await this.goals.get(goalId);
    if (!goal) return { blocked: 'Goal not found' };
    if (!['queued', 'planning', 'running'].includes(goal.status))
      return { goal, blocked: `Goal is ${goal.status}` };
    const item = this.nextReady(goal);
    if (!item) {
      if (goal.checklist.some((entry) => entry.status !== 'completed'))
        return {
          goal: await this.goals.update(goalId, {
            status: 'blocked',
            blocker: 'No ready checklist item; resolve a dependency or blocker.',
          }),
          blocked: 'No ready checklist item',
        };
      return {
        goal: await this.goals.update(goalId, {
          status: 'paused',
          blocker:
            'Checklist evidence is complete. Run the final success-criteria check before finalizing this goal.',
        }),
        blocked: 'Checklist complete: final verification is required',
      };
    }
    const started = await this.goals.startItem(goalId, item.id);
    return {
      goal: started,
      item: started?.checklist.find((entry) => entry.id === item.id),
    };
  }

  async finalize(goalId: string): Promise<{ goal?: Goal; blocked?: string }> {
    try {
      return { goal: await this.goals.finalize(goalId) };
    } catch (error) {
      return {
        goal: await this.goals.get(goalId),
        blocked: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
