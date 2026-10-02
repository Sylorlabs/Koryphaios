import { describe, expect, test } from 'vitest';
import type { Goal } from '@koryphaios/shared';
import {
  formatGoalRuntime,
  formatGoalRuntimeLong,
  formatGoalSpan,
  goalRuntimeMs,
  goalsByPhase,
  goalBlockerReason,
  goalSteeringAction,
  groupGoals,
  moveChecklistItem,
  parseGoalSlashCommand,
  pickGoalForAction,
  pickSteeredGoal,
  toChecklistPlan,
} from './goal-actions';

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
    const running = goal('runtime', 'workspace', 'running', {
      activeDurationMs: 60_000,
      activeStartedAt: now - (2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000),
    });
    expect(formatGoalRuntime(running, now)).toBe('2d 3h 5m');
    expect(goalRuntimeMs(running, now)).toBe(2 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000);
    expect(
      formatGoalRuntime(
        goal('paused', 'workspace', 'paused', {
          activeDurationMs: 4 * 3_600_000 + 7 * 60_000,
          activeStartedAt: now - 99_000_000,
        }),
        now,
      ),
    ).toBe('4h 7m');
  });

  test('Goal Mode shows seconds, minutes, hours, and days', () => {
    expect(formatGoalSpan(0)).toBe('0s');
    expect(formatGoalSpan(12_400)).toBe('12s');
    expect(formatGoalSpan(45 * 60_000 + 30_000)).toBe('45m 30s');
    expect(formatGoalSpan(4 * 3_600_000 + 7 * 60_000 + 12_000)).toBe('4h 7m 12s');
    expect(formatGoalSpan(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000)).toBe('2d 3h 4m');
  });

  test('long runtime format counts only active time', () => {
    const now = 2_000_000_000;
    expect(
      formatGoalRuntimeLong(
        goal('live', 'workspace', 'running', {
          activeDurationMs: 30_000,
          activeStartedAt: now - 20_000,
        }),
        now,
      ),
    ).toBe('50s');
    // A paused goal never accrues live time, even with a stale started stamp.
    expect(
      formatGoalRuntimeLong(
        goal('frozen', 'workspace', 'paused', {
          activeDurationMs: 5_000,
          activeStartedAt: now - 600_000,
        }),
        now,
      ),
    ).toBe('5s');
  });
});

describe('Goal Mode quick controls', () => {
  test('buckets active goals into running, paused, and going', () => {
    const goals = [
      goal('r', 'workspace', 'running'),
      goal('p', 'workspace', 'paused'),
      goal('b', 'workspace', 'blocked'),
      goal('q', 'workspace', 'queued'),
      goal('pl', 'workspace', 'planning'),
      goal('done', 'workspace', 'completed'),
    ];
    expect(
      goalsByPhase(goals).map((bucket) => [bucket.phase, bucket.goals.map((g) => g.id)]),
    ).toEqual([
      ['running', ['r']],
      ['paused', ['p', 'b']],
      ['going', ['q', 'pl']],
    ]);
  });
});

describe('Goal Mode steering control', () => {
  test('collapses lifecycle into one context-aware action', () => {
    expect(goalSteeringAction(goal('a', 'workspace', 'queued'))).toBe('start');
    expect(goalSteeringAction(goal('b', 'workspace', 'planning'))).toBe('start');
    expect(goalSteeringAction(goal('c', 'workspace', 'running'))).toBe('pause');
    expect(goalSteeringAction(goal('d', 'workspace', 'paused'))).toBe('resume');
    expect(goalSteeringAction(goal('e', 'workspace', 'blocked'))).toBe('resume');
    expect(goalSteeringAction(goal('f', 'workspace', 'completed'))).toBeNull();
    expect(goalSteeringAction(goal('g', 'workspace', 'cancelled'))).toBeNull();
  });

  test('prefers the selected goal, then this chat, then any active goal', () => {
    const other = goal('other', 'workspace', 'running', { sessionId: 'chat-2' });
    const mine = goal('mine', 'workspace', 'running', { sessionId: 'chat-1' });
    const idle = goal('idle', 'workspace', 'queued', { sessionId: 'chat-3' });
    const done = goal('done', 'workspace', 'completed', { sessionId: 'chat-1' });
    const goals = [other, mine, idle, done];

    expect(pickSteeredGoal(goals, 'other', 'chat-1')?.id).toBe('other');
    // A finished goal is never steered, so a stale selection cannot stick.
    expect(pickSteeredGoal(goals, 'done', 'chat-1')?.id).toBe('mine');
    expect(pickSteeredGoal(goals, '', 'chat-9')?.id).toBe('other');
    expect(pickSteeredGoal([done], '', 'chat-1')).toBeUndefined();
  });

  test('serializes a checklist into an ordered, dependency-clean plan', () => {
    const goalWithChecks = goal('g', 'workspace', 'running', {
      checklist: [
        {
          id: 'b',
          title: 'Second',
          status: 'pending',
          order: 5,
          dependsOn: ['a', 'gone'],
          evidence: [],
        },
        {
          id: 'a',
          title: 'First',
          status: 'completed',
          order: 1,
          dependsOn: [],
          evidence: [],
        },
      ],
    });
    // Ordered by `order`, and dependencies on checks that no longer exist are
    // dropped rather than sent back to the server.
    expect(toChecklistPlan(goalWithChecks)).toEqual([
      { id: 'a', title: 'First', order: 0, dependsOn: [] },
      { id: 'b', title: 'Second', order: 1, dependsOn: ['a'] },
    ]);
  });

  test('moving a check rebuilds the sequential dependency chain', () => {
    const plan = [
      { id: 'a', title: 'A', order: 0, dependsOn: [] },
      { id: 'b', title: 'B', order: 1, dependsOn: ['a'] },
      { id: 'c', title: 'C', order: 2, dependsOn: ['b'] },
    ];
    expect(moveChecklistItem(plan, 2, 0)).toEqual([
      { id: 'c', title: 'C', order: 0, dependsOn: [] },
      { id: 'a', title: 'A', order: 1, dependsOn: ['c'] },
      { id: 'b', title: 'B', order: 2, dependsOn: ['a'] },
    ]);
    // A no-op move is returned untouched so callers can skip a request.
    expect(moveChecklistItem(plan, 1, 1)).toBe(plan);
    expect(moveChecklistItem(plan, -1, 0)).toBe(plan);
  });
});

describe('Goal Mode blocker wording', () => {
  test('drops the status word the badge already states', () => {
    // Stored blockers are log sentences, so they restate the state. The panel
    // shows the reason only -- otherwise "Paused" appears three times.
    expect(
      goalBlockerReason({ blocker: 'Paused because the human interrupted its active chat' }),
    ).toBe('the human interrupted its active chat');
    expect(goalBlockerReason({ blocker: 'Paused because its chat was deleted' })).toBe(
      'its chat was deleted',
    );
    expect(goalBlockerReason({ blocker: 'Blocked: the verifier rejected the evidence' })).toBe(
      'the verifier rejected the evidence',
    );
  });

  test('leaves a reason that does not restate the state alone', () => {
    expect(goalBlockerReason({ blocker: 'Needs production credentials' })).toBe(
      'Needs production credentials',
    );
    expect(goalBlockerReason({ blocker: undefined })).toBe('');
    // A status word with no clause after it is a whole sentence, not a prefix.
    expect(goalBlockerReason({ blocker: 'Paused' })).toBe('Paused');
    expect(goalBlockerReason({ blocker: 'Paused by user' })).toBe('Paused by user');
  });
});
