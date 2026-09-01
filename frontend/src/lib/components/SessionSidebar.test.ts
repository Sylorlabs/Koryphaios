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
    archivedSessions: [] as (typeof session)[],
    archivedError: null as string | null,
    searchQuery: '',
    newChat: vi.fn(),
    fetchMessages: vi.fn(),
    renameSession: vi.fn(),
    archiveSession: vi.fn(async () => true),
    fetchArchivedSessions: vi.fn(async () => true),
    deleteSession: vi.fn(),
    deleteAllSessions: vi.fn(),
    // SessionSidebar's mount-time $effect calls sessionsForProject(path) when
    // a project becomes ready. The mock previously omitted this method and the
    // component crashed on first render, so add a default empty result here.
    sessionsForProject: vi.fn(() => [] as (typeof session)[]),
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
    mocks.sessionStore.archivedSessions = [];
    mocks.sessionStore.archivedError = null;
    mocks.sessionStore.fetchArchivedSessions.mockResolvedValue(true);
  });

  it('keeps the full-row session action and row utilities as sibling controls', async () => {
    const { container } = render(SessionSidebar);

    const openSession = screen.getByRole('button', { name: 'Open session Accessibility review' });
    const rename = screen.getByRole('button', { name: 'Rename session' });
    const archive = screen.getByRole('button', { name: 'Archive chat' });
    const remove = screen.getByRole('button', { name: 'Delete session' });
    expect(openSession.contains(rename)).toBe(false);
    expect(openSession.contains(archive)).toBe(false);
    expect(openSession.contains(remove)).toBe(false);
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();

    await fireEvent.click(openSession);
    expect(mocks.sessionStore.activeSessionId).toBe('session-2');

    await fireEvent.dblClick(openSession);
    expect(container.querySelector('input[maxlength="80"]')).toBeTruthy();
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();
  });

  it('places Archive between Rename and Delete and archives without a confirmation', async () => {
    render(SessionSidebar);

    const rename = screen.getByRole('button', { name: 'Rename session' });
    const archive = screen.getByRole('button', { name: 'Archive chat' });
    const remove = screen.getByRole('button', { name: 'Delete session' });
    expect(rename.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(archive.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await fireEvent.click(archive);
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledWith('session-2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('verifies hidden archives and states exact counts before Delete All can proceed', async () => {
    mocks.sessionStore.archivedSessions = [
      { ...session, id: 'archived-1', title: 'Archived chat' },
    ];
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Delete all sessions' }));

    expect(mocks.sessionStore.fetchArchivedSessions).toHaveBeenCalledOnce();
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(
      screen.getByText(/permanently deletes 1 active chat and 1 archived chat/i),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete All Sessions' }));
    expect(mocks.sessionStore.deleteAllSessions).toHaveBeenCalledOnce();
  });

  it('does not expose a global delete confirmation when archives cannot be counted', async () => {
    mocks.sessionStore.archivedError = 'Archive index unavailable';
    mocks.sessionStore.fetchArchivedSessions.mockResolvedValueOnce(false);
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Delete all sessions' }));

    expect(mocks.sessionStore.fetchArchivedSessions).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.sessionStore.deleteAllSessions).not.toHaveBeenCalled();
  });
});
