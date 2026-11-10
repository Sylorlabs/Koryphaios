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
  deviceStore: { openCreator: vi.fn(), closeChat: vi.fn(), chats: [], activeChat: null },
  sessionStore: {
    activeSessionId: 'session-1',
    sessions: [] as (typeof session)[],
    groupedSessions: [] as Array<{ label: string; sessions: (typeof session)[] }>,
    filteredSessions: [] as (typeof session)[],
    archivedSessions: [] as (typeof session)[],
    archivedError: null as string | null,
    searchQuery: '',
    newChat: vi.fn(),
    createSession: vi.fn(),
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
  projectIdentityProjection: (entry: { path: string; name: string; modifiedAt: number }) => ({
    identity: { id: `path:${entry.path}`, name: entry.name, icon: { mode: 'automatic' as const } },
    icon: {
      mode: 'monogram' as const,
      value: entry.name.slice(0, 2).toUpperCase(),
      color: 'accent' as const,
    },
  }),
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/stores/devices.svelte', () => ({ deviceStore: mocks.deviceStore }));
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
  projectIdentityProjection: mocks.projectIdentityProjection,
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

  it('opens project icon actions from the native context menu and routes identity editing', async () => {
    const onAction = vi.fn();
    render(SessionSidebar, { props: { onAction } });

    const trigger = screen.getByRole('button', { name: 'Project actions for project' });
    await fireEvent.contextMenu(trigger, { clientX: 24, clientY: 48 });

    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeVisible();
    await fireEvent.click(screen.getByRole('menuitem', { name: /^Edit/i }));

    expect(onAction).toHaveBeenCalledWith('open_project_identity:%2Ftmp%2Fproject');
  });

  it('opens project actions when the project icon itself is right-clicked', async () => {
    render(SessionSidebar);

    const projectRow = screen.getByRole('button', { name: /Collapse project\./i });
    const projectIcon = projectRow.querySelector('[data-testid="project-icon"]');
    expect(projectIcon).toBeTruthy();

    await fireEvent.contextMenu(projectIcon as HTMLElement, { clientX: 24, clientY: 48 });

    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeVisible();
  });

  it('opens workspace actions when the workspace folder icon is right-clicked', async () => {
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
    ];

    render(SessionSidebar);

    const workspaceRow = screen.getByRole('button', { name: /Collapse workspace workspace/i });
    const folderIcon = workspaceRow.querySelector('.workspace-folder-icon');
    expect(folderIcon).toBeTruthy();

    await fireEvent.contextMenu(workspaceRow, { clientX: 24, clientY: 48 });

    expect(
      screen.getByRole('menu', { name: 'Actions for workspace workspace' }),
    ).toBeVisible();
  });

  it('opens project icon actions from the keyboard context-menu command', async () => {
    render(SessionSidebar);

    const trigger = screen.getByRole('button', { name: 'Project actions for project' });
    await fireEvent.keyDown(trigger, { key: 'F10', shiftKey: true });

    expect(screen.getByRole('menu', { name: 'Actions for project' })).toBeVisible();
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

  /** Each chat row carries one overflow control; every row action lives in it. */
  async function chooseChatAction(name: RegExp) {
    await fireEvent.click(
      screen.getAllByRole('button', { name: /^Chat actions for / })[0],
    );
    await fireEvent.click(screen.getByRole('menuitem', { name }));
  }

  it('keeps the full-row session action and chat utilities as sibling controls', async () => {
    const { container } = render(SessionSidebar);

    const openSession = screen.getByRole('button', { name: 'Open session Accessibility review' });
    const actions = screen.getAllByRole('button', { name: /^Chat actions for / })[0];
    expect(openSession.contains(actions)).toBe(false);
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();

    await fireEvent.click(openSession);
    expect(mocks.sessionStore.activeSessionId).toBe('session-2');

    await fireEvent.dblClick(openSession);
    expect(container.querySelector('input[maxlength="80"]')).toBeTruthy();
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();
  });

  it('orders the chat menu Rename, Copy, Archive, Delete and warns before archiving', async () => {
    render(SessionSidebar);

    await fireEvent.click(screen.getAllByRole('button', { name: /^Chat actions for / })[0]);
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim() ?? '');
    expect(labels).toEqual(['Rename', 'Copy chat ID', 'Archive', 'Delete chat']);

    await fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

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

    await chooseChatAction(/^Delete chat$/);

    expect(mocks.sessionStore.deleteSession).not.toHaveBeenCalled();
    const warning = screen.getByRole('alertdialog');
    expect(warning).toHaveTextContent(
      'Deleting this session will stop the current agent and all of its sub-agents',
    );
    // Deleting is destructive and unrecoverable, so the warning offers no
    // opt-out; only the reversible archive warning does.
    expect(warning).not.toHaveTextContent("Don't show again");
    expect(screen.queryByRole('button', { name: "Don't show again" })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete Session' }));
    expect(mocks.sessionStore.deleteSession).toHaveBeenCalledWith('session-2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the archive and delete warnings identical apart from the verb', async () => {
    render(SessionSidebar);
    const warningText = () => screen.getByRole('alertdialog').querySelector('p')?.textContent ?? '';

    await chooseChatAction(/^Archive$/);
    const archiveWarning = warningText();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await chooseChatAction(/^Delete chat$/);
    const deleteWarning = warningText();

    expect(archiveWarning).toContain('Archiving');
    expect(archiveWarning.replace('Archiving', 'Deleting')).toBe(deleteWarning);
  });

  it('remembers "Don\'t show again" per action', async () => {
    render(SessionSidebar);

    await chooseChatAction(/^Archive$/);
    await fireEvent.click(screen.getByRole('button', { name: "Don't show again" }));
    await fireEvent.click(screen.getByRole('button', { name: 'Archive Session' }));
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledWith('session-2');

    // Archiving no longer stops to warn.
    await chooseChatAction(/^Archive$/);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.sessionStore.archiveSession).toHaveBeenCalledTimes(2);

    // Dismissing the reversible archive warning must not dismiss the
    // destructive delete warning.
    await chooseChatAction(/^Delete chat$/);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Deleting this session');
    expect(mocks.sessionStore.deleteSession).not.toHaveBeenCalled();
  });

  it('always asks before deleting, even after the warning was dismissed once', async () => {
    // A suppression recorded by an older build (or a stale flag) must not turn
    // a chat deletion into a single-click action.
    localStorage.setItem(
      'koryphaios-session-action-warnings-v1',
      JSON.stringify({ delete: true }),
    );
    render(SessionSidebar);

    await chooseChatAction(/^Delete chat$/);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Deleting this session');
    expect(mocks.sessionStore.deleteSession).not.toHaveBeenCalled();

    // Asking again still asks: the stored suppression never turns this into a
    // single-click delete, and the dialog's own confirm is what deletes.
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await chooseChatAction(/^Delete chat$/);
    const confirm = screen.getByRole('alertdialog');
    await fireEvent.click(
      Array.from(confirm.querySelectorAll('button')).find((button) =>
        /^Delete session$/i.test(button.textContent ?? ''),
      ) as HTMLElement,
    );
    expect(mocks.sessionStore.deleteSession).toHaveBeenCalledWith('session-2');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not treat a cancelled warning as "Don\'t show again"', async () => {
    render(SessionSidebar);

    await chooseChatAction(/^Archive$/);
    await fireEvent.click(screen.getByRole('button', { name: "Don't show again" }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.sessionStore.archiveSession).not.toHaveBeenCalled();

    await chooseChatAction(/^Archive$/);
    expect(screen.getByRole('alertdialog')).toBeVisible();
  });

  it('opens the chat actions menu on right-click', async () => {
    render(SessionSidebar);

    const openSession = screen.getByRole('button', { name: 'Open session Accessibility review' });
    await fireEvent.contextMenu(openSession, { clientX: 120, clientY: 180 });

    expect(screen.getByRole('menu', { name: 'Actions for Accessibility review' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /Pin/i })).toBeNull();

    await fireEvent.click(screen.getByRole('menuitem', { name: /^Rename/i }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the chat actions menu with the context-menu key', async () => {
    render(SessionSidebar);

    const openSession = screen.getByRole('button', { name: 'Open session Accessibility review' });
    await fireEvent.keyDown(openSession, { key: 'ContextMenu' });

    expect(screen.getByRole('menu', { name: 'Actions for Accessibility review' })).toBeVisible();
  });

  it('does not expose a global delete-all-sessions control', () => {
    render(SessionSidebar);

    expect(screen.queryByRole('button', { name: 'Delete all sessions' })).toBeNull();
  });

  it('lifts the tracked-spend popover out of the sidebar so no window can cover it', async () => {
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
    const onAction = vi.fn();
    render(SessionSidebar, { props: { onAction } });

    const costButton = screen.getByRole('button', { name: /Billing detail for/i });
    expect(costButton).not.toHaveAttribute('title');
    await fireEvent.mouseEnter(costButton);
    await Promise.resolve();

    const popover = document.body.querySelector('.cost-billing-popover') as HTMLElement;
    expect(popover).toBeTruthy();
    // Viewport-anchored placement instead of `absolute left-0`, which overflowed
    // the scrollable sidebar and got cut off on the right.
    expect(popover.style.left).toMatch(/^\d+px$/);
    expect(popover.style.top).toMatch(/^\d+px$/);
    expect(popover.className).not.toContain('left-0');
    // The chat row isolates and the sidebar nav is promoted by `will-change`, so
    // staying inside the component's subtree would let the chat column paint
    // over the card no matter how high its own z-index was.
    expect(document.body.lastElementChild).toBe(popover);
  });

  it('sends the user to the billing settings section from the tracked price', async () => {
    const paidSession = { ...session, id: 'session-paid', totalCost: 3.386 };
    mocks.sessionStore.sessions = [paidSession];
    mocks.sessionStore.groupedSessions = [{ label: 'Today', sessions: [paidSession] }];
    mocks.sessionStore.filteredSessions = [paidSession];
    mocks.billingApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, summary: { hasMeteredUsage: true, providers: [] } }),
    } as Response);
    const onAction = vi.fn();
    render(SessionSidebar, { props: { onAction } });

    const costButton = screen.getByRole('button', { name: /Billing detail for/i });
    await fireEvent.mouseEnter(costButton);
    await Promise.resolve();

    const popover = document.body.querySelector('.cost-billing-popover') as HTMLElement;
    expect(popover).toBeTruthy();
    await fireEvent.click(popover);

    expect(onAction).toHaveBeenCalledWith('open_settings_billing');
    // Opening Settings invalidates the anchor, so the card must not linger.
    expect(document.body.querySelector('.cost-billing-popover')).toBeNull();
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

  it('opens the device/workspace dialog from the big "+" without a clipped sidebar menu', async () => {
    const { container } = render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Create or open' }));

    expect(mocks.deviceStore.openCreator).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Create or open' })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    expect(container.querySelector('.launcher-menu')).toBeNull();
  });

  it('keeps the current chat and project until a device/workspace is chosen', async () => {
    render(SessionSidebar);

    await fireEvent.click(screen.getByRole('button', { name: 'Create or open' }));
    expect(mocks.deviceStore.openCreator).toHaveBeenCalledOnce();
    expect(mocks.sessionStore.activeSessionId).toBe('session-1');
    expect(mocks.projectStore.currentPath).toBe('/tmp/project');
    expect(mocks.sessionStore.newChat).not.toHaveBeenCalled();
  });

  it('does not allow another chat while the current chat is still new', async () => {
    const otherSession = {
      ...session,
      id: 'session-other-folder',
      title: 'Other folder chat',
      workingDirectory: '/tmp/other',
    };
    mocks.sessionStore.sessions = [{ ...session, messageCount: 0 }, otherSession];
    mocks.sessionStore.filteredSessions = mocks.sessionStore.sessions;
    mocks.sessionStore.activeSessionId = session.id;
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
      { path: '/tmp/other', name: 'other', modifiedAt: Date.now() },
    ];

    render(SessionSidebar);

    // The guard now sits on the project's New chat button for that folder.
    const newChatButton = screen
      .getAllByRole('button', { name: 'New chat' })
      .find((button) => button.getAttribute('title')?.includes('Finish naming'));
    expect(newChatButton).toBeDisabled();
    if (newChatButton) await fireEvent.click(newChatButton);

    expect(mocks.sessionStore.createSession).not.toHaveBeenCalled();
  });

  it('shows a billing-style skeleton while the agent names a new session', () => {
    mocks.sessionStore.sessions = [{ ...session, title: 'New Session', messageCount: 1 }];
    mocks.sessionStore.filteredSessions = mocks.sessionStore.sessions;

    render(SessionSidebar);

    expect(screen.getByRole('status', { name: 'Naming chat' })).toHaveClass('animate-pulse');
    expect(screen.queryByText('New Session')).toBeNull();
  });

  it('only spins the project plus that started chat creation', async () => {
    const otherSession = {
      ...session,
      id: 'session-3',
      title: 'Other chat',
      workingDirectory: '/tmp/other',
    };
    mocks.sessionStore.sessions = [session, otherSession];
    mocks.sessionStore.filteredSessions = mocks.sessionStore.sessions;
    mocks.projectStore.workspaceRoot = '/tmp/workspace';
    mocks.projectStore.workspaceProjects = [
      { path: '/tmp/project', name: 'project', modifiedAt: Date.now() },
      { path: '/tmp/other', name: 'other', modifiedAt: Date.now() },
    ];
    let resolveCreate!: (id: string) => void;
    mocks.sessionStore.createSession.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    // New chat now lives as a button next to the project's 3 dots.
    const onAction = vi.fn();
    render(SessionSidebar, { props: { onAction } });

    const newChatButton = screen
      .getAllByRole('button', { name: 'New chat' })
      .find((button) => button.getAttribute('title') === 'New chat in project');
    await fireEvent.click(newChatButton!);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('new_project_chat:%2Ftmp%2Fproject');
    resolveCreate('new-session');
    await Promise.resolve();
  });
});
