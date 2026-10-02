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
  billingApiFetch: vi.fn(),
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
  projectStore: {
    currentPath: '/tmp/project',
    displayName: 'project',
    scope: 'project' as const,
    workspaceRoot: null as string | null,
    workspaceProjects: [] as Array<{ path: string; name: string; modifiedAt: number }>,
    setScope: vi.fn(),
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.billingApiFetch, parseJsonResponse: vi.fn() }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    pendingPermissions: [],
    koryPhase: '',
    getManagerStatusForSession: vi.fn(() => 'idle'),
    getAgentStatusesForSession: vi.fn(() => []),
    isSessionRunning: vi.fn(() => false),
    loadSessionMessages: vi.fn(),
  },
}));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: mocks.projectStore,
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
  goalDisplayStore: { composer: true, update: vi.fn() },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
}));
vi.mock('$lib/demo-flags', () => ({ isFullDemo: false, isGuidedDemo: false }));

import SessionSidebar from './SessionSidebar.svelte';

describe('SessionSidebar session controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The archive/delete warnings remember "Don't show again" in localStorage.
    localStorage.clear();
    mocks.sessionStore.activeSessionId = 'session-1';
    mocks.sessionStore.sessions = [session];
    mocks.sessionStore.groupedSessions = [{ label: 'Today', sessions: [session] }];
    mocks.sessionStore.filteredSessions = [session];
    mocks.sessionStore.archivedSessions = [];
    mocks.sessionStore.archivedError = null;
    mocks.sessionStore.fetchArchivedSessions.mockResolvedValue(true);
    mocks.billingApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sessions: {} }),
    } as Response);
    mocks.projectStore.currentPath = '/tmp/project';
    mocks.projectStore.displayName = 'project';
    mocks.projectStore.workspaceRoot = null;
    mocks.projectStore.workspaceProjects = [];
  });

  it('renders workspace, project, and chat as a collapsible three-level tree', async () => {
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
    ];

    render(SessionSidebar);

    const workspace = screen.getByRole('button', { name: /Collapse workspace workspace/i });
    expect(screen.getByRole('button', { name: /Collapse project\./i })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open session Accessibility review' })).toBeVisible();

    await fireEvent.click(workspace);
    expect(screen.queryByRole('button', { name: /Collapse project\./i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open session Accessibility review' })).toBeNull();
    expect(screen.getByRole('button', { name: /Expand workspace workspace/i })).toBeVisible();
  });

  it('lists only workspace folders that have chats or are the selected project', () => {
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
      { path: '/tmp/workspace/empty-folder', name: 'empty-folder', modifiedAt: Date.now() },
      { path: '/tmp/workspace/another-empty', name: 'another-empty', modifiedAt: Date.now() },
    ];

    render(SessionSidebar);

    // The folder with a chat is in the tree; empty folders are picked from the
    // workspace new-chat screen instead of being dumped into the sidebar.
    expect(screen.getByRole('button', { name: /Collapse project\./i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /empty-folder/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /another-empty/i })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Collapse workspace workspace\. 1 project/i }),
    ).toBeVisible();
  });

  it('keeps the selected project visible even before it has a chat', () => {
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.currentPath = '/tmp/workspace/fresh';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/workspace/fresh', name: 'fresh', modifiedAt: Date.now() },
      { path: '/tmp/workspace/empty-folder', name: 'empty-folder', modifiedAt: Date.now() },
    ];

    render(SessionSidebar);

    expect(screen.getByRole('button', { name: /Collapse fresh\./i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /empty-folder/i })).toBeNull();
  });

  it('attaches workspace-root chats directly to the workspace node, never a "Workspace root" folder', () => {
    const rootSession = {
      ...session,
      id: 'root-1',
      title: 'Root chat',
      workingDirectory: '/tmp/workspace',
    };
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.currentPath = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
    ];
    mocks.sessionStore.sessions = [session, rootSession];
    mocks.sessionStore.filteredSessions = [session, rootSession];

    render(SessionSidebar);

    expect(screen.queryByText('Workspace root')).toBeNull();
    expect(screen.queryByRole('button', { name: /Collapse workspace root\./i })).toBeNull();
    const rootChats = screen.getByRole('group', { name: 'workspace chats' });
    expect(rootChats).toContainElement(
      screen.getByRole('button', { name: 'Open session Root chat' }),
    );
    // The nested folder still renders as a normal group with its own chat.
    expect(screen.getByRole('button', { name: /Collapse project\./i })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open session Accessibility review' })).toBeVisible();
  });

  it('routes the workspace "+" through the workspace new-chat screen', async () => {
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    const requested = vi.fn();
    window.addEventListener('kory:workspace-new-chat', requested);

    try {
      render(SessionSidebar);
      await fireEvent.click(
        screen.getByRole('button', { name: 'New chat in workspace workspace' }),
      );
      expect(requested).toHaveBeenCalledTimes(1);
      // The workspace-level "+" never creates a root chat directly.
      expect(mocks.sessionStore.newChat).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('kory:workspace-new-chat', requested);
    }
  });

  it('hides the Teams shortcut by default and restores it from the Teams preference', () => {
    const first = render(SessionSidebar);
    expect(screen.queryByText('Join or host a team workspace')).toBeNull();
    first.unmount();

    localStorage.setItem(
      'koryphaios-team-ui-preferences-v1',
      JSON.stringify({ showTeamSidebarShortcut: true }),
    );
    render(SessionSidebar);
    expect(screen.getByText('Join or host a team workspace')).toBeVisible();
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

  it('places Archive between Rename and Delete and warns before archiving', async () => {
    render(SessionSidebar);

    const rename = screen.getByRole('button', { name: 'Rename session' });
    const archive = screen.getByRole('button', { name: 'Archive chat' });
    const remove = screen.getByRole('button', { name: 'Delete session' });
    expect(rename.compareDocumentPosition(archive) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(archive.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await fireEvent.click(archive);

    // Nothing is archived until the warning is accepted.
    expect(mocks.sessionStore.archiveSession).not.toHaveBeenCalled();
    const warning = screen.getByRole('alertdialog');
    expect(warning).toHaveTextContent(
      'Archiving this session will stop the current agent and all of its sub-agents',
    );
    expect(screen.getByRole('button', { name: "Don't show again" })).toBeVisible();

    await fireEvent.click(screen.getByRole('button', { name: 'Archive Session' }));
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledWith('session-2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the same warning with delete wording before deleting', async () => {
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));

    expect(mocks.sessionStore.deleteSession).not.toHaveBeenCalled();
    const warning = screen.getByRole('alertdialog');
    expect(warning).toHaveTextContent(
      'Deleting this session will stop the current agent and all of its sub-agents',
    );
    expect(warning).toHaveTextContent("Don't show again");

    await fireEvent.click(screen.getByRole('button', { name: 'Delete Session' }));
    expect(mocks.sessionStore.deleteSession).toHaveBeenCalledWith('session-2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the archive and delete warnings identical apart from the verb', async () => {
    render(SessionSidebar);
    const warningText = () => screen.getByRole('alertdialog').querySelector('p')?.textContent ?? '';

    await fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    const archiveWarning = warningText();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    const deleteWarning = warningText();

    expect(archiveWarning).toContain('Archiving');
    expect(archiveWarning.replace('Archiving', 'Deleting')).toBe(deleteWarning);
  });

  it('remembers "Don\'t show again" per action', async () => {
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    await fireEvent.click(screen.getByRole('button', { name: "Don't show again" }));
    await fireEvent.click(screen.getByRole('button', { name: 'Archive Session' }));
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledWith('session-2');

    // Archiving no longer stops to warn.
    await fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledTimes(2);

    // Dismissing the reversible archive warning must not dismiss the
    // destructive delete warning.
    await fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Deleting this session');
    expect(mocks.sessionStore.deleteSession).not.toHaveBeenCalled();
  });

  it('does not treat a cancelled warning as "Don\'t show again"', async () => {
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    await fireEvent.click(screen.getByRole('button', { name: "Don't show again" }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.sessionStore.archiveSession).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    expect(screen.getByRole('alertdialog')).toBeVisible();
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

  it('anchors the tracked-spend popover to the viewport so it cannot be clipped by the sidebar', async () => {
    const paidSession = { ...session, id: 'session-paid', totalCost: 3.386 };
    mocks.sessionStore.sessions = [paidSession];
    mocks.sessionStore.groupedSessions = [{ label: 'Today', sessions: [paidSession] }];
    mocks.sessionStore.filteredSessions = [paidSession];
    mocks.billingApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        summary: {
          spendUsd: 3.386,
          hasMeteredUsage: true,
          hasKnownCost: true,
          providers: [],
        },
      }),
    } as Response);
    const { container } = render(SessionSidebar);

    const costButton = screen.getByRole('button', { name: /Billing detail for/i });
    await fireEvent.mouseEnter(costButton.parentElement as HTMLElement);
    await Promise.resolve();

    const popover = container.querySelector('.cost-billing-popover') as HTMLElement;
    expect(popover).toBeTruthy();
    expect(popover.getAttribute('role')).toBe('tooltip');
    // Viewport-anchored placement instead of `absolute left-0`, which overflowed
    // the scrollable sidebar and got cut off on the right.
    expect(popover.style.left).toMatch(/^\d+px$/);
    expect(popover.style.top).toMatch(/^\d+px$/);
    expect(popover.className).not.toContain('left-0');
  });

  it('never scrolls the session tree sideways, so rows cannot be sheared off the left edge', () => {
    const { container } = render(SessionSidebar);

    // Declaring only `overflow-y-auto` makes the browser compute `overflow-x`
    // to `auto` as well, turning the tree into a horizontal scroll container.
    // The hover overlays overflow its right edge even at opacity 0, so any
    // scroll offset sheared the leading glyphs of every row off the window.
    const tree = container.querySelector('.session-tree') as HTMLElement;
    expect(tree).toBeTruthy();
    expect(tree.className).toContain('overflow-x-hidden');
  });

  it('sizes the launcher menu to the sidebar instead of the "+" button', async () => {
    const { container } = render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Create or open' }));

    const menu = container.querySelector('.launcher-menu') as HTMLElement;
    expect(menu).toBeTruthy();
    // A fixed 288px panel right-aligned to the 32px "+" button overflowed the
    // 220-272px sidebar and was clipped by the <nav>'s overflow:hidden, so
    // "Open Project" rendered as "pen Project". Sizing to the toolbar (the
    // containing block) makes that impossible at any sidebar width.
    expect(menu.className).not.toContain('w-72');
    expect(menu.className).not.toContain('right-0');
    // The four project/workspace actions are a single column: a two-column
    // grid cannot fit "Open Workspace" inside a 220px sidebar.
    expect(menu.querySelector('.grid-cols-2')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Open Workspace' })).toBeVisible();
  });

  it('closes the launcher menu on Escape', async () => {
    const { container } = render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Create or open' }));
    expect(container.querySelector('.launcher-menu')).toBeTruthy();

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.launcher-menu')).toBeNull();
  });
});
