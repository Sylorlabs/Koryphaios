/** Durable, chat-independent goal and checklist contracts. */
export type GoalScope = 'workspace' | 'project' | 'session';
export type GoalStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'cancelled';
export type GoalItemStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'skipped';

export interface GoalEvidence {
  id: string;
  kind: 'check' | 'artifact' | 'note';
  value: string;
  verified: boolean;
  createdAt: number;
}
export interface GoalChecklistItem {
  id: string;
  title: string;
  status: GoalItemStatus;
  order: number;
  dependsOn: string[];
  evidence: GoalEvidence[];
  startedAt?: number;
  completedAt?: number;
}
export interface GoalActivity {
  id: string;
  type: string;
  message: string;
  createdAt: number;
  sessionId?: string;
}
export interface GoalExecutionConfig {
  sessionId: string;
  provider: string;
  model: string;
  reasoningLevel?: string;
  instructions?: string;
  remotePlanApproved?: boolean;
}
export interface Goal {
  id: string;
  objective: string;
  scope: GoalScope;
  projectPath?: string;
  sessionId?: string;
  priority: number;
  sortOrder: number;
  status: GoalStatus;
  checklist: GoalChecklistItem[];
  linkedSessionIds: string[];
  activity: GoalActivity[];
  blocker?: string;
  execution?: GoalExecutionConfig;
  activeDurationMs: number;
  activeStartedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** The execution boundary is recorded with each goal item, never inferred from prose. */
export interface GoalExecutionRecord {
  provider: string;
  mode: 'managed' | 'native-passthrough' | 'cloud';
  verification: 'eligible' | 'unverified' | 'remote-pending-review';
  reason?: string;
}

export const goalProgress = (goal: Pick<Goal, 'checklist'>): number => {
  const total = goal.checklist.length;
  return total === 0
    ? 0
    : Math.round(
        (goal.checklist.filter((item) => item.status === 'completed').length / total) * 100,
      );
};
