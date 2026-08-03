import type { Goal } from '@koryphaios/shared';

export type GoalAction =
  | 'goal_open'
  | 'goal_create'
  | 'goal_invoke'
  | 'goal_pause'
  | 'goal_resume'
  | 'goal_stop'
  | 'goal_prioritize';
export type GoalActionRequest = {
  action: GoalAction;
  objective?: string;
  source?: 'slash' | 'palette' | 'manager' | 'composer';
};

const aliases: Record<string, GoalAction> = {
  open: 'goal_open',
  status: 'goal_open',
  create: 'goal_create',
  new: 'goal_create',
  start: 'goal_invoke',
  run: 'goal_invoke',
  invoke: 'goal_invoke',
  pause: 'goal_pause',
  resume: 'goal_resume',
  continue: 'goal_resume',
  stop: 'goal_stop',
  cancel: 'goal_stop',
  prioritize: 'goal_prioritize',
  priority: 'goal_prioritize',
};

export function parseGoalSlashCommand(args: string[]): GoalActionRequest {
  if (args.length === 0) return { action: 'goal_open', source: 'slash' };
  const command = args[0]!.toLowerCase();
  const action = aliases[command];
  if (!action) return { action: 'goal_create', objective: args.join(' '), source: 'slash' };
  return {
    action,
    objective: action === 'goal_create' ? args.slice(1).join(' ').trim() || undefined : undefined,
    source: 'slash',
  };
}

export const isActiveGoal = (goal: Goal) =>
  ['queued', 'planning', 'running', 'paused', 'blocked'].includes(goal.status);

export function goalRuntimeMs(goal: Goal, now = Date.now()): number {
  const live = goal.status === 'running' && goal.activeStartedAt
    ? Math.max(0, now - goal.activeStartedAt)
    : 0;
  return Math.max(0, goal.activeDurationMs + live);
}

export function formatGoalRuntime(goal: Goal, now = Date.now()): string {
  const totalMinutes = Math.floor(goalRuntimeMs(goal, now) / 60_000);
  if (totalMinutes < 1) return '<1m';
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export type GoalSection = {
  id: 'workspace' | 'project' | 'session' | 'other';
  label: string;
  goals: Goal[];
};

export function groupGoals(goals: Goal[], projectPath?: string, sessionId?: string): GoalSection[] {
  const active = goals.filter(isActiveGoal);
  return [
    {
      id: 'workspace',
      label: 'Workspace · every chat',
      goals: active.filter((goal) => goal.scope === 'workspace'),
    },
    {
      id: 'project',
      label: 'This project',
      goals: active.filter(
        (goal) => goal.scope === 'project' && !!projectPath && goal.projectPath === projectPath,
      ),
    },
    {
      id: 'session',
      label: 'This chat',
      goals: active.filter(
        (goal) => goal.scope === 'session' && !!sessionId && goal.sessionId === sessionId,
      ),
    },
    {
      id: 'other',
      label: 'Other projects and chats',
      goals: active.filter(
        (goal) =>
          (goal.scope === 'project' && goal.projectPath !== projectPath) ||
          (goal.scope === 'session' && goal.sessionId !== sessionId),
      ),
    },
  ];
}

function eligible(goal: Goal, action: GoalAction): boolean {
  if (!isActiveGoal(goal)) return false;
  if (action === 'goal_resume') return goal.status === 'paused' || goal.status === 'blocked';
  if (action === 'goal_pause') return ['queued', 'planning', 'running'].includes(goal.status);
  if (action === 'goal_invoke') return goal.status !== 'running';
  return true;
}

export function pickGoalForAction(
  goals: Goal[],
  selectedId: string,
  action: GoalAction,
  projectPath?: string,
  sessionId?: string,
): Goal | undefined {
  const selected = goals.find((goal) => goal.id === selectedId);
  if (selected && eligible(selected, action)) return selected;
  const ordered = groupGoals(goals, projectPath, sessionId).flatMap((section) => section.goals);
  return ordered.find((goal) => eligible(goal, action));
}
