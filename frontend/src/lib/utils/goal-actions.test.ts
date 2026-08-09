import { describe, expect, test } from 'vitest';
import type { Goal } from '@koryphaios/shared';
import { formatGoalRuntime, goalRuntimeMs, groupGoals, parseGoalSlashCommand, pickGoalForAction } from './goal-actions';

const goal = (
  id: string,
  scope: Goal['scope'],
  status: Goal['status'],
  extra: Partial<Goal> = {},
): Goal => ({
  id,
  objective: id,
  scope,
  status,
  priority: 0,
  sortOrder: 0,
  checklist: [],
  linkedSessionIds: [],
  activity: [],
  activeDurationMs: 0,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('Goal Mode command grammar', () => {
  test('supports explicit lifecycle commands and objective shorthand', () => {
    expect(parseGoalSlashCommand([]).action).toBe('goal_open');
    expect(parseGoalSlashCommand(['resume']).action).toBe('goal_resume');
    expect(parseGoalSlashCommand(['pause']).action).toBe('goal_pause');
    expect(parseGoalSlashCommand(['stop']).action).toBe('goal_stop');
    expect(parseGoalSlashCommand(['create', 'Ship', 'it'])).toMatchObject({
      action: 'goal_create',
      objective: 'Ship it',
    });
    expect(parseGoalSlashCommand(['Ship', 'release'])).toMatchObject({
      action: 'goal_create',
      objective: 'Ship release',
    });
  });
});

describe('Goal Mode context separation', () => {
  const goals = [
    goal('w', 'workspace', 'queued'),
    goal('p', 'project', 'running', { projectPath: '/p' }),
    goal('s', 'session', 'paused', { sessionId: 's1' }),
    goal('other', 'project', 'queued', { projectPath: '/other' }),
  ];
  test('groups workspace, current project, current chat, and other contexts', () => {
    expect(
      groupGoals(goals, '/p', 's1').map((section) => section.goals.map((entry) => entry.id)),
    ).toEqual([['w'], ['p'], ['s'], ['other']]);
  });
  test('resume finds a paused contextual goal when the selection is ineligible', () => {
    expect(pickGoalForAction(goals, 'p', 'goal_resume', '/p', 's1')?.id).toBe('s');
  });
});

describe('Goal Mode active time', () => {
  test('shows minutes, hours, and days while keeping paused time frozen', () => {
    const now = 2_000_000_000;
    const running = goal('runtime', 'workspace', 'running', { activeDurationMs: 60_000, activeStartedAt: now - ((2 * 86_400_000) + (3 * 3_600_000) + (4 * 60_000)) });
    expect(formatGoalRuntime(running, now)).toBe('2d 3h 5m');
    expect(goalRuntimeMs(running, now)).toBe((2 * 86_400_000) + (3 * 3_600_000) + (5 * 60_000));
    expect(formatGoalRuntime(goal('paused', 'workspace', 'paused', { activeDurationMs: (4 * 3_600_000) + (7 * 60_000), activeStartedAt: now - 99_000_000 }), now)).toBe('4h 7m');
  });
});
