<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { useNow } from '$lib/utils/now-signal.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { isGuidedDemo } from '$lib/demo-flags';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import Plus from 'lucide-svelte/icons/plus';
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
  import Users from 'lucide-svelte/icons/users';
  import LogOut from 'lucide-svelte/icons/log-out';
  import UserPlus from 'lucide-svelte/icons/user-plus';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import Target from 'lucide-svelte/icons/target';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
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
  }

  interface StatusSlice {
    key: 'running' | 'failed' | 'compacting' | 'waiting' | 'completed';
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
  let showDeleteAllDialog = $state<boolean>(false);
  // One pending lifecycle action drives one warning screen: archiving and
  // deleting show the same warning with a different verb.
  let pendingLifecycle = $state<{ action: SessionLifecycleAction; id: string } | null>(null);
  let suppressLifecycleWarning = $state<boolean>(false);
  let archivingId = $state<string>('');
  let preparingDeleteAll = $state(false);
  let creating = $state(false);
  let launcherOpen = $state(false);
  let showTeamSidebarShortcut = $state(false);
  let goalClock = $state(Date.now());
  let collapsedProjectKeys = $state<Set<string>>(new Set());
  let collapsedWorkspaceRoot = $state<string | null>(null);
  let sessionBilling = $state<Record<string, SessionBillingSummary>>({});
  let sessionBillingDetails = $state<Record<string, SessionBillingSummary | null | undefined>>({});
  let hoveredCostSessionId = $state('');
  /** Viewport coordinates for the fixed tracked-spend popover. */
  let costPopoverAnchor = $state<{ left: number; top: number } | null>(null);
  let billingExcludedProviders = $state<string[]>([]);
  let showSubscriptionApiEquivalent = $state(true);
  let sessionBillingTimer: ReturnType<typeof setInterval> | null = null;
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

  async function loadSessionBilling() {
    try {
      const response = await apiFetch(
        apiUrl(sidebarBillingPath('/api/billing/session-costs')),
        {},
        3_000,
      );
      if (!response.ok) return;
      const payload = await response.json();
      if (payload?.ok && payload.sessions) sessionBilling = payload.sessions;
    } catch {
      // Supplemental UI: preserve last-known-good costs on transient failures.
    }
  }

  async function loadSessionBillingDetail(sessionId: string) {
    if (Object.prototype.hasOwnProperty.call(sessionBillingDetails, sessionId)) return;
    sessionBillingDetails[sessionId] = undefined;
    try {
      const path = sidebarBillingPath(`/api/billing/session/${encodeURIComponent(sessionId)}`);
      const response = await apiFetch(apiUrl(path), {}, 3_000);
      if (!response.ok) {
        sessionBillingDetails[sessionId] = null;
        return;
      }
      const payload = await response.json();
      sessionBillingDetails[sessionId] = payload?.ok ? payload.summary : null;
    } catch {
      sessionBillingDetails[sessionId] = null;
    }
  }

  function sessionCostLabel(session: Session): string {
    const summary = sessionBilling[session.id];
    if (summary) {
      if (!summary.hasMeteredUsage && summary.hasSubscriptionUsage) return formatUsd(0);
      if (summary.hasMeteredUsage && !summary.hasKnownCost) return USD_UNKNOWN;
      return formatUsd(summary.spendUsd ?? summary.spendCents / 100);
    }
    if (session.totalCost > 0) return formatUsd(session.totalCost);
    if ((session.totalTokensIn ?? 0) > 0 || (session.totalTokensOut ?? 0) > 0) return USD_UNKNOWN;
    return '';
  }

  onMount(() => {
    if (!goalStore.loaded) void goalStore.refresh();
    loadSidebarBillingPreferences();
    loadTeamUiPreferences();
    void loadSessionBilling();
    const handleBillingPreferencesChanged = () => {
      loadSidebarBillingPreferences();
      sessionBillingDetails = {};
      void loadSessionBilling();
    };
    const handleTeamUiPreferencesChanged = () => loadTeamUiPreferences();
    window.addEventListener('kory:billing-preferences-changed', handleBillingPreferencesChanged);
    window.addEventListener('kory:team-ui-preferences-changed', handleTeamUiPreferencesChanged);
    sessionBillingTimer = setInterval(() => void loadSessionBilling(), 15_000);
    return () => {
      nowClock.unsubscribe();
      if (sessionBillingTimer) clearInterval(sessionBillingTimer);
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
    if (!query) return sessionStore.sessions;
    return sessionStore.sessions.filter((session) => {
      const path = session.workingDirectory ?? '';
      return (
        session.title.toLowerCase().includes(query) ||
        path.toLowerCase().includes(query) ||
        projectDisplayName(path).toLowerCase().includes(query)
      );
    });
  });

  function statusCategory(status: AgentStatus): StatusSlice['key'] | null {
    if (status === 'idle') return null;
    if (status === 'error') return 'failed';
    if (status === 'compacting') return 'compacting';
    if (status === 'waiting' || status === 'waiting_user') return 'waiting';
    if (status === 'done') return 'completed';
    return 'running';
  }

  function statusSlicesForSessions(sessions: Session[]): StatusSlice[] {
    const counts: Record<StatusSlice['key'], number> = {
      running: 0,
      failed: 0,
      compacting: 0,
      waiting: 0,
      completed: 0,
    };

    for (const session of sessions) {
      const managerStatus = wsStore.getManagerStatusForSession(session.id);
      const workerStatuses = wsStore.getAgentStatusesForSession(session.id);
      for (const status of [managerStatus, ...workerStatuses]) {
        const category = statusCategory(status);
        if (category) counts[category] += 1;
      }
    }

    return [
      { key: 'running', label: 'Running', count: counts.running, color: 'var(--color-success)' },
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
        color: 'var(--color-text-muted)',
      },
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

  function projectStatusText(project: ProjectSessionGroup): string {
    if (project.runningCount > 0) return `${project.runningCount} running`;
    if (project.failedCount > 0) return `${project.failedCount} failed`;
    if (project.compactingCount > 0) return `${project.compactingCount} compacting`;
    return `${project.sessions.length} ${project.sessions.length === 1 ? 'chat' : 'chats'}`;
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
        const statusSlices = statusSlicesForSessions(project.sessions);
        return {
          key,
          ...project,
          statusSlices,
          runningCount: statusSlices.find((slice) => slice.key === 'running')?.count ?? 0,
          failedCount: statusSlices.find((slice) => slice.key === 'failed')?.count ?? 0,
          compactingCount: statusSlices.find((slice) => slice.key === 'compacting')?.count ?? 0,
        };
      })
      .sort((left, right) => {
        if (left.path === projectStore.currentPath) return -1;
        if (right.path === projectStore.currentPath) return 1;
        return right.latestActivity - left.latestActivity;
      });
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

  /** Chats rooted at the workspace are created from the workspace new-chat
   *  screen (which can target a project folder), never directly from here. */
  /** Measure the trigger so the fixed popover can sit just below it in
   *  viewport coordinates instead of being clipped by the sidebar. */
  function anchorCostPopover(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    costPopoverAnchor = { left: Math.round(rect.left), top: Math.round(rect.bottom + 4) };
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
      error: 'Needs attention',
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
    launcherOpen = !launcherOpen;
  }

  async function handleCreateProjectSession(event: MouseEvent, workingDirectory: string) {
    event.stopPropagation();
    if (isGuidedDemo) {
      toastStore.info(
        'Sample sessions are read-only in the demo. Run the app to create a workspace.',
      );
      return;
    }
    creating = true;
    try {
      const id = await sessionStore.createSession({
        workingDirectory: workingDirectory || projectStore.workspaceRoot || undefined,
      });
      if (id) window.dispatchEvent(new CustomEvent('kory:focus-input'));
    } finally {
      creating = false;
    }
  }

  async function loadHistory(id: string) {
    const messages = await sessionStore.fetchMessages(id);
    wsStore.loadSessionMessages(id, messages);
  }

  async function selectSession(id: string) {
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

    // Shift-click bypasses all confirmation (power-user escape hatch).
    if (e.shiftKey) {
      sessionStore.deleteSession(id);
      return;
    }

    // ONE confirmation model for every lifecycle action: the same warning
    // screen, verb-swapped, that explains the session's agent tree is stopped.
    // A user who already accepted that with "Don't show again" goes straight
    // through.
    if (isSessionActionWarningSuppressed('delete')) {
      sessionStore.deleteSession(id);
      return;
    }

    openLifecycleWarning('delete', id);
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
    if (suppress) suppressSessionActionWarning(pending.action);

    if (pending.action === 'archive') await performArchive(pending.id);
    else sessionStore.deleteSession(pending.id);
  }

  function handleCancelLifecycle() {
    pendingLifecycle = null;
    suppressLifecycleWarning = false;
  }

  async function requestDeleteAll() {
    if (isGuidedDemo) {
      toastStore.info('Sample sessions are protected in the demo.');
      return;
    }
    if (sessionStore.sessions.length === 0) return;
    preparingDeleteAll = true;
    try {
      const loaded = await sessionStore.fetchArchivedSessions();
      if (!loaded) {
        toastStore.error(
          sessionStore.archivedError ||
            'Could not verify archived chats. Nothing was deleted; try again when the backend is available.',
        );
        return;
      }
      showDeleteAllDialog = true;
    } finally {
      preparingDeleteAll = false;
    }
  }

  async function handleConfirmDeleteAll() {
    showDeleteAllDialog = false;
    await sessionStore.deleteAllSessions();
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
    class="sidebar-toolbar relative flex items-center gap-2 border-b px-3 py-2.5"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
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
        class="sidebar-search h-8 w-full rounded-lg border bg-transparent pl-8 pr-2 text-xs outline-none transition-colors"
        style="border-color: var(--color-border); color: var(--color-text-primary);"
        bind:value={sessionStore.searchQuery}
      />
    </div>
    <div class="relative shrink-0">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--color-surface-3)]"
        style="border-color: var(--color-border); color: var(--color-accent);"
        disabled={creating || isGuidedDemo}
        onclick={handleLauncherToggle}
        title={isGuidedDemo ? 'Sample sessions are read-only in the guided demo' : 'Create or open'}
        aria-label="Create or open"
        aria-expanded={launcherOpen}
      >
        {#if creating}
          <LoaderCircle size={16} class="animate-spin" />
        {:else}
          <Plus size={16} />
        {/if}
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
          onclick={() => runLauncherAction('new_session')}
          role="menuitem"
        >
          <MessageSquare size={14} /> New Chat
        </button>

        {#if projectStore.workspaceRoot || recentProjects.length > 0}
          <div class="my-1 border-t border-[var(--color-border)]"></div>
          <div
            class="px-3 pb-1 pt-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
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
              <span class="ml-auto shrink-0 text-[9px] text-[var(--color-text-muted)]"
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
    {#if collaborationStore.joinedSessions.length > 0}
      <div class="mb-3">
        <div class="flex items-center justify-between px-3 py-2">
          <span
            class="text-xs font-semibold uppercase tracking-[0.14em]"
            style="color:var(--color-text-muted)">Team workspaces</span
          ><span
            class="rounded-full px-2 py-0.5 text-[9px]"
            style="background:var(--color-surface-3);color:var(--color-text-muted)"
            >{collaborationStore.joinedSessions.length}</span
          >
        </div>
        {#each collaborationStore.joinedSessions as team (team.sessionId)}
          <div
            role="button"
            tabindex="0"
            onclick={() => collaborationStore.openJoinedSession(team.sessionId)}
            onkeydown={(e) => {
              if (e.key === 'Enter') collaborationStore.openJoinedSession(team.sessionId);
            }}
            class="group mx-1 flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition-colors {collaborationStore
              .activeJoinedSession?.sessionId === team.sessionId
              ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
              : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'}"
          >
            <div
              class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-lg"
              style="background:color-mix(in srgb,var(--color-accent) 14%,transparent);color:var(--color-accent)"
            >
              <Users size={12} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium" style="color:var(--color-text-primary)">
                {team.sessionName}
              </div>
              <div
                class="mt-1 flex items-center gap-1.5 text-[10px]"
                style="color:var(--color-text-muted)"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>{team.tierId} · hosted
              </div>
            </div>
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                collaborationStore.leaveJoinedSession(team.sessionId);
              }}
              class="rounded-lg p-1.5 text-red-400 opacity-0 transition-all hover:bg-red-500/10 group-hover:opacity-100"
              title="Leave team workspace"><LogOut size={12} /></button
            >
          </div>
        {/each}
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
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-error-bg)] disabled:cursor-not-allowed disabled:opacity-35"
        style="color: var(--color-error);"
        onclick={requestDeleteAll}
        disabled={sessionStore.sessions.length === 0 || preparingDeleteAll}
        aria-label="Delete all sessions"
        title={preparingDeleteAll ? 'Checking archives…' : 'Delete all sessions'}
      >
        {#if preparingDeleteAll}
          <LoaderCircle size={11} class="animate-spin" />
        {:else}
          <Trash2 size={11} />
        {/if}
      </button>
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
          <span class="shrink-0 text-[9px]" style="color: var(--color-text-muted);">
            {workspaceProjectCount}
          </span>
        </button>
        <button
          type="button"
          class="workspace-new-chat flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-2)]"
          style="color: var(--color-text-muted);"
          disabled={isGuidedDemo}
          onclick={requestWorkspaceNewChat}
          aria-label={`New chat in workspace ${projectDisplayName(projectStore.workspaceRoot)}`}
          title={isGuidedDemo
            ? 'Sample sessions are read-only in the guided demo'
            : `New chat in workspace ${projectDisplayName(projectStore.workspaceRoot)}`}
        >
          <Plus size={12} />
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
                >
                  <span
                    class="flex h-4 w-4 shrink-0 items-center justify-center"
                    style="color: var(--color-text-muted);"
                  >
                    {#if expanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
                  </span>
                  <span
                    class="project-folder-icon flex h-4 w-4 shrink-0 items-center justify-center"
                  >
                    <FolderOpen size={14} />
                  </span>
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
                    >
                      <span class="status-orb" aria-hidden="true">
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
                      <span class="status-popover" role="tooltip">
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
                            <small>{statusTotal === 1 ? 'agent tracked' : 'agents tracked'}</small>
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
                    </span>
                  {/if}
                </button>
                <button
                  type="button"
                  class="project-new-chat flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                  style="color: var(--color-text-muted);"
                  disabled={creating || isGuidedDemo}
                  onclick={(event) => handleCreateProjectSession(event, project.path)}
                  aria-label={`New chat in ${project.label}`}
                  title={isGuidedDemo
                    ? 'Sample sessions are read-only in the guided demo'
                    : `New chat in ${project.label}`}
                >
                  {#if creating}
                    <LoaderCircle size={11} class="animate-spin" />
                  {:else}
                    <Plus size={12} />
                  {/if}
                </button>
              </div>
            {/if}

            {#if project.isWorkspaceRoot || expanded}
              <div
                id={`project-chats-${project.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                class="project-children"
              >
                {#each project.sessions as session (session.id)}
                  {@const managerStatus = wsStore.getManagerStatusForSession(session.id)}
                  {@const sessionGoals = goalsForSession(session.id)}
                  {@const primaryGoal = sessionGoals[0]}
                  {@const needsApproval = wsStore.pendingPermissions.some(
                    (permission) => permission.sessionId === session.id,
                  )}
                  <div
                    class="session-item session-row group relative mx-0.5 flex min-h-12 items-center gap-2 rounded-lg border border-transparent px-1.5 py-1.5 transition-colors"
                    class:active-session={sessionStore.activeSessionId === session.id &&
                      !collaborationStore.activeJoinedSession}
                  >
                    {#if editingId === session.id}
                      <div class="relative z-[2] flex min-w-0 flex-1 flex-col gap-0.5">
                        <div class="flex items-center gap-1">
                          <input
                            type="text"
                            class="input h-7 min-w-0 flex-1 text-xs {editError
                              ? 'border-red-500'
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
                          class="px-0.5 text-[9px]"
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
                          ? `Open session ${session.title}, currently open`
                          : `Open session ${session.title}`}
                        aria-current={sessionStore.activeSessionId === session.id &&
                        !collaborationStore.activeJoinedSession
                          ? 'page'
                          : undefined}
                        onclick={() => selectSession(session.id)}
                        ondblclick={() => !isGuidedDemo && startRename(session.id, session.title)}
                      ></button>

                      <div
                        class="status-cell pointer-events-none relative z-[1] flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                        class:is-running={managerStatus !== 'idle'}
                        title={managerStatus !== 'idle'
                          ? statusLabel(managerStatus)
                          : primaryGoal
                            ? 'Assigned to an active goal'
                            : 'Chat is idle'}
                      >
                        {#if managerStatus !== 'idle'}
                          <AnimatedStatusIcon
                            status={managerStatus}
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
                          <span
                            class="min-w-0 flex-1 truncate text-xs font-medium"
                            style="color: var(--color-text-primary);"
                          >
                            {session.title}
                          </span>
                          {#if needsApproval && sessionStore.activeSessionId !== session.id}
                            <span
                              class="approval-badge inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[9px] font-semibold"
                              title="An agent in this chat is waiting for your approval"
                            >
                              <ShieldAlert size={9} />Approve
                            </span>
                          {/if}
                        </div>
                        <!-- Meta row packs price, message count and timestamp into a
                             single tight left-aligned group so no width is wasted. -->
                        <div
                          class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px]"
                          style="color: var(--color-text-muted);"
                        >
                          {#if sessionCostLabel(session)}
                            <span
                              class="pointer-events-auto relative z-20 shrink-0"
                              role="group"
                              onmouseenter={(event) => {
                                hoveredCostSessionId = session.id;
                                anchorCostPopover(event.currentTarget as HTMLElement);
                                void loadSessionBillingDetail(session.id);
                              }}
                              onmouseleave={() => {
                                hoveredCostSessionId = '';
                                costPopoverAnchor = null;
                              }}
                            >
                              <button
                                type="button"
                                class="rounded px-0.5 font-mono underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-secondary)]"
                                style="font-size: var(--text-xs); color: var(--color-text-muted);"
                                onclick={(event) => event.stopPropagation()}
                                aria-label={`Billing detail for ${session.title}`}
                              >
                                {sessionCostLabel(session)}
                              </button>
                              {#if hoveredCostSessionId === session.id}
                                <!-- Viewport-anchored: the sidebar is a scroll container, so an
                                 absolutely positioned panel overflowed it and was clipped. -->
                                <div
                                  class="cost-billing-popover fixed z-[80] w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left shadow-2xl"
                                  role="tooltip"
                                  style="left: {costPopoverAnchor?.left ??
                                    0}px; top: {costPopoverAnchor?.top ?? 0}px;"
                                >
                                  {#if sessionBillingDetails[session.id] === undefined}
                                    <div class="text-[10px] text-[var(--color-text-muted)]">
                                      Loading billing detail…
                                    </div>
                                  {:else if sessionBillingDetails[session.id] === null}
                                    <div class="text-[10px] text-[var(--color-text-muted)]">
                                      Billing detail unavailable
                                    </div>
                                  {:else}
                                    {@const detail = sessionBillingDetails[session.id]}
                                    <div class="mb-2 flex items-start justify-between gap-3">
                                      <div>
                                        <div
                                          class="text-[10px] font-semibold text-[var(--color-text-primary)]"
                                        >
                                          Tracked spend
                                        </div>
                                        {#if detail?.pricingIncomplete}<div
                                            class="text-[9px] text-[var(--color-warning)]"
                                          >
                                            Pricing incomplete
                                          </div>{/if}
                                      </div>
                                      <div
                                        class="font-mono text-[11px] font-bold text-[var(--color-text-primary)]"
                                      >
                                        {detail?.hasMeteredUsage && !detail?.hasKnownCost
                                          ? USD_UNKNOWN
                                          : formatUsd(detail?.spendUsd ?? 0)}
                                      </div>
                                    </div>
                                    <div class="space-y-2">
                                      {#each detail?.providers ?? [] as provider (provider.name)}
                                        <div>
                                          <div
                                            class="flex items-center justify-between gap-2 text-[10px]"
                                          >
                                            <span
                                              class="font-semibold text-[var(--color-text-secondary)]"
                                              >{provider.name}</span
                                            >
                                            <span
                                              class="font-mono text-[var(--color-text-primary)]"
                                            >
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
                                              class="ml-2 flex items-center justify-between gap-2 py-0.5 text-[9px] text-[var(--color-text-muted)]"
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
                                </div>
                              {/if}
                            </span>
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
                          <span class="min-w-0 shrink-0 truncate"
                            >{session.messageCount} msgs</span
                          >
                          <span class="shrink-0 tabular-nums">{formatTime(session.updatedAt)}</span>
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
                              onclick={(event) => {
                                event.stopPropagation();
                                startRename(session.id, session.title);
                              }}
                              ondblclick={(event) => event.stopPropagation()}
                              aria-label="Rename session"
                              aria-describedby={`rename-session-${session.id}-tooltip`}
                            >
                              <Pencil size={11} />
                            </button>
                            <span
                              id={`rename-session-${session.id}-tooltip`}
                              class="session-action-tooltip"
                              role="tooltip">Rename</span
                            >
                          </span>
                          <span class="session-action-wrap">
                            <button
                              type="button"
                              class="session-action"
                              disabled={archivingId === session.id}
                              onclick={(event) => handleArchive(event, session.id)}
                              ondblclick={(event) => event.stopPropagation()}
                              aria-label="Archive chat"
                              aria-describedby={`archive-session-${session.id}-tooltip`}
                            >
                              {#if archivingId === session.id}
                                <LoaderCircle size={11} class="animate-spin" />
                              {:else}
                                <Archive size={11} />
                              {/if}
                            </button>
                            <span
                              id={`archive-session-${session.id}-tooltip`}
                              class="session-action-tooltip"
                              role="tooltip">Archive chat</span
                            >
                          </span>
                          <span class="session-action-wrap">
                            <button
                              type="button"
                              class="session-action session-action-danger"
                              onclick={(event) => confirmDelete(event, session.id)}
                              ondblclick={(event) => event.stopPropagation()}
                              aria-label="Delete session"
                              aria-describedby={`delete-session-${session.id}-tooltip`}
                            >
                              <Trash2 size={11} />
                            </button>
                            <span
                              id={`delete-session-${session.id}-tooltip`}
                              class="session-action-tooltip"
                              role="tooltip">Shift-click to delete</span
                            >
                          </span>
                        </div>
                      {/if}
                    {/if}
                  </div>
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
  showSuppressOption
  suppressLabel="Don't show again"
  bind:suppressChecked={suppressLifecycleWarning}
  onConfirm={handleConfirmLifecycle}
  onCancel={handleCancelLifecycle}
/>

<ConfirmDialog
  open={showDeleteAllDialog}
  title="Delete All Sessions?"
  message={`This permanently deletes ${sessionStore.sessions.length} active ${sessionStore.sessions.length === 1 ? 'chat' : 'chats'} and ${sessionStore.archivedSessions.length} archived ${sessionStore.archivedSessions.length === 1 ? 'chat' : 'chats'}, including their complete history. Any running work will be stopped. This cannot be undone.`}
  confirmLabel="Delete All Sessions"
  cancelLabel="Cancel"
  variant="danger"
  onConfirm={handleConfirmDeleteAll}
  onCancel={() => (showDeleteAllDialog = false)}
/>

<style>
  .sidebar-toolbar {
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-accent) 4%, transparent);
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
    width: 18px;
    height: 18px;
  }

  .status-orb {
    width: 11px;
    height: 11px;
    border: 1px solid color-mix(in srgb, var(--color-text-primary) 22%, transparent);
    border-radius: var(--radius-full);
    box-shadow:
      0 0 0 2px var(--color-surface-1),
      0 0 0 3px color-mix(in srgb, var(--color-border) 58%, transparent);
    transition:
      transform var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) var(--ease-out);
  }

  .status-orb svg,
  .status-pie svg {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
  }

  .project-status-indicator:hover .status-orb {
    transform: scale(1.14);
    box-shadow:
      0 0 0 2px var(--color-surface-1),
      0 0 0 3px var(--color-border-bright);
  }

  .status-popover {
    position: absolute;
    top: calc(100% + 9px);
    /* Flush with the row's right edge, not 30px past it. The tree is now
       overflow-x-hidden, so a negative offset would be clipped rather than
       scrolling, and at the 220px sidebar floor a 218px panel would lose its
       left column. */
    right: 0;
    z-index: var(--z-tooltip);
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
    transform: translateY(-3px) scale(0.98);
    transform-origin: top right;
    transition:
      opacity var(--duration-fast) var(--ease-out),
      transform var(--duration-fast) var(--ease-out);
  }

  .project-status-indicator:hover .status-popover {
    opacity: 1;
    transform: translateY(0) scale(1);
    transition-delay: 160ms;
  }

  .status-popover-heading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .status-pie {
    width: 52px;
    height: 52px;
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
    font-size: 10px;
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
    font-size: 10px;
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
    font-size: 10px;
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
