import type { Goal, GoalStatus } from '@koryphaios/shared';

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
  const live =
    goal.status === 'running' && goal.activeStartedAt ? Math.max(0, now - goal.activeStartedAt) : 0;
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

/** Format a millisecond span with the two largest meaningful units, down to
 *  seconds: `12s`, `45m 30s`, `4h 7m 12s`, `2d 3h 4m`. */
export function formatGoalSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Second-resolution goal duration, used by the Goal Mode bubble so users can
 *  see exactly how long a goal has been going. */
export function formatGoalRuntimeLong(goal: Goal, now = Date.now()): string {
  return formatGoalSpan(goalRuntimeMs(goal, now));
}

/** The three quick-control buckets Goal Mode groups goals into. `going` covers
 *  goals that are on deck (queued/planning); `paused` covers anything the
 *  manager is not advancing (paused/blocked). */
export type GoalPhase = 'running' | 'paused' | 'going';

export function goalPhase(goal: Goal): GoalPhase {
  if (goal.status === 'running') return 'running';
  if (goal.status === 'paused' || goal.status === 'blocked') return 'paused';
  return 'going';
}

export const GOAL_PHASE_ORDER: GoalPhase[] = ['running', 'paused', 'going'];

export const GOAL_PHASE_LABEL: Record<GoalPhase, string> = {
  running: 'Running',
  paused: 'Paused',
  going: 'Going',
};

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

/** The chat a goal is being executed in, falling back to the chat that owns it. */
export const goalChatId = (goal: Goal): string | undefined =>
  goal.execution?.sessionId ?? goal.sessionId;

/** Human label for a goal's raw lifecycle status. */
export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  paused: 'Paused',
  blocked: 'Blocked',
  completed: 'Completed',
  cancelled: 'Stopped',
};

/** The lifecycle verb the steering bar should offer for a goal, derived from
 *  its status. `null` means the goal is no longer steerable. */
export function goalSteeringAction(goal: Goal): 'start' | 'pause' | 'resume' | null {
  if (goal.status === 'running') return 'pause';
  if (goal.status === 'paused' || goal.status === 'blocked') return 'resume';
  if (goal.status === 'queued' || goal.status === 'planning') return 'start';
  return null;
}

/** The goal the steering bar is currently driving. Preference order is the
 *  goal the user last selected, then the one running in this chat, then the
 *  first active goal. Finished goals are never selected so the bar cannot get
 *  stuck on stale state. */
export function pickSteeredGoal(
  goals: Goal[],
  selectedId: string,
  sessionId?: string,
): Goal | undefined {
  const selected = goals.find((goal) => goal.id === selectedId);
  if (selected && isActiveGoal(selected)) return selected;
  const inThisChat = goals.find(
    (goal) => isActiveGoal(goal) && sessionId && goalChatId(goal) === sessionId,
  );
  if (inThisChat) return inThisChat;
  return goals.find(isActiveGoal);
}

/**
 * Why a goal is not advancing, with the status word removed.
 *
 * Blockers are stored as sentences that restate the state -- "Paused because
 * its chat was deleted" -- because that is the correct thing for a log line.
 * The steering surface already shows a PAUSED/BLOCKED badge above the banner,
 * so repeating the word made a paused goal say it three times over. Strip the
 * leading clause; the reason alone is what the banner is for.
 */
export function goalBlockerReason(goal: Pick<Goal, 'blocker'>): string {
  const blocker = goal.blocker?.trim() ?? '';
  if (!blocker) return '';
  // Only strip when the status word introduces a clause. "Paused because X" and
  // "Blocked: X" leave a reason behind; "Paused by user" does not, and cutting
  // the word off that would leave the fragment "by user".
  const stripped = blocker.replace(
    /^(paused|blocked|running|stopped|queued|planning)\b\s*(?:because\b|[:;,]\s*)/i,
    '',
  );
  return stripped.trim() || blocker;
}

/** One shape for a human-authored checklist change: the plan's structure only.
 *  Status and evidence are never sent -- the server carries them over. */
export type ChecklistEdit = { id?: string; title: string; order: number; dependsOn: string[] };

/** Serialize a goal's checklist into an editable plan, ordered for display. */
export function toChecklistPlan(goal: Goal): ChecklistEdit[] {
  return [...goal.checklist]
    .sort((a, b) => a.order - b.order)
    .map((item, index) => ({
      id: item.id,
      title: item.title,
      order: index,
      dependsOn: item.dependsOn.filter((dependency) =>
        goal.checklist.some((entry) => entry.id === dependency),
      ),
    }));
}

/** Reorder a plan after a check moves within the list. The generated plans
 *  chain each check to the one before it, so a move rebuilds that chain rather
 *  than leaving dependency order disagreeing with the visible order. */
export function moveChecklistItem(
  plan: ChecklistEdit[],
  from: number,
  to: number,
): ChecklistEdit[] {
  if (from === to || from < 0 || to < 0 || from >= plan.length || to >= plan.length) return plan;
  const next = [...plan];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.map((item, index) => ({
    ...item,
    order: index,
    dependsOn: index === 0 ? [] : [next[index - 1]!.id!],
  }));
}

/** Active goals bucketed for the quick controls: running, paused, then going. */
export function goalsByPhase(goals: Goal[]): { phase: GoalPhase; goals: Goal[] }[] {
  const active = goals.filter(isActiveGoal);
  return GOAL_PHASE_ORDER.map((phase) => ({
    phase,
    goals: active.filter((goal) => goalPhase(goal) === phase),
  })).filter((bucket) => bucket.goals.length > 0);
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
