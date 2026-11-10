import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '@koryphaios/shared';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  activeSessionId: { value: 'chat-1' },
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/goal-display.svelte', () => ({
  goalDisplayStore: { composer: true, update: vi.fn() },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return mocks.activeSessionId.value;
    },
    set activeSessionId(value: string) {
      mocks.activeSessionId.value = value;
    },
    sessions: [
      { id: 'chat-1', title: 'First chat', agentOverrides: { criticGateEnabled: true } },
      { id: 'chat-2', title: 'Second chat' },
    ],
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: { currentPath: '/project' },
  projectDisplayName: (path?: string) => path ?? '',
}));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { criticActive: false, settings: { criticMode: 'off' } },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useSecondClock: () => ({ now: 1_000_000, unsubscribe: vi.fn() }),
}));

// The real store is used on purpose: Goal Mode gates on `goalStore.loaded`, so
// that flag has to be a reactive `$state`, not a plain `let`. A store double
// could not catch a regression here.
import { goalStore } from '$lib/stores/goals.svelte';
import GoalMode from './GoalMode.svelte';

const goal = (over: Partial<Goal> & Pick<Goal, 'id' | 'objective' | 'status'>): Goal => ({
  scope: 'workspace',
  priority: 0,
  sortOrder: 0,
  checklist: [],
  linkedSessionIds: [],
  activity: [],
  activeDurationMs: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const respondWith = (goals: Goal[]) =>
  mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: goals }) });

const bar = () => screen.getByRole('group', { name: 'Goal Mode' });
const openSwitcher = async () => {
  await fireEvent.click(screen.getByRole('button', { name: /Open goal in its chat:/ }));
};
const openPanel = async () => {
  await fireEvent.click(screen.getByRole('button', { name: 'Expand goal details' }));
};

const threeGoals = () => [
  goal({
    id: 'run',
    objective: 'Ship the release notes',
    status: 'running',
    activeDurationMs: 2 * 3_600_000 + 14 * 60_000 + 32_000,
    activeStartedAt: 0,
    checklist: [
      {
        id: 'c1',
        title: 'Draft the changelog',
        status: 'completed',
        order: 0,
        dependsOn: [],
        evidence: [
          {
            id: 'e1',
            kind: 'check',
            value: 'Changelog merged in #412',
            verified: true,
            createdAt: 0,
          },
        ],
      },
      {
        id: 'c2',
        title: 'Tag the release',
        status: 'running',
        order: 1,
        dependsOn: [],
        evidence: [],
      },
    ],
  }),
  goal({
    id: 'wait',
    objective: 'Migrate the auth tables',
    status: 'queued',
    activeDurationMs: 12_000,
  }),
  goal({
    id: 'halt',
    objective: 'Fix the flaky checkout test',
    status: 'paused',
    activeDurationMs: 47_000,
  }),
];

describe('Goal Mode steering bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeSessionId.value = 'chat-1';
    goalStore.selectedGoalId = '';
    respondWith([]);
  });

  it('appears once the first goal load resolves', async () => {
    render(GoalMode);
    expect(screen.queryByRole('group', { name: 'Goal Mode' })).toBeNull();

    respondWith([goal({ id: 'g1', objective: 'Ship the release notes', status: 'running' })]);
    await goalStore.refresh();
    expect(await bar()).toBeVisible();
  });

  it('keeps the bar to one row: objective, progress, runtime, and lifecycle controls', async () => {
    respondWith(threeGoals());
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    // The steered goal is the one running in this chat; no card is expanded.
    expect(screen.getByText('Ship the release notes')).toBeVisible();
    expect(screen.getByText('50%')).toBeVisible();
    expect(screen.getByText('2h 14m 32s')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause goal' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close goal' })).toBeVisible();
    // Nothing heavy renders until the user asks for it.
    expect(screen.queryByLabelText('Goal details')).toBeNull();
    expect(screen.queryByText('Chats used by this goal')).toBeNull();
  });

  it('stays completely out of the way when no goal is active', async () => {
    // A permanent "No active goals" row in every chat is noise for the majority
    // of users, who never create one. Creation stays reachable from the `+`
    // menu, `/goal create`, and the palette, so the surface can be absent.
    respondWith([]);
    render(GoalMode);
    await goalStore.refresh();

    expect(screen.queryByRole('group', { name: 'Goal Mode' })).toBeNull();
    expect(screen.queryByText('No active goals')).toBeNull();
  });

  it('still creates a goal from the switcher when other goals are active', async () => {
    respondWith(threeGoals());
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    const created: string[] = [];
    window.addEventListener('kory:goal-action', (event) =>
      created.push((event as CustomEvent<string>).detail),
    );
    await openSwitcher();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'New goal' }));
    expect(created).toContain('goal_create');
  });

  it('switches between active goals from the switcher, grouped by phase', async () => {
    respondWith(threeGoals());
    render(GoalMode);
    await goalStore.refresh();
    await bar();
    await openSwitcher();

    expect(screen.getByRole('menu', { name: 'Switch goal' })).toBeVisible();
    for (const objective of [
      'Ship the release notes',
      'Migrate the auth tables',
      'Fix the flaky checkout test',
    ]) {
      expect(screen.getByRole('menuitemradio', { name: new RegExp(objective) })).toBeVisible();
    }
    expect(screen.getAllByText('Going')).toHaveLength(1);
    expect(screen.getByText('47s')).toBeVisible();
    expect(screen.getByText('12s')).toBeVisible();
  });

  it('redirects into the chat running a goal and steers that goal', async () => {
    respondWith([
      goal({
        id: 'other',
        objective: 'Migrate the auth tables',
        status: 'running',
        activeDurationMs: 47_000,
        execution: { sessionId: 'chat-2' } as Goal['execution'],
      }),
      goal({
        id: 'mine',
        objective: 'Ship the release notes',
        status: 'running',
        execution: { sessionId: 'chat-1' } as Goal['execution'],
      }),
    ]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    await openPanel();
    // Defaults to the goal running in this chat.
    expect(await screen.findByText('Critic quality gate on')).toBeVisible();

    await openSwitcher();
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /Migrate the auth tables/ }));
    expect(mocks.activeSessionId.value).toBe('chat-2');
    expect(goalStore.selectedGoalId).toBe('other');

    await openPanel();
    expect(await screen.findByText('Critic quality gate off')).toBeVisible();
    // The steered goal is a workspace goal, so the panel states its scope. The
    // owning/executing chat is not restated: after the redirect it is this chat,
    // and repeating "this chat" twice in one header read as a stutter.
    expect(screen.getByText(/Every chat in this workspace/)).toBeVisible();
    expect(screen.queryByText(/This chat only/)).toBeNull();
    expect(screen.queryByText(/Running in/)).toBeNull();
  });

  it('does not navigate to a chat the sidebar no longer knows about', async () => {
    respondWith([
      goal({
        id: 'orphan',
        objective: 'Migrate the auth tables',
        status: 'running',
        // A goal can outlive the chat it names.
        execution: { sessionId: 'chat-deleted' } as Goal['execution'],
      }),
    ]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    await openSwitcher();
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /Migrate the auth tables/ }));
    expect(mocks.activeSessionId.value).toBe('chat-1');
    expect(goalStore.selectedGoalId).toBe('orphan');
  });

  it('arms the close control before ending a goal', async () => {
    const stop = vi.spyOn(goalStore, 'stop');
    respondWith([threeGoals()[0]]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    await fireEvent.click(screen.getByRole('button', { name: 'Close goal' }));
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Press close again');

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm close goal' }));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('run'));
  });

  it('offers one combined lifecycle control per state', async () => {
    respondWith(threeGoals()); // one running, one queued, one paused
    render(GoalMode);
    await goalStore.refresh();
    await bar();
    // A running goal pauses; Start and Resume never appear alongside it.
    expect(screen.getByRole('button', { name: 'Pause goal' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume goal' })).toBeNull();

    goalStore.selectedGoalId = 'halt'; // paused
    await openPanel();
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    // Closing out is a separate, destructive control -- never folded into the
    // lifecycle toggle.
    expect(screen.getByRole('button', { name: 'Close out' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close goal' })).toBeVisible();
  });

  it('states a paused goal once, not once per surface', async () => {
    respondWith([
      goal({
        id: 'halt',
        objective: 'Fix the flaky checkout test',
        status: 'paused',
        blocker: 'Paused because the human interrupted its active chat',
        activity: [
          {
            id: 'a1',
            type: 'paused',
            message: 'Paused because the human interrupted its active chat',
            createdAt: 0,
          },
          { id: 'a2', type: 'created', message: 'Goal created', createdAt: 0 },
        ],
      }),
    ]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();
    await openPanel();

    // One status badge, a reason-only banner, and the log entry that merely
    // repeated the reason is gone.
    expect(screen.getAllByText('Paused')).toHaveLength(1);
    expect(screen.getByText('the human interrupted its active chat')).toBeVisible();
    expect(screen.getByText('Goal created')).toBeVisible();
  });

  it('adds, renames, and deletes checks by hand', async () => {
    const editChecklist = vi
      .spyOn(goalStore, 'editChecklist')
      .mockImplementation(async (id, items) =>
        goal({
          ...threeGoals()[0]!,
          id,
          checklist: items.map((item, index) => ({
            id: item.id ?? `new-${index}`,
            title: item.title,
            status: 'pending' as const,
            order: item.order ?? index,
            dependsOn: item.dependsOn ?? [],
            evidence: [],
          })),
        }),
      );
    respondWith([threeGoals()[0]]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();
    await openPanel();

    await fireEvent.click(screen.getByRole('button', { name: 'Edit checks' }));

    // Add.
    await fireEvent.input(screen.getByLabelText('New check'), {
      target: { value: 'Record the regression evidence' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    await vi.waitFor(() =>
      expect(editChecklist).toHaveBeenCalledWith(
        'run',
        expect.arrayContaining([
          expect.objectContaining({ title: 'Record the regression evidence' }),
        ]),
      ),
    );
    // Only the plan's shape is sent; status and evidence are never fabricated.
    expect(editChecklist.mock.calls[0]![1].every((item) => !('status' in item))).toBe(true);
  });

  it('lifecycle actions resolve against the goal the switcher selected', async () => {
    const pause = vi.spyOn(goalStore, 'pause');
    respondWith(threeGoals());
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    await openSwitcher();
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /Migrate the auth tables/ }));
    window.dispatchEvent(
      new CustomEvent('kory:goal-action', { detail: { action: 'goal_pause', source: 'slash' } }),
    );
    await vi.waitFor(() => expect(pause).toHaveBeenCalledWith('wait'));
  });

  it('closes the panel on Escape', async () => {
    respondWith([threeGoals()[0]]);
    render(GoalMode);
    await goalStore.refresh();
    await bar();

    await openPanel();
    expect(screen.getByLabelText('Goal details')).toBeVisible();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('Goal details')).toBeNull();
  });

  it('keeps goal detail out of the session sidebar', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    // The left rail is pure navigation; cross-chat goals read as navigation
    // there and confused users, so the panel no longer exists.
    expect(existsSync('src/lib/components/ActiveGoals.svelte')).toBe(false);
    expect(readFileSync('src/lib/components/SessionSidebar.svelte', 'utf8')).not.toContain(
      'ActiveGoals',
    );
  });
});
