import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { createIdleSessionRun, type Session } from '@koryphaios/shared';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/websocket.svelte', async () => {
  const { runStateStore } = await import('$lib/stores/run-state.svelte');
  return {
    wsStore: {
      pendingPermissions: [],
      koryPhase: '',
      getManagerStatusForSession: runStateStore.getAgentStatusForSession,
      getAgentStatusesForSession: () => ['done', 'done'],
      isSessionRunning: runStateStore.isRunning,
      loadSessionMessages: vi.fn(),
      unsubscribeFromSession: mocks.unsubscribe,
    },
  };
});
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    currentPath: '/tmp/project',
    workspaceRoot: null,
    workspaceProjects: [],
    scope: 'project',
  },
  projectDisplayName: (path: string) => path.split('/').at(-1) ?? path,
  projectIdentityProjection: (entry: { path: string; name: string; modifiedAt: number }) => ({
    identity: { id: `path:${entry.path}`, name: entry.name, icon: { mode: 'automatic' as const } },
    icon: {
      mode: 'monogram' as const,
      value: entry.name.slice(0, 2).toUpperCase(),
      color: 'accent' as const,
    },
  }),
}));
vi.mock('$lib/stores/devices.svelte', () => ({ deviceStore: { chats: [], activeChat: null } }));
vi.mock('$lib/stores/collaboration.svelte', () => ({
  collaborationStore: {
    activeJoinedSession: null,
    joinedSessions: [],
    closeJoinedSession: vi.fn(),
  },
}));
vi.mock('$lib/stores/goals.svelte', () => ({ goalStore: { goals: [], loaded: true } }));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: 1, unsubscribe: vi.fn() }),
}));
vi.mock('$lib/demo-flags', () => ({ isFullDemo: false, isGuidedDemo: false }));

import SessionSidebar from './SessionSidebar.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { runStateStore } from '$lib/stores/run-state.svelte';

const chat = (id: string): Session => ({
  id,
  title: `Chat ${id}`,
  workingDirectory: '/tmp/project',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalCost: 0,
});
function phase(id: string, value: 'done' | 'error' | 'streaming' | 'cancelled', revision = 1) {
  runStateStore.applyEvent({
    type: 'run.state',
    sessionId: id,
    timestamp: revision,
    payload: {
      snapshot: {
        ...createIdleSessionRun(id),
        runId: `run-${id}`,
        revision,
        phase: value,
        status: value === 'streaming' ? 'active' : 'terminal',
        activeAgentIds: value === 'streaming' ? ['kory-manager'] : [],
      },
      transition: null,
    },
  });
}
async function openActivity(container: HTMLElement) {
  await fireEvent.click(container.querySelector('.status-orb')!);
  return screen.getByRole('dialog');
}
function summary(dialog: HTMLElement) {
  return dialog.querySelector('.status-detail-summary')!;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, sessions: {} })));
  runStateStore.clearAll();
  sessionStore.seedDemoSessions([chat('one')], 'one');
});

describe('chat row status icon', () => {
  it('shows the done checkmark for a genuinely completed chat', () => {
    phase('one', 'done');
    const { container } = render(SessionSidebar);
    expect(container.querySelector('.status-cell .status-icon.done')).not.toBeNull();
  });

  it('does not show the done checkmark for a chat stopped by the user', () => {
    phase('one', 'cancelled');
    const { container } = render(SessionSidebar);
    expect(container.querySelector('.status-cell .status-icon.done')).toBeNull();
  });

  it('drops the checkmark as soon as the user stops, before the canonical cancel arrives', () => {
    runStateStore.startRun('one');
    runStateStore.markUserStopped('one');
    const { container } = render(SessionSidebar);
    // markUserStopped maps to the done phase, but a stopped chat is not a
    // completed one — the row must show the plain chat glyph.
    expect(container.querySelector('.status-cell .status-icon.done')).toBeNull();
  });
});

describe('project activity uses live chat outcomes', () => {
  it('updates the open chart and rows together when a completed run fails', async () => {
    phase('one', 'done');
    const { container } = render(SessionSidebar);
    const dialog = await openActivity(container);
    expect(summary(dialog)).toHaveTextContent('Completed');
    phase('one', 'error', 2);
    await tick();
    expect(summary(dialog)).toHaveTextContent('Failed');
    expect(summary(dialog)).not.toHaveTextContent('Completed');
    expect(dialog.querySelector('.status-detail-state')).toHaveTextContent('Failed');
  });

  it('adds new idle chats and removes deleted chats without reopening the chart', async () => {
    phase('one', 'done');
    const { container } = render(SessionSidebar);
    const dialog = await openActivity(container);
    sessionStore.handleSessionUpdate(chat('two'));
    await tick();
    expect(within(dialog).getByText('Chat two')).toBeVisible();
    expect(summary(dialog)).toHaveTextContent('Idle');
    expect(dialog.querySelector('.status-detail-chart')).toHaveTextContent('2');
    sessionStore.handleSessionDeleted('one');
    await tick();
    expect(within(dialog).queryByText('Chat one')).toBeNull();
    expect(summary(dialog)).not.toHaveTextContent('Completed');
    expect(dialog.querySelector('.status-detail-chart')).toHaveTextContent('1');
  });

  it('counts each chat once, not historical completed workers, and distinguishes cancellation', async () => {
    phase('one', 'error');
    sessionStore.handleSessionUpdate(chat('two'));
    phase('two', 'cancelled');
    const { container } = render(SessionSidebar);
    const dialog = await openActivity(container);
    expect(dialog.querySelector('.status-detail-chart')).toHaveTextContent('2');
    expect(summary(dialog)).toHaveTextContent('Failed');
    expect(summary(dialog)).toHaveTextContent('Cancelled');
    expect(summary(dialog)).not.toHaveTextContent('Completed');
    expect(within(dialog).getAllByText('Cancelled')).toHaveLength(2);
  });

  it('clears the activity chart when the selected project has no remaining chats', async () => {
    phase('one', 'done');
    const { container } = render(SessionSidebar);
    await openActivity(container);
    sessionStore.seedDemoSessions([], '');
    await tick();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Chat one')).toBeNull();
  });

  it('does not erase a new chat or revive a deleted one when an older list arrives', async () => {
    let resolveList!: (response: Response) => void;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveList = resolve;
      }),
    );
    const request = sessionStore.fetchSessions();
    sessionStore.handleSessionUpdate(chat('two'));
    sessionStore.handleSessionDeleted('one');
    resolveList(new Response(JSON.stringify({ ok: true, data: [chat('one')] })));
    await request;
    expect(sessionStore.sessions.map((session) => session.id)).toEqual(['two']);
  });

  it('hydrates unvisited chats from durable run states and rejects older HTTP status', async () => {
    phase('one', 'error', 3);
    mocks.apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: [chat('one'), chat('two')],
          runStates: [
            { ...createIdleSessionRun('one'), phase: 'done', status: 'terminal', revision: 2 },
            { ...createIdleSessionRun('two'), phase: 'error', status: 'terminal', revision: 4 },
          ],
        }),
      ),
    );
    await sessionStore.fetchSessions();
    expect(runStateStore.getPhase('one')).toBe('error');
    expect(runStateStore.getPhase('two')).toBe('error');
  });
});
