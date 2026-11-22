<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { useNow } from '$lib/utils/now-signal.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { runStateStore } from '$lib/stores/run-state.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import {
    projectIdentityProjection,
    projectStore,
    projectDisplayName,
  } from '$lib/stores/project.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import JoinedTeamTree from './JoinedTeamTree.svelte';
  import { deviceStore } from '$lib/stores/devices.svelte';
  import Monitor from 'lucide-svelte/icons/monitor';
  import { isGuidedDemo } from '$lib/demo-flags';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import Plus from 'lucide-svelte/icons/plus';
  import SquarePen from 'lucide-svelte/icons/square-pen';
  import Search from 'lucide-svelte/icons/search';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Archive from 'lucide-svelte/icons/archive';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import UserPlus from 'lucide-svelte/icons/user-plus';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import Target from 'lucide-svelte/icons/target';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ToolActivityIcon from './ToolActivityIcon.svelte';
  import { feedStore } from '$lib/stores/feed.svelte';
  import ProjectIcon from './ProjectIcon.svelte';
  import ProjectIconContextMenu from './ProjectIconContextMenu.svelte';
  import MoreHorizontal from 'lucide-svelte/icons/more-horizontal';
  import ChatActionsMenu from './ChatActionsMenu.svelte';
  import Pin from 'lucide-svelte/icons/pin';
  import { copyText } from '$lib/utils/clipboard';
  import {
    chatSidebarPrefs,
    projectSidebarPrefs,
    projectOrderPrefs,
    chatOrderPrefs,
  } from '$lib/stores/project-sidebar-prefs.svelte';
  import WorkspaceIconContextMenu from './WorkspaceIconContextMenu.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { goalStore } from '$lib/stores/goals.svelte';
  import { formatGoalRuntime, isActiveGoal } from '$lib/utils/goal-actions';
  import { formatUsd, USD_UNKNOWN } from '$lib/utils/usd';
  import {
    isSessionActionWarningSuppressed,
    suppressSessionActionWarning,
  } from '$lib/stores/session-action-warnings';
  import {
    sessionLifecycleConfirmLabel,
    sessionLifecycleTitle,
    sessionLifecycleWarning,
    type SessionLifecycleAction,
  } from '$lib/utils/session-lifecycle-warning';
  import { goalProgress, type AgentStatus, type Session } from '@koryphaios/shared';

  interface ProjectSessionGroup {
    key: string;
    label: string;
    path: string;
    sessions: Session[];
    runningCount: number;
    failedCount: number;
    compactingCount: number;
    statusSlices: StatusSlice[];
    latestActivity: number;
    projectIdentity?: ReturnType<typeof projectIdentityProjection>;
  }

  interface StatusSlice {
    key: 'running' | 'failed' | 'compacting' | 'waiting' | 'completed' | 'cancelled' | 'idle';
    label: string;
    count: number;
    color: string;
  }

  interface SessionBillingModel {
    model: string;
    spendUsd: number | null;
    hasKnownCost: boolean;
    pricingIncomplete: boolean;
    subscription: boolean;
    apiEquivalentUsd?: number | null;
  }

  interface SessionBillingProvider {
    name: string;
    spendUsd: number | null;
    hasKnownCost: boolean;
    pricingIncomplete: boolean;
    subscription: boolean;
    apiEquivalentUsd?: number | null;
    models: SessionBillingModel[];
  }

  interface SessionBillingSummary {
    spendUsd: number;
    spendCents: number;
    hasKnownCost: boolean;
    pricingIncomplete: boolean;
    hasMeteredUsage: boolean;
    hasSubscriptionUsage: boolean;
    providers?: SessionBillingProvider[];
  }

  const SESSION_BILLING_PREFERENCES_STORAGE_KEY = 'koryphaios-billing-preferences-v1';
  const DEFAULT_SESSION_TITLE = 'New Session';

  interface Props {
    currentSessionId?: string;
    recentProjects?: Array<{
      id: string;
      title: string;
      path?: string;
      fileName?: string;
    }>;
    onAction?: (action: string) => void | Promise<void>;
  }

  let { currentSessionId = $bindable(''), recentProjects = [], onAction }: Props = $props();

  let editingId = $state<string>('');
  let editTitle = $state<string>('');
  let editError = $state<boolean>(false);
  // One pending lifecycle action drives one warning screen: archiving and
  // deleting show the same warning with a different verb.
  let pendingLifecycle = $state<{ action: SessionLifecycleAction; id: string } | null>(null);
  let suppressLifecycleWarning = $state<boolean>(false);
  let archivingId = $state<string>('');
  let creatingProjectPath = $state<string | null>(null);
  let removeProjectPath = $state<string | null>(null);
  // Confirmation state for deleting all chats in a project from the icon menu.
  let confirmDeleteChats = $state<boolean>(false);
  let deleteChatsProjectPath = $state<string>('');
  let deleteChatsProjectName = $state<string>('');
  let deleteChatsCount = $state<number>(0);
  // Drag-and-drop reordering state.
  let draggedProjectPath = $state<string | null>(null);
  let dragOverProjectPath = $state<string | null>(null);
  let draggedChat = $state<{ projectPath: string; sessionId: string } | null>(null);
  let dragOverChatId = $state<string | null>(null);
  let chatActionsMenu = $state<{
    id: string;
    sessionId: string;
    chatTitle: string;
    x: number;
    y: number;
    returnFocus: HTMLElement | null;
  } | null>(null);

  function openChatActionsMenu(event: MouseEvent, session: Session) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    chatActionsMenu = {
      id: `chat-actions-${session.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      sessionId: session.id,
      chatTitle: session.title,
      x: rect.right - 240,
      y: rect.bottom + 4,
      returnFocus: trigger,
    };
  }

  function openChatActionsContextMenu(event: MouseEvent, session: Session) {
    if (isGuidedDemo) return;
    event.preventDefault();
    event.stopPropagation();
    chatActionsMenu = {
      id: `chat-actions-${session.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      sessionId: session.id,
      chatTitle: session.title,
      x: event.clientX,
      y: event.clientY,
      returnFocus: (event.currentTarget as HTMLElement | null)?.closest('button[aria-haspopup="menu"]') ?? null,
    };
  }

  function openChatActionsMenuFromKeyboard(event: KeyboardEvent, session: Session) {
    if (isGuidedDemo) return;
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    chatActionsMenu = {
      id: `chat-actions-${session.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      sessionId: session.id,
      chatTitle: session.title,
      x: rect.left,
      y: rect.bottom + 4,
      returnFocus: trigger,
    };
  }

  function handleChatAction(action: string) {
    const target = chatActionsMenu;
    if (!target) return;
    const { sessionId, chatTitle } = target;
    if (action === 'rename') {
      startRename(sessionId, chatTitle);
      return;
    }
    if (action === 'copy_id') {
      void copyText(sessionId).then(
        () => toastStore.success('Chat ID copied'),
        () => toastStore.error('Could not copy the chat ID'),
      );
      return;
    }
    if (action === 'archive') {
      void handleArchive(new MouseEvent('click'), sessionId);
      return;
    }
    if (action === 'delete') {
      confirmDelete(new MouseEvent('click'), sessionId);
    }
  }
  let launcherOpen = $state(false);
  let showTeamSidebarShortcut = $state(false);
  let goalClock = $state(Date.now());
  let collapsedProjectKeys = $state<Set<string>>(new Set());
  let collapsedWorkspaceRoot = $state<string | null>(null);
  let sessionBilling = $state<Record<string, SessionBillingSummary>>({});
  /** True once the first session-costs payload has landed, so an absent session
   *  means "no metered spend" rather than "not loaded yet". */
  let sessionBillingLoaded = $state(false);
  let hoveredCostSessionId = $state('');
  /** Viewport coordinates for the fixed tracked-spend popover. */
  let costPopoverAnchor = $state<{ left: number; top: number } | null>(null);
  let statusPopoverAnchor = $state<{ left: number; top: number } | null>(null);
  let hoveredStatusProjectKey = $state<string | null>(null);
  let costPopoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
  // Keep only identity, never a snapshot of reactive project membership/status.
  let statusDetailProjectKey = $state<string | null>(null);
  let billingExcludedProviders = $state<string[]>([]);
  let showSubscriptionApiEquivalent = $state(true);
  let sessionBillingTimer: ReturnType<typeof setInterval> | null = null;
  let billingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces the burst of usage events a single turn emits into one read. */
  const BILLING_USAGE_REFRESH_DEBOUNCE_MS = 400;
  let projectIconContextMenu = $state<{
    id: string;
    projectName: string;
    projectPath: string;
    x: number;
    y: number;
    returnFocus: HTMLElement | null;
  } | null>(null);
  let workspaceIconContextMenu = $state<{
    id: string;
    workspaceName: string;
    workspacePath: string;
    x: number;
    y: number;
    expanded: boolean;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const TEAM_UI_PREFERENCES_STORAGE_KEY = 'koryphaios-team-ui-preferences-v1';
  const nowClock = useNow();
  $effect(() => {
    goalClock = nowClock.now;
  });
  // Track which session we last loaded feed for, so we load when active changes (e.g. new session from +)
  let lastLoadedSessionId = $state<string>('');

  function loadSidebarBillingPreferences() {
    if (typeof localStorage === 'undefined') return;
    try {
      const parsed = JSON.parse(
        localStorage.getItem(SESSION_BILLING_PREFERENCES_STORAGE_KEY) ?? '{}',
      ) as {
        excludedProviders?: string[];
        showSubscriptionApiEquivalent?: boolean;
      };
      billingExcludedProviders = Array.isArray(parsed.excludedProviders)
        ? parsed.excludedProviders.filter((provider) => typeof provider === 'string')
        : [];
      showSubscriptionApiEquivalent = parsed.showSubscriptionApiEquivalent !== false;
    } catch {
      billingExcludedProviders = [];
      showSubscriptionApiEquivalent = true;
    }
  }

  function loadTeamUiPreferences() {
    if (typeof localStorage === 'undefined') return;
    try {
      const parsed = JSON.parse(localStorage.getItem(TEAM_UI_PREFERENCES_STORAGE_KEY) ?? '{}') as {
        showTeamSidebarShortcut?: boolean;
      };
      showTeamSidebarShortcut = parsed.showTeamSidebarShortcut === true;
    } catch {
      showTeamSidebarShortcut = false;
    }
  }

  function runLauncherAction(action: string) {
    launcherOpen = false;
    if (onAction) void onAction(action);
  }

  function sidebarBillingPath(path: string): string {
    const params = new URLSearchParams();
    for (const provider of billingExcludedProviders) params.append('excludeProvider', provider);
    const query = params.toString();
    return `${path}${query ? `?${query}` : ''}`;
  }

  /** The one price string for a session. The sidebar row and its
   *  tracked-spend popover both render this, so a session can never show a
   *  row price that disagrees with its own breakdown. */
  function billingSummaryLabel(summary: SessionBillingSummary | null | undefined): string {
    if (!summary) return '';
    if (!summary.hasMeteredUsage && summary.hasSubscriptionUsage) return formatUsd(0);
    if (summary.hasMeteredUsage && !summary.hasKnownCost) return USD_UNKNOWN;
    return formatUsd(summary.spendUsd ?? summary.spendCents / 100);
  }

  function sessionCostLabel(session: Session): string {
    const summary = sessionBilling[session.id];
    if (summary) return billingSummaryLabel(summary);
    // Pre-ledger fallback only: printed until the first poll lands. It is a
    // different accumulator (`messages.cost`) so it must never be shown beside a
    // ledger price; nothing else in this component reads `totalCost`.
    if (session.totalCost > 0) return formatUsd(session.totalCost);
    if ((session.totalTokensIn ?? 0) > 0 || (session.totalTokensOut ?? 0) > 0) return USD_UNKNOWN;
    return '';
  }

  /** The one read of session spend. Rows and the tracked-spend card render this
   *  exact payload, so a session shows one price on both surfaces. A second,
   *  separately-timed read is how the card and the row drifted apart. */
  async function loadSessionBilling() {
    try {
      const response = await apiFetch(
        apiUrl(sidebarBillingPath('/api/billing/session-costs')),
        {},
        3_000,
      );
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload?.ok || !payload.sessions) return;
      sessionBilling = payload.sessions;
      sessionBillingLoaded = true;
    } catch {
      // Supplemental UI: preserve last-known-good costs on transient failures.
    }
  }

  onMount(() => {
    if (!goalStore.loaded) void goalStore.refresh();
    loadSidebarBillingPreferences();
    loadTeamUiPreferences();
    void loadSessionBilling();
    const handleBillingPreferencesChanged = () => {
      loadSidebarBillingPreferences();
      void loadSessionBilling();
    };
    const handleTeamUiPreferencesChanged = () => loadTeamUiPreferences();
    /** Spend is written when a turn reports usage, not on a clock. Refreshing
     *  from that signal keeps the price current at the moment it changes, so the
     *  poll interval below is only a fallback for other writers (reprice, other
     *  windows, CLI usage imports). */
    const handleUsageChanged = () => {
      if (billingRefreshTimer) return;
      billingRefreshTimer = setTimeout(() => {
        billingRefreshTimer = null;
        void loadSessionBilling();
      }, BILLING_USAGE_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener('kory:usage-changed', handleUsageChanged);
    window.addEventListener('kory:billing-preferences-changed', handleBillingPreferencesChanged);
    window.addEventListener('kory:team-ui-preferences-changed', handleTeamUiPreferencesChanged);
    sessionBillingTimer = setInterval(() => void loadSessionBilling(), 15_000);
    return () => {
      nowClock.unsubscribe();
      cancelCostPopoverClose();
      if (sessionBillingTimer) clearInterval(sessionBillingTimer);
      if (billingRefreshTimer) clearTimeout(billingRefreshTimer);
      window.removeEventListener('kory:usage-changed', handleUsageChanged);
      window.removeEventListener(
        'kory:billing-preferences-changed',
        handleBillingPreferencesChanged,
      );
      window.removeEventListener(
        'kory:team-ui-preferences-changed',
        handleTeamUiPreferencesChanged,
      );
    };
  });

  const goalsForSession = (sessionId: string) =>
    goalStore.goals.filter((goal) => isActiveGoal(goal) && goal.execution?.sessionId === sessionId);

  const sidebarSessions = $derived.by(() => {
    const query = sessionStore.searchQuery.trim().toLowerCase();
    const localSessions = sessionStore.sessions.filter(
      (session) => !session.id.startsWith('linked-'),
    );
    if (!query) return localSessions;
    return localSessions.filter((session) => {
      const path = session.workingDirectory ?? '';
      return (
        session.title.toLowerCase().includes(query) ||
        path.toLowerCase().includes(query) ||
        projectDisplayName(path).toLowerCase().includes(query)
      );
    });
  });

  const activeSession = $derived(
    sessionStore.sessions.find((session) => session.id === sessionStore.activeSessionId),
  );
  const activeSessionIsNew = $derived(activeSession?.messageCount === 0);
  const activeSessionFolder = $derived(activeSession?.workingDirectory?.trim() ?? '');

  function isNewChatBlockedForFolder(folder: string): boolean {
    return activeSessionIsNew && activeSessionFolder === folder.trim();
  }

  function isNamingSession(session: Session): boolean {
    return session.title.trim() === DEFAULT_SESSION_TITLE;
  }

  function statusCategory(status: AgentStatus): StatusSlice['key'] | null {
    if (status === 'idle') return 'idle';
    if (status === 'error') return 'failed';
    if (status === 'compacting') return 'compacting';
    if (status === 'waiting' || status === 'waiting_user') return 'waiting';
    if (status === 'done') return 'completed';
    return 'running';
  }

  // A chat the user stopped (or whose run was cancelled) is not a completed
  // run. The done-linger reverts legacy terminal icons to idle, but a user
  // stop mutates phase directly and a canonical cancelled snapshot never
  // reverts — so without this check a stopped chat wears the done checkmark
  // forever.
  function isSessionStopped(sessionId: string): boolean {
    return (
      runStateStore.getPhase(sessionId) === 'cancelled' ||
      runStateStore.isStoppedByUser(sessionId)
    );
  }

  function statusSlicesForSessions(sessions: Session[]): StatusSlice[] {
    const counts: Record<StatusSlice['key'], number> = {
      running: 0,
      failed: 0,
      compacting: 0,
      waiting: 0,
      completed: 0,
      cancelled: 0,
      idle: 0,
    };

    // The pie represents chats, not retained worker cards from earlier turns.
    // Canonical run outcomes include failure/cancellation and survive navigation.
    for (const session of sessions) {
      const category = isSessionStopped(session.id)
        ? 'cancelled'
        : statusCategory(wsStore.getManagerStatusForSession(session.id));
      if (category) counts[category] += 1;
    }

    return [
      { key: 'running', label: 'Running', count: counts.running, color: 'var(--color-text-muted)' },
      { key: 'failed', label: 'Failed', count: counts.failed, color: 'var(--color-error)' },
      {
        key: 'compacting',
        label: 'Compacting',
        count: counts.compacting,
        color: 'var(--color-warning)',
      },
      { key: 'waiting', label: 'Waiting', count: counts.waiting, color: 'var(--color-accent)' },
      {
        key: 'completed',
        label: 'Completed',
        count: counts.completed,
        color: 'var(--color-success)',
      },
      {
        key: 'cancelled',
        label: 'Cancelled',
        count: counts.cancelled,
        color: 'var(--color-text-muted)',
      },
      { key: 'idle', label: 'Idle', count: counts.idle, color: 'var(--color-surface-3)' },
    ].filter((slice) => slice.count > 0) as StatusSlice[];
  }

  interface PieWedge {
    d: string;
    color: string;
  }

  function statusPieWedges(slices: StatusSlice[]): PieWedge[] {
    const total = slices.reduce((sum, slice) => sum + slice.count, 0);
    if (total === 0) return [];
    const cx = 16;
    const cy = 16;
    const r = 16;
    let offset = 0;
    return slices.map((slice) => {
      const start = (offset / total) * Math.PI * 2 - Math.PI / 2;
      offset += slice.count;
      const end = (offset / total) * Math.PI * 2 - Math.PI / 2;
      let d: string;
      if (end - start >= Math.PI * 2 - 1e-6) {
        d = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`;
      } else {
        const x1 = cx + r * Math.cos(start);
        const y1 = cy + r * Math.sin(start);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);
        const largeArc = end - start > Math.PI ? 1 : 0;
        d = `M ${cx} ${cy} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`;
      }
      return { d, color: slice.color };
    });
  }

  function statusChartBackground(slices: StatusSlice[]): string {
    if (slices.length === 0) return 'var(--color-surface-3)';
    const total = Math.max(
      1,
      slices.reduce((sum, slice) => sum + slice.count, 0),
    );
    let offset = 0;
    return `conic-gradient(${slices
      .map((slice) => {
        const start = (offset / total) * 360;
        offset += slice.count;
        return `${slice.color} ${start}deg ${(offset / total) * 360}deg`;
      })
      .join(', ')})`;
  }

  function projectStatusText(project: ProjectSessionGroup): string {
    if (project.runningCount > 0) return `${project.runningCount} running`;
    if (project.failedCount > 0) return `${project.failedCount} failed`;
    if (project.compactingCount > 0) return `${project.compactingCount} compacting`;
    return `${project.sessions.length} ${project.sessions.length === 1 ? 'chat' : 'chats'}`;
  }

  function statusColor(status: AgentStatus): string {
    if (status === 'done') return 'var(--color-success)';
    if (status === 'error') return 'var(--color-error)';
    if (status === 'waiting' || status === 'waiting_user') return 'var(--color-accent)';
    return 'var(--color-text-muted)';
  }

  const WORKSPACE_ROOT_KEY = '__workspace_root__';

  const projectGroups = $derived.by(() => {
    const workspaceRoot = projectStore.workspaceRoot;
    const sessionsByProject = new Map<
      string,
      {
        label: string;
        path: string;
        sessions: Session[];
        latestActivity: number;
        isWorkspaceRoot?: boolean;
      }
    >();

    // Candidate project folders come from the workspace listing, but a folder
    // with no chat is only reachable through the workspace new-chat screen.
    // Dumping every empty folder into the sidebar buries the chats that exist.
    for (const project of projectStore.workspaceProjects ?? []) {
      sessionsByProject.set(project.path, {
        label: project.name,
        path: project.path,
        sessions: [],
        latestActivity: project.modifiedAt,
      });
    }

    for (const session of sidebarSessions) {
      const path = session.workingDirectory?.trim() ?? '';
      // A chat rooted at the workspace itself (or with no working directory)
      // belongs to the workspace node, not to a synthetic "Workspace root"
      // folder nested inside it.
      if (workspaceRoot && (!path || path === workspaceRoot)) {
        const root = sessionsByProject.get(WORKSPACE_ROOT_KEY);
        if (root) {
          root.sessions.push(session);
          root.latestActivity = Math.max(root.latestActivity, session.updatedAt);
        } else {
          sessionsByProject.set(WORKSPACE_ROOT_KEY, {
            label: '',
            path: workspaceRoot,
            sessions: [session],
            latestActivity: session.updatedAt,
            isWorkspaceRoot: true,
          });
        }
        continue;
      }

      const key = path || '__workspace__';
      const existing = sessionsByProject.get(key);
      if (existing) {
        existing.sessions.push(session);
        existing.latestActivity = Math.max(existing.latestActivity, session.updatedAt);
        continue;
      }

      const knownProject = projectStore.workspaceProjects?.find((project) => project.path === path);
      const workspaceLabel = workspaceRoot ? projectDisplayName(workspaceRoot) : 'Workspace';
      sessionsByProject.set(key, {
        label: knownProject?.name || projectDisplayName(path) || workspaceLabel,
        path,
        sessions: [session],
        latestActivity: session.updatedAt,
      });
    }

    // Drop folders that never received a chat, unless the reader is currently
    // inside one — the selected project must stay reachable.
    for (const [key, project] of [...sessionsByProject]) {
      if (
        !project.isWorkspaceRoot &&
        project.sessions.length === 0 &&
        project.path !== projectStore.currentPath
      ) {
        sessionsByProject.delete(key);
      }
    }

    return [...sessionsByProject.entries()]
      .map(([key, project]) => {
        // Apply custom chat order within this project.
        const chatOrd = chatOrderPrefs.getOrder(project.path);
        if (chatOrd.length) {
          project.sessions.sort((a, b) => {
            const ai = chatOrd.indexOf(a.id);
            const bi = chatOrd.indexOf(b.id);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return 0;
          });
        }
        const statusSlices = statusSlicesForSessions(project.sessions);
        const workspaceEntry = projectStore.workspaceProjects?.find(
          (entry) => entry.path === project.path,
        );
        const projectIdentity = project.isWorkspaceRoot
          ? undefined
          : projectIdentityProjection(
              workspaceEntry ?? {
                path: project.path,
                name: project.label || projectDisplayName(project.path),
                modifiedAt: project.latestActivity,
              },
            );
        return {
          key,
          ...project,
          label: projectIdentity?.identity.name ?? project.label,
          statusSlices,
          runningCount: statusSlices.find((slice) => slice.key === 'running')?.count ?? 0,
          failedCount: statusSlices.find((slice) => slice.key === 'failed')?.count ?? 0,
          compactingCount: statusSlices.find((slice) => slice.key === 'compacting')?.count ?? 0,
          projectIdentity,
        };
      })
      .sort((left, right) => {
        // Pinned projects stay at the top of the list.
        const leftPinned = projectSidebarPrefs.isPinned(left.path) ? 1 : 0;
        const rightPinned = projectSidebarPrefs.isPinned(right.path) ? 1 : 0;
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        // Custom drag-and-drop order, if set.
        const order = projectOrderPrefs.getOrder();
        if (order.length) {
          const li = order.indexOf(left.path);
          const ri = order.indexOf(right.path);
          if (li !== -1 && ri !== -1) return li - ri;
          if (li !== -1) return -1;
          if (ri !== -1) return 1;
        }
        if (left.path === projectStore.currentPath) return -1;
        if (right.path === projectStore.currentPath) return 1;
        return right.latestActivity - left.latestActivity;
      });
  });

  const pinnedChats = $derived(
    sidebarSessions.filter((session) => chatSidebarPrefs.isPinned(session.id)),
  );
  const statusDetailProject = $derived(
    projectGroups.find((project) => project.key === statusDetailProjectKey) ?? null,
  );
  $effect(() => {
    if (statusDetailProjectKey !== null && !statusDetailProject) statusDetailProjectKey = null;
  });

  /** Project folders under the workspace, excluding the workspace node itself. */
  const workspaceProjectCount = $derived(
    projectGroups.filter((project) => !project.isWorkspaceRoot).length,
  );

  /** Chats attached directly to the workspace node. */
  const workspaceRootChatCount = $derived.by(
    () => projectGroups.find((project) => project.isWorkspaceRoot)?.sessions.length ?? 0,
  );

  function toggleProjectGroup(key: string) {
    const next = new Set(collapsedProjectKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedProjectKeys = next;
  }

  function isProjectGroupExpanded(key: string): boolean {
    return Boolean(sessionStore.searchQuery.trim()) || !collapsedProjectKeys.has(key);
  }

  function isWorkspaceExpanded(): boolean {
    const root = projectStore.workspaceRoot;
    return !root || Boolean(sessionStore.searchQuery.trim()) || collapsedWorkspaceRoot !== root;
  }

  function projectIconMenuId(path: string): string {
    return `project-icon-menu-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  function openProjectIconContextMenu(
    event: MouseEvent,
    project: ProjectSessionGroup,
    returnFocus?: HTMLElement | null,
  ) {
    event.preventDefault();
    event.stopPropagation();
    projectIconContextMenu = {
      id: projectIconMenuId(project.path),
      projectName: project.label,
      projectPath: project.path,
      x: event.clientX,
      y: event.clientY,
      returnFocus:
        returnFocus ?? (event.currentTarget as HTMLElement | null)?.closest('button') ?? null,
    };
  }

  function openProjectIconContextMenuFromKeyboard(
    event: KeyboardEvent,
    project: ProjectSessionGroup,
  ) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    projectIconContextMenu = {
      id: projectIconMenuId(project.path),
      projectName: project.label,
      projectPath: project.path,
      x: rect.left,
      y: rect.bottom + 4,
      returnFocus: trigger,
    };
  }

  function closeProjectIconContextMenu() {
    projectIconContextMenu = null;
  }

  function handleProjectIconContextAction(action: string) {
    // The menu encodes its target as `name:<encoded path>`, because these three
    // actions belong to the sidebar (pin, archive-all, close) rather than to the
    // page that owns project identity and navigation.
    const separator = action.indexOf(':');
    const name = separator === -1 ? action : action.slice(0, separator);
    const projectPath = separator === -1 ? '' : decodeURIComponent(action.slice(separator + 1));

    if (name === 'pin_project') {
      const pinned = projectSidebarPrefs.togglePin(projectPath);
      toastStore.success(
        `${projectDisplayName(projectPath)} ${pinned ? 'pinned' : 'unpinned'}`,
      );
      return;
    }

    if (name === 'archive_project_chats') {
      void archiveProjectChats(projectPath);
      return;
    }

    if (name === 'close_project') {
      void removeProjectFromSidebar(projectPath);
      return;
    }

    if (name === 'remove_project') {
      void removeProjectFromSidebar(projectPath);
      return;
    }

    if (name === 'delete_project_chats') {
      void confirmDeleteProjectChats(projectPath);
      return;
    }

    if (onAction) void onAction(action);
  }

  async function confirmDeleteProjectChats(projectPath: string) {
    const project = projectGroups.find((p) => p.path === projectPath);
    const deletable = project?.sessions.filter((session) => !session.archivedAt) ?? [];
    if (deletable.length === 0) {
      toastStore.info(`No chats to delete in ${projectDisplayName(projectPath)}`);
      return;
    }
    deleteChatsProjectPath = projectPath;
    deleteChatsProjectName = projectDisplayName(projectPath);
    deleteChatsCount = deletable.length;
    confirmDeleteChats = true;
  }

  async function deleteProjectChats(projectPath: string) {
    const project = projectGroups.find((p) => p.path === projectPath);
    const deletable = project?.sessions.filter((session) => !session.archivedAt) ?? [];
    let deleted = 0;
    for (const session of deletable) {
      if (await sessionStore.deleteSession(session.id)) deleted += 1;
    }
    if (deleted > 0) {
      toastStore.success(
        `Deleted ${deleted} ${deleted === 1 ? 'chat' : 'chats'} in ${projectDisplayName(projectPath)}`,
      );
    }
    confirmDeleteChats = false;
    deleteChatsProjectPath = '';
    deleteChatsProjectName = '';
    deleteChatsCount = 0;
  }

  async function archiveProjectChats(projectPath: string) {
    const chats =
      projectGroups.find((project) => project.path === projectPath)?.sessions ?? [];
    const archivable = chats.filter((session) => !session.archivedAt);
    if (archivable.length === 0) {
      toastStore.info(`No chats to archive in ${projectDisplayName(projectPath)}`);
      return;
    }
    let archived = 0;
    for (const session of archivable) {
      if (await sessionStore.archiveSession(session.id)) archived += 1;
    }
    if (archived > 0) {
      toastStore.success(
        `Archived ${archived} ${archived === 1 ? 'chat' : 'chats'} in ${projectDisplayName(projectPath)}`,
      );
    }
  }

  /** Close a project the sidebar opened. Its folder, files and chats are left
   *  alone — this only stops the sidebar from listing it. */
  async function removeProjectFromSidebar(projectPath: string) {
    removeProjectPath = projectPath;
    try {
      const res = await apiFetch(apiUrl('/api/workspace/projects/close'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      if (!res.ok) throw new Error(`Close project failed (${res.status})`);
      projectStore.removeProject(projectPath);
      toastStore.success(`Removed ${projectDisplayName(projectPath)} from the sidebar`);
    } catch (err: unknown) {
      toastStore.error(
        err instanceof Error ? err.message : 'Could not remove that project',
      );
    } finally {
      removeProjectPath = null;
    }
  }

  // Drag-and-drop reordering handlers.
  function onProjectDragStart(event: DragEvent, path: string) {
    draggedProjectPath = path;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', path);
    }
  }
  function onProjectDragOver(event: DragEvent, path: string) {
    if (!draggedProjectPath || draggedProjectPath === path) return;
    event.preventDefault();
    dragOverProjectPath = path;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  function onProjectDrop(event: DragEvent, path: string) {
    event.preventDefault();
    if (!draggedProjectPath || draggedProjectPath === path) return;
    const order = [...projectOrderPrefs.getOrder()];
    // Seed order with current project paths if empty.
    const allPaths = projectGroups.map((p) => p.path);
    const base = order.length ? order : allPaths;
    const fromIdx = base.indexOf(draggedProjectPath);
    const toIdx = base.indexOf(path);
    if (fromIdx === -1 || toIdx === -1) {
      draggedProjectPath = null;
      dragOverProjectPath = null;
      return;
    }
    const next = [...base];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedProjectPath);
    projectOrderPrefs.setOrder(next);
    draggedProjectPath = null;
    dragOverProjectPath = null;
  }
  function onProjectDragEnd() {
    draggedProjectPath = null;
    dragOverProjectPath = null;
  }

  function onChatDragStart(event: DragEvent, projectPath: string, sessionId: string) {
    draggedChat = { projectPath, sessionId };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', sessionId);
    }
  }
  function onChatDragOver(event: DragEvent, sessionId: string) {
    if (!draggedChat) return;
    if (draggedChat.sessionId === sessionId) return;
    event.preventDefault();
    dragOverChatId = sessionId;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  function onChatDrop(event: DragEvent, projectPath: string, sessionId: string) {
    event.preventDefault();
    if (!draggedChat || draggedChat.projectPath !== projectPath) return;
    if (draggedChat.sessionId === sessionId) return;
    const order = [...chatOrderPrefs.getOrder(projectPath)];
    const sessions = projectGroups.find((p) => p.path === projectPath)?.sessions ?? [];
    const allIds = sessions.map((s) => s.id);
    const base = order.length ? order : allIds;
    const fromIdx = base.indexOf(draggedChat.sessionId);
    const toIdx = base.indexOf(sessionId);
    if (fromIdx === -1 || toIdx === -1) {
      draggedChat = null;
      dragOverChatId = null;
      return;
    }
    const next = [...base];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggedChat.sessionId);
    chatOrderPrefs.setOrder(projectPath, next);
    draggedChat = null;
    dragOverChatId = null;
  }
  function onChatDragEnd() {
    draggedChat = null;
    dragOverChatId = null;
  }

  function workspaceIconMenuId(path: string): string {
    return `workspace-icon-menu-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  function openWorkspaceIconContextMenu(event: MouseEvent, returnFocus?: HTMLElement | null) {
    const workspacePath = projectStore.workspaceRoot;
    if (!workspacePath) return;
    event.preventDefault();
    event.stopPropagation();
    workspaceIconContextMenu = {
      id: workspaceIconMenuId(workspacePath),
      workspaceName: projectDisplayName(workspacePath),
      workspacePath,
      x: event.clientX,
      y: event.clientY,
      expanded: isWorkspaceExpanded(),
      returnFocus:
        returnFocus ?? (event.currentTarget as HTMLElement | null)?.closest('button') ?? null,
    };
  }

  function openWorkspaceIconContextMenuFromKeyboard(event: KeyboardEvent) {
    const workspacePath = projectStore.workspaceRoot;
    if (!workspacePath || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    workspaceIconContextMenu = {
      id: workspaceIconMenuId(workspacePath),
      workspaceName: projectDisplayName(workspacePath),
      workspacePath,
      x: rect.left,
      y: rect.bottom + 4,
      expanded: isWorkspaceExpanded(),
      returnFocus: trigger.closest('button'),
    };
  }

  function closeWorkspaceIconContextMenu() {
    workspaceIconContextMenu = null;
  }

  function handleWorkspaceIconContextAction(action: string) {
    if (action === 'workspace_toggle') {
      toggleWorkspace();
      return;
    }
    if (action === 'workspace_new_chat') {
      requestWorkspaceNewChat();
      return;
    }
    if (onAction) void onAction(action);
  }

  /** Chats rooted at the workspace are created from the workspace new-chat
   *  screen (which can target a project folder), never directly from here. */
  /** Measure the trigger so the fixed popover can sit just below it in
   *  viewport coordinates instead of being clipped by the sidebar. */
  function anchorCostPopover(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    costPopoverAnchor = { left: Math.round(rect.left), top: Math.round(rect.bottom + 4) };
  }

  const COST_POPOVER_CLOSE_DELAY_MS = 160;

  /** The tracked-spend card is portalled to <body>, so the pointer leaving
   *  the price no longer implies the pointer left the card. Closing on a short
   *  delay keeps the card open while the pointer crosses the gap into it. */
  function openCostPopover(sessionId: string, trigger: HTMLElement) {
    cancelCostPopoverClose();
    hoveredCostSessionId = sessionId;
    anchorCostPopover(trigger);
    // The card reads the polled summary, so opening it can never show a
    // different number from the row that triggered it.
  }

  function keepCostPopoverOpen() {
    cancelCostPopoverClose();
  }

  function cancelCostPopoverClose() {
    if (!costPopoverCloseTimer) return;
    clearTimeout(costPopoverCloseTimer);
    costPopoverCloseTimer = null;
  }

  function closeCostPopover() {
    cancelCostPopoverClose();
    hoveredCostSessionId = '';
    costPopoverAnchor = null;
  }

  function scheduleCostPopoverClose() {
    if (costPopoverCloseTimer) clearTimeout(costPopoverCloseTimer);
    costPopoverCloseTimer = setTimeout(() => {
      costPopoverCloseTimer = null;
      hoveredCostSessionId = '';
      costPopoverAnchor = null;
    }, COST_POPOVER_CLOSE_DELAY_MS);
  }

  function openStatusPopover(projectKey: string, trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    hoveredStatusProjectKey = projectKey;
    statusPopoverAnchor = { left: Math.round(rect.left + rect.width / 2), top: Math.round(rect.bottom + 4) };
  }
  function closeStatusPopover() {
    hoveredStatusProjectKey = null;
    statusPopoverAnchor = null;
  }

  /** Re-parent a node under <body> so its stacking context is the document's.
   *  The chat row isolates and the sidebar nav is promoted by `will-change`,
   *  so a card nested inside them can never paint above the chat column no
   *  matter how high its own z-index is. */
  function portalToBody(node: HTMLElement) {
    if (typeof document === 'undefined') return {};
    document.body.appendChild(node);
    return {
      destroy() {
        cancelCostPopoverClose();
        node.remove();
      },
    };
  }

  /** Clicking the tracked price — or the card it opens — takes the user to the
   *  billing section in Settings, where these numbers can actually be acted on. */
  function openBillingSettings() {
    closeCostPopover();
    if (onAction) void onAction('open_settings_billing');
  }

  function requestWorkspaceNewChat() {
    if (isGuidedDemo) return;
    window.dispatchEvent(new CustomEvent('kory:workspace-new-chat'));
  }

  function toggleWorkspace() {
    const root = projectStore.workspaceRoot;
    if (!root) return;
    collapsedWorkspaceRoot = collapsedWorkspaceRoot === root ? null : root;
  }

  function statusLabel(status: AgentStatus): string {
    const labels: Record<AgentStatus, string> = {
      idle: 'Idle',
      thinking: 'Thinking',
      analyzing: 'Analyzing',
      tool_calling: 'Terminal running',
      streaming: 'Responding',
      verifying: 'Verifying',
      compacting: 'Compacting context',
      waiting_user: 'Waiting for you',
      waiting: 'Waiting',
      error: 'Failed',
      done: 'Completed',
      reading: 'Reading files',
      writing: 'Writing files',
      searching: 'Searching',
      criticizing: 'Reviewing',
    };
    return labels[status];
  }

  // The per-chat goal chip is a redirect: it opens the chat and hands the goal
  // to the Goal Mode bubble above the composer, which is where all goal detail
  // is shown.
  function openSessionGoal(sessionId: string, goalId: string) {
    void selectSession(sessionId);
    goalStore.selectedGoalId = goalId;
    queueMicrotask(() =>
      window.dispatchEvent(new CustomEvent('kory:goal-action', { detail: 'goal_open' })),
    );
  }

  $effect(() => {
    if (sessionStore.activeSessionId && sessionStore.activeSessionId !== currentSessionId) {
      currentSessionId = sessionStore.activeSessionId;
    }
  });

  $effect(() => {
    const path = projectStore.currentPath;
    void path;
    untrack(() => {
      if (!path) return;
      const active = sessionStore.sessions.find((s) => s.id === sessionStore.activeSessionId);
      if (!active || active.workingDirectory !== path) {
        const forProject = sessionStore.sessionsForProject(path);
        if (forProject.length > 0) {
          const latest = forProject.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
          if (latest.id !== sessionStore.activeSessionId) sessionStore.activeSessionId = latest.id;
        }
      }
    });
  });

  function handleLauncherToggle() {
    if (isGuidedDemo) {
      toastStore.info(
        'Sample sessions are read-only in the demo. Run the app to create a workspace.',
      );
      return;
    }
    deviceStore.openCreator();
  }

  async function handleCreateProjectSession(event: MouseEvent, workingDirectory: string) {
    event.stopPropagation();
    if (isGuidedDemo) {
      toastStore.info(
        'Sample sessions are read-only in the demo. Run the app to create a workspace.',
      );
      return;
    }
    const targetPath = workingDirectory || projectStore.workspaceRoot || '';
    if (!targetPath) return;
    if (isNewChatBlockedForFolder(targetPath) || creatingProjectPath === targetPath) return;
    creatingProjectPath = targetPath;
    try {
      const id = await sessionStore.createSession({
        workingDirectory: targetPath,
      });
      if (id) window.dispatchEvent(new CustomEvent('kory:focus-input'));
    } finally {
      if (creatingProjectPath === targetPath) creatingProjectPath = null;
    }
  }

  async function loadHistory(id: string) {
    const messages = await sessionStore.fetchMessages(id);
    wsStore.loadSessionMessages(id, messages);
  }

  async function selectSession(id: string) {
    deviceStore.closeChat();
    collaborationStore.closeJoinedSession();
    if (sessionStore.activeSessionId === id) return;
    sessionStore.activeSessionId = id;
    // Note: loadHistory is now handled globally in +page.svelte based on activeSessionId changes
  }

  function startRename(id: string, currentTitle: string) {
    if (isGuidedDemo) return;
    editingId = id;
    editTitle = currentTitle;
  }

  function saveRename(id: string) {
    if (editTitle.trim()) {
      sessionStore.renameSession(id, editTitle.trim());
      editError = false;
    } else {
      editError = true;
      return;
    }
    editingId = '';
  }

  function cancelRename() {
    editingId = '';
    editTitle = '';
    editError = false;
  }

  function confirmDelete(e: MouseEvent, id: string) {
    e.stopPropagation();
    if (isGuidedDemo) {
      toastStore.info('Sample sessions are protected in the demo.');
      return;
    }
    // Deleting a row that's mid-rename must not leave the editor open.
    if (editingId === id) cancelRename();

    // Shift-click is the power-user escape hatch: an explicit modifier is a
    // deliberate "delete this now", so it skips the warning entirely.
    if (e.shiftKey) {
      sessionStore.deleteSession(id);
      return;
    }

    // ONE confirmation model for every lifecycle action: the same warning
    // screen, verb-swapped, that explains the session's agent tree is stopped.
    //
    // Deleting has no recovery path in the app, so the plain click always
    // asks: there is no "Don't show again" opt-out for it (see the dialog
    // below). A single stray click used to erase a whole transcript, which is
    // not a trade a chat list should make.
    openLifecycleWarning('delete', id);
  }

  /** Pin or unpin a chat, offering an Undo that restores the previous state. */
  function toggleChatPin(id: string) {
    const wasPinned = chatSidebarPrefs.isPinned(id);
    chatSidebarPrefs.togglePin(id);
    toastStore.success(wasPinned ? 'Chat unpinned' : 'Chat pinned', {
      duration: 6000,
      action: () => {
        chatSidebarPrefs.setPinned(id, wasPinned);
      },
      actionLabel: 'Undo',
    });
  }

  async function handleArchive(e: MouseEvent, id: string) {
    e.stopPropagation();
    if (isGuidedDemo) {
      toastStore.info('Sample sessions are protected in the demo.');
      return;
    }
    if (archivingId) return;
    if (editingId === id) cancelRename();

    if (isSessionActionWarningSuppressed('archive')) {
      await performArchive(id);
      return;
    }

    openLifecycleWarning('archive', id);
  }

  function openLifecycleWarning(action: SessionLifecycleAction, id: string) {
    // Each warning starts unsuppressed: "Don't show again" is a fresh decision
    // every time the screen is shown.
    suppressLifecycleWarning = false;
    pendingLifecycle = { action, id };
  }

  async function performArchive(id: string) {
    archivingId = id;
    try {
      await sessionStore.archiveSession(id);
    } finally {
      archivingId = '';
    }
  }

  async function handleConfirmLifecycle() {
    const pending = pendingLifecycle;
    const suppress = suppressLifecycleWarning;
    pendingLifecycle = null;
    suppressLifecycleWarning = false;
    if (!pending) return;

    // Only a confirmed warning counts as accepting it. Cancelling out must not
    // suppress the screen for next time.
    // Only archiving is reversible enough to stop asking about it.
    if (suppress && pending.action === 'archive') {
      suppressSessionActionWarning(pending.action);
    }

    if (pending.action === 'archive') await performArchive(pending.id);
    else sessionStore.deleteSession(pending.id);
  }

  function handleCancelLifecycle() {
    pendingLifecycle = null;
    suppressLifecycleWarning = false;
  }


</script>

<!-- The launcher is a role="menu" with no other dismiss affordance than the
     toggle button, so it has to answer Escape. Deliberately not a document
     click handler: the sidebar is mounted twice (mobile overlay + desktop
     nav), and a shared window-level click would let one instance's handler
     immediately close the menu another instance had just opened. -->
<svelte:window
  onkeydown={(event) => {
    if (launcherOpen && event.key === 'Escape') launcherOpen = false;
  }}
/>

<div class="h-full flex flex-col" style="background: var(--color-surface-1);">
  <!-- relative on the toolbar (not on the "+" button) so the launcher menu is
       measured against the sidebar, not a 32px button pinned 12px from its
       right edge. -->
  <div
    class="sidebar-toolbar relative flex items-center gap-2 border-b px-3"
    style="height: var(--header-height); border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <div class="relative min-w-0 flex-1">
      <Search
        size={13}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        style="color: var(--color-text-muted);"
      />
      <input
        type="text"
        placeholder="Find a chat or folder"
        aria-label="Search chats and folders"
        class="sidebar-search h-8 w-full rounded-lg border-0 bg-[var(--color-surface-2)] pl-8 pr-2 text-xs outline-none transition-colors"
        style="color: var(--color-text-primary);"
        bind:value={sessionStore.searchQuery}
      />
    </div>
    <div class="relative shrink-0">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg border-0 transition-colors hover:bg-[var(--color-surface-3)]"
        style="color: var(--color-accent);"
        disabled={isGuidedDemo}
        onclick={handleLauncherToggle}
        title={isGuidedDemo ? 'Sample sessions are read-only in the guided demo' : 'Create or open'}
        aria-label="Create or open"
        aria-haspopup="dialog"
      >
        <Plus size={16} />
      </button>
    </div>
    {#if launcherOpen}
      <div
        class="launcher-menu absolute z-[90] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-1.5 shadow-2xl"
        role="menu"
        aria-label="Create or open"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
          disabled={isGuidedDemo}
          onclick={() => {
            launcherOpen = false;
            deviceStore.openCreator();
          }}
          role="menuitem"
        >
          <MessageSquare size={14} /> New Chat
        </button>

        {#if projectStore.workspaceRoot || recentProjects.length > 0}
          <div class="my-1 border-t border-[var(--color-border)]"></div>
          <div
            class="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
          >
            Recent
          </div>
          {#if projectStore.workspaceRoot}
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
              onclick={() =>
                runLauncherAction(
                  `select_project:${encodeURIComponent(projectStore.workspaceRoot ?? '')}`,
                )}
              role="menuitem"
              title={projectStore.workspaceRoot}
            >
              <FolderOpen size={13} class="shrink-0" />
              <span class="truncate">{projectDisplayName(projectStore.workspaceRoot)}</span>
              <span class="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)]"
                >workspace</span
              >
            </button>
          {/if}
          {#each recentProjects.slice(0, 5) as project (project.id)}
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
              onclick={() => runLauncherAction(`open_recent:${project.id}`)}
              role="menuitem"
              title={project.path || project.fileName || project.title}
            >
              <FolderOpen size={13} class="shrink-0" />
              <span class="truncate">{project.title}</span>
            </button>
          {/each}
        {/if}

        <div class="my-1 border-t border-[var(--color-border)]"></div>
        <!-- One column, not two: the menu is only as wide as the sidebar
             (220-272px), so a two-column grid squeezes "Open Workspace" past
             its own left edge. -->
        <div class="flex flex-col gap-0.5">
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => runLauncherAction('open_project_folder')}
            role="menuitem">Open Project</button
          >
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => runLauncherAction('new_project')}
            role="menuitem">New Project</button
          >
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => runLauncherAction('open_workspace')}
            role="menuitem">Open Workspace</button
          >
          <button
            type="button"
            class="rounded-lg px-3 py-2 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => runLauncherAction('new_workspace')}
            role="menuitem">New Workspace</button
          >
        </div>
      </div>
    {/if}
  </div>

  <!-- overflow-x-hidden is load-bearing: with only overflow-y-auto the browser
       computes overflow-x to auto as well, so the tree becomes a horizontal
       scroll container. The hover overlays below overflow its right edge even
       at opacity 0, which leaves a scroll range, and any scroll offset shears
       the leading glyphs of every row off the left edge of the window, where
       the overflow:hidden ancestors make them unreachable. -->
  <div class="session-tree flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3 pt-2">

  {#snippet sessionRow(session: Session, projectPath?: string)}
                  {@const managerStatus = wsStore.getManagerStatusForSession(session.id)}
                  <!-- A chat the user stopped shows the plain chat glyph, never the
                       done checkmark — stopping is not completing. -->
                  {@const indicatorStatus = isSessionStopped(session.id) ? 'idle' : managerStatus}
                  {@const sessionGoals = goalsForSession(session.id)}
                  {@const primaryGoal = sessionGoals[0]}
                  {@const needsApproval = wsStore.pendingPermissions.some(
                    (permission) => permission.sessionId === session.id,
                  )}
                  <div
                    class="session-item session-row group relative mx-0.5 flex min-h-12 items-center gap-2 rounded-lg border border-transparent px-1.5 py-1.5 transition-colors"
                    class:active-session={sessionStore.activeSessionId === session.id &&
                      !collaborationStore.activeJoinedSession}
                    draggable={projectPath !== undefined}
                    ondragstart={(event) =>
                      projectPath && onChatDragStart(event, projectPath, session.id)}
                    ondragover={(event) => onChatDragOver(event, session.id)}
                    ondrop={(event) =>
                      projectPath && onChatDrop(event, projectPath, session.id)}
                    ondragend={onChatDragEnd}
                    class:drag-over={dragOverChatId === session.id}
                    class:dragging={draggedChat?.sessionId === session.id}
                    role="treeitem"
                    oncontextmenu={(event) => openChatActionsContextMenu(event, session)}
                  >
                    {#if editingId === session.id}
                      <div class="relative z-[2] flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex items-center gap-1">
                          <input
                            type="text"
                            class="input h-7 min-w-0 flex-1 text-xs {editError
                              ? 'border-[var(--color-error)]'
                              : ''}"
                            bind:value={editTitle}
                            maxlength={80}
                            oninput={() => {
                              if (editTitle.trim()) editError = false;
                            }}
                            onclick={(event) => event.stopPropagation()}
                            ondblclick={(event) => event.stopPropagation()}
                            onkeydown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') saveRename(session.id);
                              if (event.key === 'Escape') cancelRename();
                            }}
                          />
                          <button
                            type="button"
                            class="rounded p-1"
                            style="color: var(--color-success);"
                            onclick={(event) => {
                              event.stopPropagation();
                              saveRename(session.id);
                            }}
                            aria-label="Save rename"
                          >
                            <Check size={12} />
                          </button>
                          <button
                            type="button"
                            class="rounded p-1"
                            style="color: var(--color-text-muted);"
                            onclick={(event) => {
                              event.stopPropagation();
                              cancelRename();
                            }}
                            aria-label="Cancel rename"
                          >
                            <X size={12} />
                          </button>
                        </div>
                        <span
                          class="px-0.5 text-[11px]"
                          style="color: {editError
                            ? 'var(--color-error)'
                            : 'var(--color-text-muted)'};"
                        >
                          {editError ? 'Name cannot be empty' : `${editTitle.length}/80`}
                        </span>
                      </div>
                    {:else}
                      <button
                        type="button"
                        class="absolute inset-0 z-0 rounded-lg bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/70"
                        aria-label={sessionStore.activeSessionId === session.id &&
                        !collaborationStore.activeJoinedSession
                          ? isNamingSession(session)
                            ? 'Naming new chat, currently open'
                            : `Open session ${session.title}, currently open`
                          : isNamingSession(session)
                            ? 'Naming new chat'
                            : `Open session ${session.title}`}
                        aria-current={sessionStore.activeSessionId === session.id &&
                        !collaborationStore.activeJoinedSession
                          ? 'page'
                          : undefined}
                        onclick={() => selectSession(session.id)}
                        oncontextmenu={(event) => openChatActionsContextMenu(event, session)}
                        onkeydown={(event) => openChatActionsMenuFromKeyboard(event, session)}
                        ondblclick={() => !isGuidedDemo && startRename(session.id, session.title)}
                      ></button>

                      <div
                        class="status-cell pointer-events-none relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                        class:is-running={indicatorStatus !== 'idle'}
                        title={indicatorStatus !== 'idle'
                          ? indicatorStatus === 'waiting' &&
                            runStateStore.getWaitingReason(session.id)
                            ? runStateStore.getWaitingReason(session.id)
                            : statusLabel(indicatorStatus)
                          : primaryGoal
                            ? 'Assigned to an active goal'
                            : 'Chat is idle'}
                      >
                        {#if indicatorStatus === 'tool_calling' && feedStore.latestToolEntryForSession(session.id)}
                          <!-- Same glyph the transcript shows for this tool call -->
                          <ToolActivityIcon entry={feedStore.latestToolEntryForSession(session.id)!} size={15} />
                        {:else if indicatorStatus !== 'idle'}
                          <AnimatedStatusIcon
                            status={indicatorStatus}
                            size={15}
                            isManager={true}
                            phase={sessionStore.activeSessionId === session.id
                              ? wsStore.koryPhase
                              : ''}
                          />
                        {:else if primaryGoal}
                          <Target size={12} style="color: var(--color-accent);" />
                        {:else}
                          <MessageSquare size={12} style="color: var(--color-text-muted);" />
                        {/if}
                      </div>

                      <div class="session-copy pointer-events-none relative z-[1] min-w-0 flex-1">
                        <div class="flex min-w-0 items-center gap-1.5">
                          {#if isNamingSession(session)}
                            <span
                              class="h-3 w-24 animate-pulse rounded bg-[var(--color-surface-3)]"
                              role="status"
                              aria-label="Naming chat"
                            ></span>
                          {:else}
                            <span
                              class="min-w-0 flex-1 truncate text-xs font-medium"
                              style="color: var(--color-text-primary);"
                            >
                              {session.title}
                            </span>
                          {/if}
                          {#if needsApproval && sessionStore.activeSessionId !== session.id}
                            <span
                              class="approval-badge inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold"
                              title="An agent in this chat is waiting for your approval"
                            >
                              <ShieldAlert size={9} />Approve
                            </span>
                          {/if}
                        </div>
                        <!-- Meta row packs price, message count and timestamp into a
                             single tight left-aligned group so no width is wasted. -->
                        <div
                          class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px]"
                          style="color: var(--color-text-muted);"
                        >
                          {#if sessionCostLabel(session)}
                            <button
                              type="button"
                              class="pointer-events-auto relative z-20 shrink-0 rounded px-0.5 font-mono underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-secondary)]"
                              style="font-size: var(--text-xs); color: var(--color-text-muted);"
                              onmouseenter={(event) =>
                                openCostPopover(session.id, event.currentTarget as HTMLElement)}
                              onmouseleave={scheduleCostPopoverClose}
                              onclick={(event) => {
                                event.stopPropagation();
                                openBillingSettings();
                              }}
                              aria-label={`Billing detail for ${session.title}`}
                            >
                              {sessionCostLabel(session)}
                            </button>
                            {#if hoveredCostSessionId === session.id}
                              <!-- Viewport-anchored because the sidebar is a scroll
                               container, and portalled to <body> so it paints above
                               every other surface instead of inside the row's
                               stacking context. -->
                              <button
                                type="button"
                                use:portalToBody
                                class="cost-billing-popover fixed w-72 cursor-pointer rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left shadow-2xl"
                                onmouseenter={keepCostPopoverOpen}
                                onmouseleave={scheduleCostPopoverClose}
                                onclick={(event) => {
                                  event.stopPropagation();
                                  openBillingSettings();
                                }}
                                style="left: {costPopoverAnchor?.left ??
                                  0}px; top: {costPopoverAnchor?.top ?? 0}px;"
                              >
                                {#if sessionBilling[session.id] === undefined}
                                  <div class="text-[11px] text-[var(--color-text-muted)]">
                                    {sessionBillingLoaded
                                      ? 'No tracked spend yet'
                                      : 'Loading billing detail…'}
                                  </div>
                                {:else}
                                  {@const detail = sessionBilling[session.id]}
                                  <div class="mb-2 flex items-start justify-between gap-3">
                                    <div>
                                      <div
                                        class="text-[11px] font-semibold text-[var(--color-text-primary)]"
                                      >
                                        Tracked spend
                                      </div>
                                      {#if detail?.pricingIncomplete}<div
                                          class="text-[11px] text-[var(--color-warning)]"
                                        >
                                          Pricing incomplete
                                        </div>{/if}
                                    </div>
                                    <div
                                      class="font-mono text-[11px] font-bold text-[var(--color-text-primary)]"
                                    >
                                      {billingSummaryLabel(detail)}
                                    </div>
                                  </div>
                                  <div class="space-y-2">
                                    {#each detail?.providers ?? [] as provider (provider.name)}
                                      <div>
                                        <div
                                          class="flex items-center justify-between gap-2 text-[11px]"
                                        >
                                          <span
                                            class="font-semibold text-[var(--color-text-secondary)]"
                                            >{provider.name}</span
                                          >
                                          <span class="font-mono text-[var(--color-text-primary)]">
                                            {provider.subscription
                                              ? showSubscriptionApiEquivalent &&
                                                provider.apiEquivalentUsd != null
                                                ? `API eq ${formatUsd(provider.apiEquivalentUsd)}`
                                                : 'Subscription'
                                              : provider.hasKnownCost
                                                ? formatUsd(provider.spendUsd ?? 0)
                                                : USD_UNKNOWN}
                                          </span>
                                        </div>
                                        {#each provider.models ?? [] as model (model.model)}
                                          <div
                                            class="ml-2 flex items-center justify-between gap-2 py-0.5 text-[11px] text-[var(--color-text-muted)]"
                                          >
                                            <span class="min-w-0 truncate font-mono"
                                              >{model.model}</span
                                            >
                                            <span class="shrink-0 font-mono">
                                              {model.subscription
                                                ? showSubscriptionApiEquivalent &&
                                                  model.apiEquivalentUsd != null
                                                  ? `API eq ${formatUsd(model.apiEquivalentUsd)}`
                                                  : 'subscription'
                                                : model.hasKnownCost
                                                  ? formatUsd(model.spendUsd ?? 0)
                                                  : USD_UNKNOWN}
                                            </span>
                                          </div>
                                        {/each}
                                      </div>
                                    {/each}
                                  </div>
                                {/if}
                                <div
                                  class="mt-2 flex items-center justify-between gap-2 border-t pt-1.5 text-[11px]"
                                  style="color: var(--color-text-muted); border-color: var(--color-border);"
                                >
                                  <span>Click to open billing</span>
                                  <ChevronRight size={10} />
                                </div>
                              </button>
                            {/if}
                          {/if}
                          {#if primaryGoal}
                            <button
                              type="button"
                              class="pointer-events-auto relative z-10 inline-flex min-w-0 shrink-0 items-center gap-1 truncate rounded px-1 py-0.5 font-semibold"
                              style="color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 12%, transparent);"
                              title={sessionGoals.map((goal) => goal.objective).join('\n')}
                              aria-label={`${sessionGoals.length > 1 ? `${sessionGoals.length} goals assigned to this chat` : `Goal ${primaryGoal.status}: ${primaryGoal.objective}`}. Active time ${formatGoalRuntime(primaryGoal, goalClock)}`}
                              onclick={(event) => {
                                event.stopPropagation();
                                openSessionGoal(session.id, primaryGoal.id);
                              }}
                            >
                              <Target size={8} class="shrink-0" />
                              <span class="truncate">
                                {sessionGoals.length > 1
                                  ? `${sessionGoals.length} goals`
                                  : primaryGoal.status === 'blocked'
                                    ? 'blocked'
                                    : primaryGoal.status === 'paused'
                                      ? 'paused'
                                      : `${goalProgress(primaryGoal)}%`}
                              </span>
                            </button>
                          {/if}
                          <span class="min-w-0 shrink-0 truncate">{session.messageCount} msgs</span>
                        </div>
                      </div>

                      {#if !isGuidedDemo}
                        <div
                          class="session-actions pointer-events-auto absolute right-1 z-10 flex items-center gap-0.5 rounded-md p-0.5"
                        >
                          <span class="session-action-wrap">
                            <button
                              type="button"
                              class="session-action"
                              onclick={(event) => openChatActionsMenu(event, session)}
                              ondblclick={(event) => event.stopPropagation()}
                              aria-label={`Chat actions for ${session.title}`}
                              aria-haspopup="menu"
                              aria-expanded={chatActionsMenu?.sessionId === session.id}
                              aria-controls={chatActionsMenu?.sessionId === session.id
                                ? chatActionsMenu.id
                                : undefined}
                              title="Chat actions"
                              oncontextmenu={(event) => openChatActionsContextMenu(event, session)}
                              onkeydown={(event) => openChatActionsMenuFromKeyboard(event, session)}
                            >
                              <MoreHorizontal size={12} />
                            </button>
                          </span>
                          <span class="session-action-wrap">
                            <button
                              type="button"
                              class="session-action {chatSidebarPrefs.isPinned(session.id)
                                ? 'session-action-pin-active'
                                : ''}"
                              title={chatSidebarPrefs.isPinned(session.id) ? 'Unpin chat' : 'Pin chat'}
                              aria-label={chatSidebarPrefs.isPinned(session.id) ? 'Unpin chat' : 'Pin chat'}
                              onclick={(event) => {
                                event.stopPropagation();
                                toggleChatPin(session.id);
                              }}
                            >
                              <Pin size={11} />
                            </button>
                          </span>
                        </div>
                      {/if}
                    {/if}
                  </div>
                {/snippet}

  {#if pinnedChats.length > 0}
    <div class="mb-3">
      <div class="mb-1 flex items-center gap-2 px-2.5 py-1.5">
        <span
          class="text-[10px] font-semibold uppercase tracking-[0.14em]"
          style="color: var(--color-text-muted);"
        >
          Pinned chats
        </span>
      </div>
      {#each pinnedChats as session (session.id)}
        {@render sessionRow(session)}
      {/each}
    </div>
  {/if}

    {#if showTeamSidebarShortcut}
      <button
        type="button"
        onclick={() => {
          window.dispatchEvent(new CustomEvent('open-team-settings'));
        }}
        class="mx-1 mb-2 flex items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
        style="width:calc(100% - 0.5rem);border-color:var(--color-border);color:var(--color-text-secondary)"
        ><span
          class="flex h-[22px] w-[22px] items-center justify-center rounded-lg"
          style="background:var(--color-surface-3);color:var(--color-accent)"
          ><UserPlus size={12} /></span
        ><span class="text-xs font-medium">Join or host a team workspace</span></button
      >
    {/if}
    {#if deviceStore.chats.length}
      <div class="mb-3 px-2">
        <p
          class="flex items-center gap-2 px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
        >
          <Monitor size={13} /> Micah’s agents
        </p>
        {#each deviceStore.chats as chat (`${chat.deviceId}:${chat.id}`)}
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--color-surface-3)]"
            style:background={deviceStore.activeChat?.id === chat.id &&
            deviceStore.activeChat?.deviceId === chat.deviceId
              ? 'var(--color-surface-3)'
              : undefined}
            onclick={() => {
              collaborationStore.closeJoinedSession();
              void deviceStore.openChat(chat);
            }}
            ><Monitor size={14} class="shrink-0 text-[var(--color-text-muted)]" /><span
              class="min-w-0"
              ><span class="block truncate text-xs text-[var(--color-text-primary)]"
                >{chat.title}</span
              ><span class="block truncate text-[11px] text-[var(--color-text-muted)]"
                >{chat.deviceName} · {chat.workspaceName}</span
              ></span
            ></button
          >
        {/each}
      </div>
    {/if}
    {#if collaborationStore.joinedSessions.length > 0}
      <div class="mb-3">
        <div class="flex items-center justify-between px-3 py-2">
          <span
            class="text-xs font-semibold uppercase tracking-[0.14em]"
            style="color:var(--color-text-muted)">Team workspaces</span
          ><span
            class="rounded-full px-2 py-0.5 text-[11px]"
            style="background:var(--color-surface-3);color:var(--color-text-muted)"
            >{collaborationStore.joinedSessions.length}</span
          >
        </div>
        <JoinedTeamTree />
      </div>
      <div class="mx-3 mb-3 border-t" style="border-color:var(--color-border)"></div>
    {/if}
    <div class="mb-1 flex items-center justify-between gap-2 px-2.5 py-1.5">
      <span
        class="text-[10px] font-semibold uppercase tracking-[0.14em]"
        style="color: var(--color-text-muted);"
      >
        {projectStore.workspaceRoot ? 'Workspace' : 'Projects'}
      </span>
    </div>

    {#if projectStore.workspaceRoot}
      {@const workspaceExpanded = isWorkspaceExpanded()}
      <div class="workspace-header-row mb-1 flex items-center gap-0.5">
        <button
          type="button"
          class="workspace-row flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)]"
          aria-label={`${workspaceExpanded ? 'Collapse' : 'Expand'} workspace ${projectDisplayName(projectStore.workspaceRoot)}. ${workspaceProjectCount} ${workspaceProjectCount === 1 ? 'project' : 'projects'}, ${workspaceRootChatCount} ${workspaceRootChatCount === 1 ? 'chat' : 'chats'}`}
          aria-expanded={workspaceExpanded}
          aria-controls="workspace-project-tree"
          onclick={toggleWorkspace}
          oncontextmenu={(event) =>
            openWorkspaceIconContextMenu(event, event.currentTarget as HTMLElement)}
          onkeydown={(event) => openWorkspaceIconContextMenuFromKeyboard(event)}
          title={projectStore.workspaceRoot}
        >
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center"
            style="color: var(--color-text-muted);"
          >
            {#if workspaceExpanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
          </span>
           <span class="workspace-folder-icon flex h-5 w-5 shrink-0 items-center justify-center">
             <FolderOpen size={15} />
           </span>
          <span
            class="min-w-0 flex-1 truncate text-xs font-semibold"
            style="color: var(--color-text-primary);"
          >
            {projectDisplayName(projectStore.workspaceRoot)}
          </span>
          <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);">
            {workspaceProjectCount}
          </span>
        </button>
        <button
          type="button"
          class="workspace-new-chat flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)]"
          style="color: var(--color-text-muted);"
          disabled={isGuidedDemo || isNewChatBlockedForFolder(projectStore.workspaceRoot ?? '')}
          onclick={requestWorkspaceNewChat}
          aria-label={`New chat in workspace ${projectDisplayName(projectStore.workspaceRoot)}`}
          title={isGuidedDemo
            ? 'Sample sessions are read-only in the guided demo'
            : isNewChatBlockedForFolder(projectStore.workspaceRoot ?? '')
              ? 'Finish naming this chat before starting another in this folder'
              : `New chat in workspace ${projectDisplayName(projectStore.workspaceRoot)}`}
        >
          <SquarePen size={12} />
        </button>
      </div>
    {/if}

    {#if !projectStore.workspaceRoot || isWorkspaceExpanded()}
      <div
        id={projectStore.workspaceRoot ? 'workspace-project-tree' : undefined}
        class:workspace-children={Boolean(projectStore.workspaceRoot)}
      >
        {#each projectGroups as project (project.key)}
          {@const expanded = isProjectGroupExpanded(project.key)}
          {@const statusTotal = project.statusSlices.reduce((sum, slice) => sum + slice.count, 0)}
          <!-- Workspace-root chats hang off the workspace node itself, so they get a
           plain labelled group rather than a nested "Workspace root" folder. -->
          <section
            class="project-group mb-1"
            role={project.isWorkspaceRoot ? 'group' : undefined}
            aria-label={project.isWorkspaceRoot ? 'workspace chats' : `${project.label} chats`}
          >
            {#if !project.isWorkspaceRoot}
              <div class="project-header flex items-center gap-0.5">
                <button
                  type="button"
                  class="project-row flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
                  class:is-current-project={project.path === projectStore.currentPath}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.label}. ${projectStatusText(project)}`}
                  aria-expanded={expanded}
                  aria-controls={`project-chats-${project.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                  onclick={() => toggleProjectGroup(project.key)}
                  draggable={true}
                  ondragstart={(event) => onProjectDragStart(event, project.path)}
                  ondragover={(event) => onProjectDragOver(event, project.path)}
                  ondrop={(event) => onProjectDrop(event, project.path)}
                  ondragend={onProjectDragEnd}
                  class:drag-over={dragOverProjectPath === project.path}
                  class:dragging={draggedProjectPath === project.path}
                  oncontextmenu={(event) =>
                    openProjectIconContextMenu(event, project, event.currentTarget as HTMLElement)}
                  onkeydown={(event) => openProjectIconContextMenuFromKeyboard(event, project)}
                >
                  <span
                    class="flex h-4 w-4 shrink-0 items-center justify-center"
                    style="color: var(--color-text-muted);"
                  >
                    {#if expanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
                  </span>
                  {#if project.projectIdentity}
                     <ProjectIcon
                       identity={project.projectIdentity.identity}
                       icon={project.projectIdentity.identity.icon}
                       size={20}
                       oncontextmenu={(event) =>
                         openProjectIconContextMenu(event, project, event.currentTarget as HTMLElement)}
                     />
                  {:else}
                    <span
                      class="project-folder-icon flex h-4 w-4 shrink-0 items-center justify-center"
                    >
                      <FolderOpen size={14} />
                    </span>
                  {/if}
                  <span
                    class="min-w-0 flex-1 truncate text-xs font-semibold"
                    style="color: var(--color-text-primary);"
                  >
                    {project.label}
                  </span>
                    {#if statusTotal > 0}
                    <span
                      class="project-status-indicator relative inline-flex shrink-0 items-center justify-center"
                      aria-label={project.statusSlices
                        .map((slice) => `${slice.count} ${slice.label.toLowerCase()}`)
                        .join(', ')}
                      onmouseenter={(event) => openStatusPopover(project.key, event.currentTarget as HTMLElement)}
                      onmouseleave={closeStatusPopover}
                    >
                      <span
                        class="status-orb"
                        aria-label={`Show ${project.label} chat activity`}
                        onclick={(event) => {
                          event.stopPropagation();
                          statusDetailProjectKey = project.key;
                        }}
                        onkeydown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            statusDetailProjectKey = project.key;
                          }
                        }}
                        role="button"
                        tabindex="0"
                      >
                        <svg viewBox="0 0 32 32">
                          {#each statusPieWedges(project.statusSlices) as wedge (wedge.color)}
                            <path
                              d={wedge.d}
                              fill={wedge.color}
                              stroke={wedge.color}
                              stroke-width="0.6"
                            />
                          {/each}
                          {#if project.statusSlices.length === 0}
                            <circle cx="16" cy="16" r="16" fill="var(--color-surface-4)" />
                          {/if}
                        </svg>
                      </span>
                      {#if hoveredStatusProjectKey === project.key && statusPopoverAnchor}
                        <span
                          class="status-popover"
                          role="tooltip"
                          use:portalToBody
                          style="position: fixed; left: {statusPopoverAnchor.left}px; top: {statusPopoverAnchor.top}px; transform: translate(-50%, 0); z-index: 9999; opacity: 1;"
                        >
                          <span class="status-popover-heading">
                            <span class="status-pie" aria-hidden="true">
                              <svg viewBox="0 0 32 32">
                                {#each statusPieWedges(project.statusSlices) as wedge (wedge.color)}
                                  <path
                                    d={wedge.d}
                                    fill={wedge.color}
                                    stroke={wedge.color}
                                    stroke-width="0.6"
                                  />
                                {/each}
                                {#if project.statusSlices.length === 0}
                                  <circle cx="16" cy="16" r="16" fill="var(--color-surface-4)" />
                                {/if}
                              </svg>
                            </span>
                            <span>
                              <strong>{statusTotal}</strong>
                              <small>{statusTotal === 1 ? 'chat tracked' : 'chats tracked'}</small>
                            </span>
                          </span>
                          <span class="status-legend">
                            {#each project.statusSlices as slice (slice.key)}
                              <span class="status-legend-row">
                                <span class="status-swatch" style:background={slice.color}></span>
                                <span class="status-legend-label">{slice.label}</span>
                                <strong>{slice.count}</strong>
                                <small>{Math.round((slice.count / statusTotal) * 100)}%</small>
                              </span>
                            {/each}
                          </span>
                        </span>
                      {/if}
                    </span>
                    {/if}
                  </button>
                  {#if project.projectIdentity}
                    <button
                      type="button"
                      class="project-icon-actions flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
                      aria-label={`Project actions for ${project.label}`}
                      aria-haspopup="menu"
                      aria-expanded={projectIconContextMenu?.projectPath === project.path}
                      aria-controls={projectIconContextMenu?.projectPath === project.path
                        ? projectIconContextMenu.id
                        : undefined}
                      title="Project actions"
                      onclick={(event) => {
                        event.stopPropagation();
                        const trigger = event.currentTarget as HTMLElement;
                        const rect = trigger.getBoundingClientRect();
                        projectIconContextMenu = {
                          id: projectIconMenuId(project.path),
                          projectName: project.label,
                          projectPath: project.path,
                          x: rect.left,
                          y: rect.bottom + 4,
                          returnFocus: trigger,
                        };
                      }}
                      oncontextmenu={(event) =>
                        openProjectIconContextMenu(event, project, event.currentTarget as HTMLElement)}
                      onkeydown={(event) => openProjectIconContextMenuFromKeyboard(event, project)}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    <button
                      type="button"
                      class="project-new-chat flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
                      disabled={isNewChatBlockedForFolder(project.path)}
                      title={isNewChatBlockedForFolder(project.path)
                        ? 'Finish naming this chat before starting another in this folder'
                        : `New chat in ${project.label}`}
                      aria-label="New chat"
                      onclick={(event) => {
                        event.stopPropagation();
                        void onAction?.(`new_project_chat:${encodeURIComponent(project.path)}`);
                      }}
                    >
                      <SquarePen size={14} />
                    </button>
                  {/if}
                </div>
            {/if}

            {#if project.isWorkspaceRoot || expanded}
              <div
                id={`project-chats-${project.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                class="project-children"
              >
                
                {#each project.sessions.filter((s) => !chatSidebarPrefs.isPinned(s.id)) as session (session.id)}
                  {@render sessionRow(session, project.path)}
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}

    {#if sidebarSessions.length === 0}
      <div
        class="flex flex-col items-center justify-center"
        style="padding-top: var(--space-8); padding-bottom: var(--space-8); color: var(--color-text-muted);"
      >
        <MessageSquare size={24} class="opacity-40" style="margin-bottom: var(--space-sm);" />
        <p class="text-xs">
          {sessionStore.searchQuery ? 'No matching sessions' : 'No sessions yet'}
        </p>
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  open={pendingLifecycle !== null}
  title={pendingLifecycle ? sessionLifecycleTitle(pendingLifecycle.action) : ''}
  message={pendingLifecycle ? sessionLifecycleWarning(pendingLifecycle.action) : ''}
  confirmLabel={pendingLifecycle
    ? sessionLifecycleConfirmLabel(pendingLifecycle.action)
    : 'Confirm'}
  cancelLabel="Cancel"
  variant={pendingLifecycle?.action === 'delete' ? 'danger' : 'warning'}
  showSuppressOption={pendingLifecycle?.action === 'archive'}
  suppressLabel="Don't show again"
  bind:suppressChecked={suppressLifecycleWarning}
  onConfirm={handleConfirmLifecycle}
  onCancel={handleCancelLifecycle}
/>

{#if statusDetailProject}
  <div class="status-detail-backdrop" role="presentation" transition:fade={{ duration: 160 }}>
    <button
      type="button"
      class="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
      aria-label="Close status details"
      onclick={() => (statusDetailProjectKey = null)}
    ></button>
    <div
      class="status-detail-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="status-detail-title"
      transition:scale={{ duration: 240, start: 0.88 }}
    >
      <div class="status-detail-header">
        <div
          class="status-detail-chart"
          style:background={statusChartBackground(statusDetailProject.statusSlices)}
        >
          <span
            >{statusDetailProject.statusSlices.reduce((sum, slice) => sum + slice.count, 0)}</span
          >
        </div>
        <div class="min-w-0 flex-1">
          <h2 id="status-detail-title">{statusDetailProject.label} activity</h2>
          <p>Click any item to jump directly to the session that needs attention.</p>
        </div>
        <button
          type="button"
          class="status-detail-close"
          aria-label="Close status details"
          onclick={() => (statusDetailProjectKey = null)}>Close</button
        >
      </div>
      <div class="status-detail-summary">
        {#each statusDetailProject.statusSlices as slice (slice.key)}
          <div class="status-detail-stat">
            <span class="status-swatch" style:background={slice.color}></span><strong
              >{slice.count}</strong
            ><span>{slice.label}</span>
          </div>
        {/each}
      </div>
      <div class="status-detail-list">
        {#each statusDetailProject.sessions as session (session.id)}
          {@const managerStatus = wsStore.getManagerStatusForSession(session.id)}
          {@const workerStatuses = wsStore.getAgentStatusesForSession(session.id)}
          {@const cancelled = isSessionStopped(session.id)}
          {@const outcomeLabel = cancelled ? 'Cancelled' : statusLabel(managerStatus)}
          {@const outcomeColor = cancelled ? 'var(--color-text-muted)' : statusColor(managerStatus)}
          <button
            type="button"
            class="status-detail-row"
            onclick={() => {
              statusDetailProjectKey = null;
              sessionStore.activeSessionId = session.id;
            }}
          >
            <span class="status-detail-dot" style:background={outcomeColor}></span>
            <span class="min-w-0 flex-1"
              ><strong>{session.title}</strong><small
                >{workerStatuses.length
                  ? `${workerStatuses.length} worker${workerStatuses.length === 1 ? '' : 's'} · `
                  : ''}{outcomeLabel}</small
              ></span
            >
            <span class="status-detail-state" style:color={outcomeColor}>{outcomeLabel}</span>
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if chatActionsMenu}
  <ChatActionsMenu
    id={chatActionsMenu.id}
    chatTitle={chatActionsMenu.chatTitle}
    x={chatActionsMenu.x}
    y={chatActionsMenu.y}
    archiving={archivingId === chatActionsMenu.sessionId}
    returnFocus={chatActionsMenu.returnFocus}
    onaction={handleChatAction}
    onclose={() => (chatActionsMenu = null)}
  />
{/if}

{#if projectIconContextMenu}
  <ProjectIconContextMenu
    id={projectIconContextMenu.id}
    projectName={projectIconContextMenu.projectName}
    projectPath={projectIconContextMenu.projectPath}
    x={projectIconContextMenu.x}
    y={projectIconContextMenu.y}
    returnFocus={projectIconContextMenu.returnFocus}
    pinned={projectSidebarPrefs.isPinned(projectIconContextMenu.projectPath)}
    canRemove={!projectStore.workspaceRoot}
    newChatDisabled={isNewChatBlockedForFolder(projectIconContextMenu.projectPath)}
    onaction={handleProjectIconContextAction}
    onclose={closeProjectIconContextMenu}
  />
{/if}

{#if confirmDeleteChats}
  <ConfirmDialog
    open={confirmDeleteChats}
    title="Delete chats"
    message={`Permanently delete all ${deleteChatsCount} chat${deleteChatsCount === 1 ? '' : 's'} in "${deleteChatsProjectName}"? This cannot be undone.`}
    confirmLabel="Delete permanently"
    cancelLabel="Cancel"
    variant="danger"
    onConfirm={() => void deleteProjectChats(deleteChatsProjectPath)}
    onCancel={() => {
      confirmDeleteChats = false;
      deleteChatsProjectPath = '';
      deleteChatsProjectName = '';
      deleteChatsCount = 0;
    }}
  />
{/if}

{#if workspaceIconContextMenu}
  <WorkspaceIconContextMenu
    id={workspaceIconContextMenu.id}
    workspaceName={workspaceIconContextMenu.workspaceName}
    workspacePath={workspaceIconContextMenu.workspacePath}
    x={workspaceIconContextMenu.x}
    y={workspaceIconContextMenu.y}
    expanded={workspaceIconContextMenu.expanded}
    returnFocus={workspaceIconContextMenu.returnFocus}
    onaction={handleWorkspaceIconContextAction}
    onclose={closeWorkspaceIconContextMenu}
  />
{/if}

<style>
  .session-tree {
    position: relative;
    z-index: 0;
    isolation: isolate;
    contain: paint;
  }

  .sidebar-toolbar {
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-accent) 4%, transparent);
  }

  .sidebar-search {
    box-shadow: 0 2px 8px color-mix(in srgb, var(--color-surface-0) 16%, transparent);
  }

  .sidebar-search:hover {
    box-shadow: 0 2px 10px color-mix(in srgb, var(--color-accent) 12%, transparent);
  }

  .sidebar-search:focus {
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--color-accent) 12%, transparent),
      0 3px 12px color-mix(in srgb, var(--color-surface-0) 20%, transparent);
  }

  /* Tracked-price card. It is portalled to <body> (so no ancestor stacking
     context can trap it) and layered at the tooltip level, which sits above
     modals and drawers — this readout must never be hidden by another window.
     It is a button, so re-assert the pointer and text-align resets Tailwind's
     preflight applies to form controls. */
  .cost-billing-popover {
    z-index: var(--z-tooltip);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--color-text-primary);
  }

  .cost-billing-popover:hover {
    border-color: var(--color-border-bright);
  }

  .cost-billing-popover:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: 2px;
  }

  /* Sized to the sidebar, not to the "+" button. The button is 32px wide and
     sits 12px from the sidebar's right edge, while the sidebar itself is only
     --sidebar-min-width (220px) to --sidebar-width (272px) wide, so a fixed
     288px panel right-aligned to the button put its left column 28-80px off
     the left of the window, where the <nav>'s overflow:hidden clipped it and
     "Open Project" rendered as "pen Project". Sizing to the containing block
     makes overflow geometrically impossible at any sidebar width. */
  .launcher-menu {
    top: calc(100% + 6px);
    right: 8px;
    width: calc(100% - 16px);
    max-height: min(70vh, 520px);
  }

  .sidebar-search::placeholder {
    color: var(--color-text-muted);
  }

  .sidebar-search:hover {
    border-color: var(--color-border-bright);
  }

  .sidebar-search:focus {
    border-color: var(--color-border-bright);
    background: var(--color-surface-2);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 9%, transparent);
  }

  .project-row .project-folder-icon {
    color: var(--color-text-muted);
    transition: color var(--duration-fast) var(--ease-out);
  }

  .project-row:hover .project-folder-icon,
  .project-row.is-current-project .project-folder-icon {
    color: var(--color-accent);
  }

  .project-status-indicator {
    width: 14px;
    height: 14px;
  }

  .status-orb {
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: var(--radius-full);
    transition: transform var(--duration-fast) var(--ease-out);
  }

  .status-detail-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal, 70);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .status-detail-dialog {
    position: relative;
    z-index: 1;
    width: min(440px, 100%);
    max-height: min(680px, calc(100vh - 40px));
    overflow: hidden;
    border: 1px solid var(--color-border-bright);
    border-radius: 18px;
    padding: 20px;
    background: var(--color-surface-1);
    box-shadow: 0 24px 70px color-mix(in srgb, var(--color-surface-0) 78%, transparent);
  }
  .status-detail-header {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .status-detail-chart {
    display: flex;
    width: 58px;
    height: 58px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    animation: status-chart-in 340ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .status-detail-chart::before {
    content: '';
    position: absolute;
    width: 40px;
    height: 40px;
    border-radius: 999px;
    background: var(--color-surface-1);
  }
  .status-detail-chart span {
    position: relative;
    z-index: 1;
    color: var(--color-text-primary);
    font-size: 15px;
    font-weight: 700;
  }
  .status-detail-header h2 {
    color: var(--color-text-primary);
    font-size: 15px;
    font-weight: 700;
  }
  .status-detail-header p {
    margin-top: 4px;
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.45;
  }
  .status-detail-close {
    flex: 0 0 auto;
    border-radius: 8px;
    padding: 5px 7px;
    color: var(--color-text-muted);
    font-size: 11px;
  }
  .status-detail-close:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .status-detail-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 17px;
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
    padding: 12px 0;
  }
  .status-detail-stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-muted);
    font-size: 11px;
  }
  .status-detail-stat strong {
    color: var(--color-text-primary);
    font-size: 13px;
  }
  .status-detail-list {
    max-height: 360px;
    overflow-y: auto;
    padding-top: 8px;
  }
  .status-detail-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    border-radius: 10px;
    padding: 9px 8px;
    text-align: left;
  }
  .status-detail-row:hover {
    background: var(--color-surface-2);
  }
  .status-detail-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 999px;
  }
  .status-detail-row strong,
  .status-detail-row small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-detail-row strong {
    color: var(--color-text-primary);
    font-size: 11px;
    font-weight: 600;
  }
  .status-detail-row small {
    margin-top: 2px;
    color: var(--color-text-muted);
    font-size: 11px;
  }
  .status-detail-state {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 600;
  }
  @keyframes status-chart-in {
    from {
      opacity: 0;
      transform: scale(0.65) rotate(-22deg);
    }
    to {
      opacity: 1;
      transform: scale(1) rotate(0);
    }
  }

  .status-orb svg,
  .status-pie svg {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
  }

  .project-status-indicator:hover .status-orb {
    transform: scale(1.08);
  }

  .status-popover {
    position: absolute;
    top: calc(100% + 9px);
    /* Center the popover under the indicator instead of flushing right, so it
       never drifts off the left edge of the sidebar/screen. */
    left: 50%;
    z-index: 9999;
    display: flex;
    width: 200px;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-border-bright);
    border-radius: var(--radius-lg);
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-surface-3) 94%, var(--color-surface-0));
    box-shadow: 0 14px 34px color-mix(in srgb, var(--color-surface-0) 76%, transparent);
    pointer-events: none;
    opacity: 0;
    transform: translate(-50%, -3px) scale(0.98);
    transform-origin: top center;
    transition:
      opacity var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .project-status-indicator:hover .status-popover {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
    transition-delay: 160ms;
  }

  .status-popover-heading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .status-pie {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--color-text-primary) 18%, transparent);
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-surface-0) 26%, transparent);
  }

  .status-popover-heading > span:last-child {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .status-popover-heading strong {
    color: var(--color-text-primary);
    font-size: var(--text-xl);
    line-height: var(--leading-none);
  }

  .status-popover-heading small {
    margin-top: var(--space-1);
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .status-legend {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .status-legend-row {
    display: grid;
    grid-template-columns: 7px 1fr auto 28px;
    align-items: center;
    gap: var(--space-2);
    font-size: 11px;
  }

  .status-swatch {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
  }

  .status-legend-label {
    color: var(--color-text-secondary);
    text-align: left;
  }

  .status-legend-row strong {
    color: var(--color-text-primary);
    font-weight: var(--font-semibold);
  }

  .status-legend-row small {
    color: var(--color-text-muted);
    text-align: right;
  }

  .project-new-chat:hover:not(:disabled) {
    color: var(--color-accent) !important;
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .project-new-chat:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .workspace-row {
    border: 1px solid color-mix(in srgb, var(--color-border) 76%, transparent);
    background: color-mix(in srgb, var(--color-surface-2) 48%, transparent);
  }

  .workspace-folder-icon {
    color: var(--color-accent);
  }

  .workspace-children {
    position: relative;
    margin-left: 16px;
    padding-left: 9px;
    border-left: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
  }

  .project-children {
    position: relative;
    margin-left: 10px;
    padding: 2px 0 3px 5px;
    border-left: 1px solid var(--color-border);
  }

  .session-row {
    isolation: isolate;
    transition:
      background-color var(--duration-normal) var(--ease-out),
      border-color var(--duration-normal) var(--ease-out),
      box-shadow var(--duration-normal) var(--ease-out);
  }

  .session-row:hover,
  .session-row:focus-within {
    z-index: 1;
    background: color-mix(in srgb, var(--color-accent) 4%, var(--color-surface-2));
    border-color: color-mix(in srgb, var(--color-accent) 24%, transparent);
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-accent) 38%, transparent);
  }

  .session-row.active-session {
    background: color-mix(in srgb, var(--color-accent) 9%, var(--color-surface-1));
    border-color: color-mix(in srgb, var(--color-accent) 32%, transparent);
    box-shadow:
      inset 2px 0 0 var(--color-accent),
      inset 0 1px 0 color-mix(in srgb, var(--color-accent) 6%, transparent);
  }

  .status-cell {
    background: transparent;
    border: 1px solid transparent;
  }

  .status-cell.is-running {
    background: transparent;
    border-color: transparent;
  }

  .session-copy {
    transition:
      padding-right var(--duration-fast) var(--ease-out),
      opacity var(--duration-fast) var(--ease-out);
  }

  .session-actions {
    opacity: 0;
    transform: translateX(3px);
    background: color-mix(in srgb, var(--color-accent) 4%, var(--color-surface-2));
    box-shadow: -8px 0 12px color-mix(in srgb, var(--color-accent) 4%, var(--color-surface-2));
    transition:
      opacity var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .session-action-wrap {
    position: relative;
    display: flex;
  }

  .session-action {
    display: flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .session-action:hover {
    color: var(--color-text-primary);
    background: var(--color-surface-4);
    border-color: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .session-action:active {
    transform: scale(0.92);
  }

  .session-action:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .session-action-pin-active {
    color: var(--color-accent);
  }

  .session-action-danger:hover {
    color: var(--color-error);
    background: var(--color-error-bg);
    border-color: color-mix(in srgb, var(--color-error) 28%, transparent);
  }

  .session-action-tooltip {
    position: absolute;
    right: 0;
    bottom: calc(100% + 7px);
    z-index: var(--z-tooltip);
    width: max-content;
    /* A nested chat row sits ~60px from the sidebar's left edge, and the
       sidebar floor is 220px wide, so a wider nowrap panel would reach past
       the window. Keep labels short enough to fit (see the label copy) and
       cap the box as a backstop. */
    max-width: 180px;
    padding: 5px 8px;
    border: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
    border-radius: 6px;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-surface-4) 88%, var(--color-surface-0));
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-surface-0) 72%, transparent);
    font-size: 11px;
    font-weight: var(--font-medium);
    line-height: var(--leading-tight);
    letter-spacing: 0.01em;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transform: translateY(3px) scale(0.98);
    transform-origin: bottom right;
    transition:
      opacity var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .session-action-tooltip::after {
    content: '';
    position: absolute;
    right: 7px;
    bottom: -4px;
    width: 7px;
    height: 7px;
    border-right: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
    border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-border));
    background: color-mix(in srgb, var(--color-surface-4) 88%, var(--color-surface-0));
    transform: rotate(45deg);
  }

  .session-action-wrap:hover .session-action-tooltip,
  .session-action-wrap:focus-within .session-action-tooltip {
    opacity: 1;
    transform: translateY(0) scale(1);
    transition-delay: 220ms;
  }

  .session-row:hover .session-actions,
  .session-row:focus-within .session-actions {
    opacity: 1;
    transform: translateX(0);
  }

  .session-row:hover .session-copy,
  .session-row:focus-within .session-copy {
    padding-right: 62px;
  }

  .approval-badge {
    color: var(--color-warning);
    background: var(--color-warning-bg);
  }

  .session-row.drag-over {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface-2));
  }
  .session-row.dragging {
    opacity: 0.5;
  }
  .project-row.drag-over {
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface-2));
  }
  .project-row.dragging {
    opacity: 0.5;
  }

  @media (prefers-reduced-motion: reduce) {
    .session-row,
    .session-actions,
    .session-action,
    .session-action-tooltip,
    .status-orb,
    .status-popover {
      transition: none;
    }

    .session-action-wrap:hover .session-action-tooltip,
    .session-action-wrap:focus-within .session-action-tooltip {
      transition-delay: 0ms;
    }

    .project-status-indicator:hover .status-popover {
      transition-delay: 0ms;
    }
  }
</style>
