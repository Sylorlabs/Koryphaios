import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  id: 'session-2',
  title: 'Accessibility review',
  updatedAt: Date.now(),
  workingDirectory: '/tmp/project',
  messageCount: 2,
  totalCost: 0,
};

const mocks = vi.hoisted(() => ({
  sessionStore: {
    activeSessionId: 'session-1',
    sessions: [] as (typeof session)[],
    groupedSessions: [] as Array<{ label: string; sessions: (typeof session)[] }>,
    filteredSessions: [] as (typeof session)[],
    searchQuery: '',
    newChat: vi.fn(),
    fetchMessages: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteAllSessions: vi.fn(),
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    pendingPermissions: [],
    koryPhase: '',
    getManagerStatusForSession: vi.fn(() => 'idle'),
    isSessionRunning: vi.fn(() => false),
    loadSessionMessages: vi.fn(),
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    currentPath: '/tmp/project',
    displayName: 'project',
    scope: 'project',
    setScope: vi.fn(),
  },
  projectDisplayName: (path: string) => path.split('/').at(-1) ?? path,
}));
vi.mock('$lib/stores/collaboration.svelte', () => ({
  collaborationStore: {
    activeJoinedSession: null,
    joinedSessions: [],
    closeJoinedSession: vi.fn(),
    openJoinedSession: vi.fn(),
    leaveJoinedSession: vi.fn(),
  },
}));
vi.mock('$lib/stores/goals.svelte', () => ({
  goalStore: { goals: [], refresh: vi.fn(), selectedGoalId: null },
}));
vi.mock('$lib/stores/goal-display.svelte', () => ({
  goalDisplayStore: { sidebar: false, update: vi.fn() },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
}));
vi.mock('$lib/demo-flags', () => ({ isFullDemo: false, isGuidedDemo: false }));

import SessionSidebar from './SessionSidebar.svelte';

describe('SessionSidebar session controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionStore.activeSessionId = 'session-1';
    mocks.sessionStore.sessions = [session];
    mocks.sessionStore.groupedSessions = [{ label: 'Today', sessions: [session] }];
    mocks.sessionStore.filteredSessions = [session];
  });

  it('keeps the full-row session action and row utilities as sibling controls', async () => {
    const { container } = render(SessionSidebar);

    const openSession = screen.getByRole('button', { name: 'Open session Accessibility review' });
    const rename = screen.getByRole('button', { name: 'Rename session' });
    const remove = screen.getByRole('button', { name: 'Delete session' });
    expect(openSession.contains(rename)).toBe(false);
    expect(openSession.contains(remove)).toBe(false);
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();

    await fireEvent.click(openSession);
    expect(mocks.sessionStore.activeSessionId).toBe('session-2');

    await fireEvent.dblClick(openSession);
    expect(container.querySelector('input[maxlength="80"]')).toBeTruthy();
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();
  });
});
