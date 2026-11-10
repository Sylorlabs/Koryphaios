<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { NoteLinkTarget } from '$lib/utils/kory-link-favicon';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import {
    projectStore,
    projectDisplayName,
    type WorkspaceNavigationSnapshot,
  } from '$lib/stores/project.svelte';
  import { createWorkspaceController } from '$lib/utils/workspace-controller.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { isDemoMode, isFullDemo, isGuidedDemo } from '$lib/demo.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import type { ImageInputMode } from '$lib/utils/image-input-fallback';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import AgentThreadFeed from '$lib/components/AgentThreadFeed.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import type { ChatFindingInput } from '@koryphaios/shared';
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import RewindDialog from '$lib/components/RewindDialog.svelte';
  import SaveFindingDialog from '$lib/components/SaveFindingDialog.svelte';
  import GitConflictDialog from '$lib/components/GitConflictDialog.svelte';
  import TimeTravelPanel from '$lib/components/TimeTravelPanel.svelte';

  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import OnboardingWalkthrough from '$lib/components/OnboardingWalkthrough.svelte';
  import { onboardingStore } from '$lib/stores/onboarding.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import WorkflowPanel from '$lib/components/WorkflowPanel.svelte';
  import { parseGoalSlashCommand, type GoalActionRequest } from '$lib/utils/goal-actions';
  import MenuBar from '$lib/components/MenuBar.svelte';
  import ThemePickerModal from '$lib/components/ThemePickerModal.svelte';
  import BackgroundShells from '$lib/components/BackgroundShells.svelte';
  import AppShell from '$lib/components/shell/AppShell.svelte';
  import AgentRail from '$lib/components/shell/AgentRail.svelte';
  import { useAgentRail } from '$lib/components/shell/useAgentRail.svelte';
  import { useSessionSync } from '$lib/hooks/useSessionSync.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import FolderPlus from 'lucide-svelte/icons/folder-plus';
  import Clock from 'lucide-svelte/icons/clock';
  import X from 'lucide-svelte/icons/x';
  import TeamWorkspace from '$lib/components/TeamWorkspace.svelte';
  import WorkspaceNewChat from '$lib/components/WorkspaceNewChat.svelte';
  import DeviceNewChat from '$lib/components/DeviceNewChat.svelte';
  import Monitor from 'lucide-svelte/icons/monitor';
  import { deviceStore } from '$lib/stores/devices.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import {
    type RecentProject,
    parseRecentProjects,
    pruneRecentProjects,
    pathExists,
    addRecentProject,
    removeRecentProject,
    buildNewProjectTemplate,
    createProjectSession,
    readProjectFile,
    readProjectFolder,
    insertPromptTemplate,
  } from '$lib/utils/projectManager';
  import {
    getModelConfigurationWarning,
    parseProviderModelSelection,
  } from '$lib/utils/model-config';
  import { loadLastSessionId } from '$lib/stores/navigation-preferences';
  import {
    buildCacheFabricLabel,
    buildCacheReceiptLabel,
    buildProviderCacheCards,
  } from '$lib/utils/cache-metrics';
  import {
    buildCacheDiagnosticsNotice,
    normalizeCacheDiagnostics,
    type CacheDiagnostics,
  } from '$lib/utils/cache-diagnostics';
  import { registerEligibleEscape } from '$lib/utils/double-escape';
  import { buildContextSegments, contextCacheStatus } from '$lib/utils/context-segments';
  import {
    implementationPrompt,
    latestPlanText,
    originalPlanRequest,
    validatePlanReadiness,
  } from '$lib/utils/plan-handoff';
  import {
    nativeCommandsStore,
    providerFromModel,
    NATIVE_CLI_PROVIDERS,
    type NativeSlashCommand,
  } from '$lib/stores/native-commands.svelte';
  import { runStateStore } from '$lib/stores/run-state.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { type SettingsTab } from '$lib/utils/settings-catalog';

  let showSettings = $state(false);
  const showOnboarding = $derived(!isDemoMode && authStore.isAuthenticated && onboardingStore.shouldShow);

  /** Nothing is set up yet: no project, no workspace, no chat.
   *
   *  A fresh install opens on the start window alone. The composer dock — the
   *  context bar, the input, the send controls — would be a dead end there
   *  (there is no project to run in and nothing to attach), so it stays hidden
   *  until a project is shown, then returns exactly as before. */
  const startWindowOnly = $derived(
    !projectStore.currentPath &&
      !projectStore.workspaceRoot &&
      projectStore.workspaceProjects.length === 0 &&
      sessionStore.sessions.length === 0,
  );
  let showAgents = $state(false);
  let agentsDismissed = $state(false);
  let showSidebar = $state(true);
  let showNotes = $state(false);
  let saveFinding = $state<ChatFindingInput | null>(null);
  let showSidebarBeforeZen = $state(true);
  let showAgentsBeforeZen = $state(false);
  let showCommandPalette = $state(false);
  let showThemeQuickMenu = $state(false);
  let showTimeTravel = $state(false);
  let showWorkflows = $state(false);
  let showGitConflicts = $state(false);
  let lastConflictRevision = $state(0);
  let workflowTask = $state('');
  let activeWorkflow = $state<
    { name: string; stage: string; status: string; task: string } | undefined
  >();
  let lastIdleEscapeAt = 0;
  let zenMode = $state(false);
  let settingsInitialTab = $state<SettingsTab | undefined>(undefined);
  let settingsInitialAgentSection = $state<'permissions' | undefined>(undefined);
  let inputRef = $state<HTMLTextAreaElement>();
  let projectFileInput = $state<HTMLInputElement>();
  let projectFolderInput = $state<HTMLInputElement>();
  let recentProjects = $state<RecentProject[]>([]);
  let composerDraft = $state('');
  let clearComposerDraftRequest = $state(0);
  let interactionMode = $derived(
    sessionStore.sessions.find((session) => session.id === sessionStore.activeSessionId)
      ?.interactionMode ?? 'act',
  );
  let currentPlanText = $derived(latestPlanText(wsStore.feed));
  let planReady = $derived(validatePlanReadiness(currentPlanText).ready);
  let currentProjectContent = $state('');
  let composerProjectFiles = $state<string[]>([]);
  let contextBarHover = $state(false);
  let cacheDiagnostics = $state<CacheDiagnostics | null>(null);
  // Set when the user tries to send without a project open — holds the pending
  // message so it can be dispatched after they pick a project or opt into home.
  let noProjectPrompt = $state<{
    message: string;
    model?: string;
    reasoningLevel?: string;
    attachments?: Array<{ type: string; data: string; name: string }>;
    fastMode?: boolean;
    imageInputMode?: ImageInputMode;
  } | null>(null);

  let contextSegments = $derived(buildContextSegments(wsStore.contextUsage));
  let contextCache = $derived(contextCacheStatus(wsStore.contextUsage));

  let cacheTurnReceipt = $derived.by(() => {
    const usage = wsStore.contextUsage;
    return buildCacheReceiptLabel({
      readTokens: usage.cachedInputTokens,
      writeTokens: usage.cacheWriteInputTokens,
      costUsd: usage.estimatedCostUsd,
      savingsUsd: usage.cacheSavingsUsd,
    });
  });

  let cacheFabricLabel = $derived.by(() => {
    const diagnostics = cacheDiagnostics;
    if (!diagnostics) return null;
    return buildCacheFabricLabel({
      warmCandidates:
        diagnostics.prompt.warmCandidates + diagnostics.prompt.workspaceWarmCandidates,
      dispatches: diagnostics.prompt.dispatches,
      evidenceHits: diagnostics.evidence.hits,
      evidenceMisses: diagnostics.evidence.misses,
      waits: diagnostics.evidence.waits,
    });
  });

  let cacheLastBust = $derived.by(() => {
    const last = cacheDiagnostics?.recent.at(-1);
    return last?.state === 'cold' && last.reasons.length > 0
      ? last.reasons.join(', ')
      : null;
  });

  let cacheDiagnosticsNotice = $derived.by(() => {
    const diagnostics = cacheDiagnostics;
    return diagnostics ? buildCacheDiagnosticsNotice(diagnostics) : '';
  });

  let cacheProviderScorecard = $derived.by(() =>
    buildProviderCacheCards(cacheDiagnostics?.durable.byProvider, 4),
  );

  function formatTokenCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  async function refreshCacheDiagnostics() {
    if (isDemoMode || !authStore.isAuthenticated) return;
    try {
      const res = await apiFetch(apiUrl('/api/providers/cache-diagnostics'));
      if (!res.ok) return;
      const payload = await res.json();
      cacheDiagnostics = normalizeCacheDiagnostics(payload?.data);
    } catch {
      // Diagnostics are best-effort and must never interrupt the chat surface.
    }
  }

  const agentRail = useAgentRail();

  async function refreshActiveWorkflow() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId || isDemoMode) {
      activeWorkflow = undefined;
      return;
    }
    try {
      const res = await apiFetch(
        apiUrl(`/api/agent/workflows?sessionId=${encodeURIComponent(sessionId)}`),
      );
      const data = await res.json();
      const run = data?.data?.runs?.find(
        (item: any) => item.status === 'running' || item.status === 'blocked',
      );
      const definition = data?.data?.definitions?.find((item: any) => item.id === run?.workflowId);
      const stage = definition?.stages?.[run?.stageIndex];
      activeWorkflow =
        run && definition
          ? {
              name: definition.name,
              stage: stage?.label ?? 'Complete',
              status: run.status,
              task: run.task,
            }
          : undefined;
    } catch (err: unknown) {
      console.warn(
        'Failed to refresh active workflow:',
        err instanceof Error ? err.message : String(err),
      );
      activeWorkflow = undefined;
    }
  }

  $effect(() => {
    void refreshActiveWorkflow();
  });

  $effect(() => {
    const revision = gitStore.state.conflictRevision;
    if (revision <= lastConflictRevision) return;
    lastConflictRevision = revision;
    showGitConflicts = gitStore.state.conflicts.length > 0;
  });

  useSessionSync({
    // Both demo variants are served by the in-memory API shim. This keeps the
    // guided sample's four workflows independently navigable.
    disabled: false,
    onActiveSessionChange: () => {
      agentRail.selectedAgentId = '';
      // Finalize or stop a simulated turn left running in the prior session.
      if (isDemoMode) void import('$lib/demo.svelte').then((m) => m.demoOnSessionSwitch());
    },
  });

  const composerSlashCommands = [
    { command: 'new', label: 'New Session', description: 'Create a fresh session.' },
    {
      command: 'resume',
      label: 'Resume Previous Chat',
      description: 'Resume the most recent earlier chat for this project.',
    },
    {
      command: 'compact',
      label: 'Compact Session',
      description: 'Summarize and compact the current session.',
    },
    {
      command: 'rewind',
      label: 'Time Travel',
      description: 'Inspect and restore recorded states from this session.',
    },
    { command: 'clear', label: 'Clear Feed', description: 'Clear the current visible feed.' },
    { command: 'settings', label: 'Open Settings', description: 'Open the settings drawer.' },
    {
      command: 'computer-use',
      label: 'Computer Use',
      description: 'Open computer-use permissions, app grants, and platform status.',
    },
    {
      command: 'computer-use status',
      label: 'Computer Use Status',
      description: 'Check native computer-use availability without discovering apps.',
    },
    { command: 'theme', label: 'Theme Picker', description: 'Open theme selection.' },
    { command: 'sidebar', label: 'Toggle Sidebar', description: 'Show or hide the sidebar.' },
    { command: 'zen', label: 'Toggle Zen', description: 'Enter or exit zen mode.' },
    { command: 'goal', label: 'Goal Mode', description: 'Open durable goals and their progress.' },
    {
      command: 'checklist',
      label: 'Checklists',
      description: 'Toggle this chat’s checklist panel; add a title to start a new list.',
    },
    {
      command: 'workflow',
      label: 'Workflows',
      description: 'Attach a host-owned workflow to the current task.',
    },
    {
      command: 'activity',
      label: 'Toggle Activity',
      description: 'Show or hide recent work above the chat.',
    },
    {
      command: 'goal create',
      label: 'Create Goal',
      description: 'Create a durable goal; add the objective after this command.',
    },
    {
      command: 'goal start',
      label: 'Start Goal',
      description: 'Start the selected goal and continue autonomously.',
    },
    { command: 'goal pause', label: 'Pause Goal', description: 'Pause the selected running goal.' },
    {
      command: 'goal resume',
      label: 'Resume Goal',
      description: 'Resume a paused or blocked goal.',
    },
    {
      command: 'goal stop',
      label: 'Stop Goal',
      description: 'Permanently stop the selected active goal.',
    },
  ];

  // Active composer model (bound from CommandInput) so we can surface the
  // active CLI provider's own /commands in the slash picker. The model itself
  // is chat-scoped inside CommandInput; worker tabs pin it via forcedModel.
  let activeComposerModel = $state<string>('');
  let activeComposerReasoning = $state<string>('');
  let nativeCommands = $state<{ label: string; commands: NativeSlashCommand[] } | null>(null);


  async function prewarmCacheForTyping(
    sessionId: string,
    model: string,
    reasoningLevel: string,
    mode: 'act' | 'plan',
  ) {
    try {
      await apiFetch(apiUrl('/api/providers/cache-prewarm'), {
        method: 'POST',
        body: JSON.stringify({ sessionId, model, reasoningLevel, interactionMode: mode }),
      });
    } catch {
      // Prewarm is opportunistic. It must never interrupt composing a message.
    }
  }

  // Warm the last verified provider prefix after a brief typing pause. The
  // draft itself is never sent; the backend replays only its stored cache lane.
  $effect(() => {
    const sessionId = sessionStore.activeSessionId;
    const model = activeComposerModel;
    const reasoningLevel = activeComposerReasoning;
    const mode = interactionMode;
    if (!sessionId || !model || !composerDraft.trim() || isDemoMode || !authStore.isAuthenticated) return;
    const timer = window.setTimeout(
      () => void prewarmCacheForTyping(sessionId, model, reasoningLevel, mode),
      350,
    );
    return () => window.clearTimeout(timer);
  });

  // Fetch native commands whenever the active provider is a CLI harness.
  $effect(() => {
    const provider = providerFromModel(activeComposerModel);
    if (!provider || !NATIVE_CLI_PROVIDERS.has(provider)) {
      nativeCommands = null;
      return;
    }
    let cancelled = false;
    void nativeCommandsStore.load(provider).then((result) => {
      if (!cancelled) nativeCommands = result;
    });
    return () => {
      cancelled = true;
    };
  });

  // Merge Kory's built-in slash commands with the active CLI provider's native
  // commands. Native commands are labeled with the provider name so the user
  // can tell them apart (e.g. "Claude Code · /status").
  let composerSlashCommandList = $derived.by(() => {
    const base = composerSlashCommands;
    if (!nativeCommands || nativeCommands.commands.length === 0) return base;
    const label = nativeCommands.label;
    const native = nativeCommands.commands.map((c) => ({
      command: c.command,
      label: `${label} · /${c.command}`,
      description: c.description,
    }));
    return [...base, ...native];
  });

  const LAYOUT_PREFS_KEY = 'koryphaios-layout-prefs';

  onMount(() => {
    const cleanupTheme = theme.init();
    if (!isDemoMode) {
      appStore.initialize(authStore, sessionStore).then(async () => {
        await refreshWorkspaceNavigation({ restoreFromActiveSession: true });
        if (authStore.isAuthenticated) {
          wsStore.connect();
        }
        if (projectStore.currentPath) {
          void refreshComposerFileMentions();
        }
        if (authStore.isAuthenticated && !sessionStore.activeSessionId) {
          const path = projectStore.currentPath;
          if (path) {
            const existing = sessionStore.sessionsForProject(path);
            if (existing.length > 0) {
              const latest = existing.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
              sessionStore.activeSessionId = latest.id;
            }
          }
        }
        // Host controls and pending approvals are backed by the collaboration
        // record, not the renderer. Rehydrate them after session selection so
        // a normal desktop reload does not strand an active team host.
        if (authStore.isAuthenticated && sessionStore.activeSessionId) {
          await collaborationStore.restore(sessionStore.activeSessionId);
        }
      });
      void notesStore.fetchSettings();
    } else {
      // The browser trial intentionally has no desktop app bootstrap or
      // websocket. It still loads virtual workspace mentions so Goal Mode is
      // discoverable.
      void refreshComposerFileMentions();
      void notesStore.fetchSettings();
    }
    // Prune recent projects whose folder no longer exists (fire-and-forget;
    // onMount cannot be async because it returns a cleanup function).
    void pruneRecentProjects(parseRecentProjects()).then((pruned) => {
      recentProjects = pruned;
    });
    loadLayoutPrefs();

    void refreshCacheDiagnostics();
    const cacheDiagnosticsTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshCacheDiagnostics();
    }, 10_000);

    window.addEventListener('keydown', handleGlobalKeydown);

    // Mount Notes before handing navigation to its unsaved draft guard.
    const handleOpenNote = async (e: Event) => {
      if (!notesStore.settings.enabled) {
        toastStore.error('Enable Notes in Settings to open note links.');
        return;
      }
      const target = (e as CustomEvent<NoteLinkTarget>).detail;
      if (!target) return;
      const project = projectStore.currentPath;
      showNotes = true;
      await tick();
      if (project !== projectStore.currentPath) return;
      window.dispatchEvent(new CustomEvent('kory-notes-open-target', { detail: target }));
    };
    window.addEventListener('open-note', handleOpenNote);

    const handleOpenNotesGraph = () => {
      if (!notesStore.settings.enabled) return;
      showNotes = true;
    };
    window.addEventListener('open-notes-graph', handleOpenNotesGraph);
    window.addEventListener('open-project-notes', handleOpenNotesGraph);
    const handleKnowledgeSettings = (event: Event) => {
      const destination = (event as CustomEvent).detail;
      if (!['notes', 'memory', 'skills'].includes(destination)) return;
      settingsInitialTab = destination;
      showSettings = true;
    };
    window.addEventListener('open-knowledge-settings', handleKnowledgeSettings);
    const handleNotesAskAgent = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (!prompt) return;
      showNotes = false;
      // Populate the composer for review; never submit or spend tokens silently.
      void import('svelte').then(({ tick }) => tick()).then(() => {
        if (!inputRef) return;
        inputRef.value = prompt;
        inputRef.dispatchEvent(new Event('input', { bubbles: true }));
        inputRef.focus();
      });
    };
    window.addEventListener('kory-notes-ask-agent', handleNotesAskAgent);
    const handleNotesSaveFinding = (event: Event) => {
      const detail = (event as CustomEvent<ChatFindingInput>).detail;
      if (!detail?.title || !detail.body || !detail.source?.sessionId) return;
      saveFinding = detail;
    };
    window.addEventListener('kory-notes-save-finding', handleNotesSaveFinding);
    const handleOpenTeamSettings = () => {
      collaborationStore.requestTeamSettings();
      showSettings = true;
    };
    window.addEventListener('open-team-settings', handleOpenTeamSettings);
    const handleOpenProviderAccountSettings = () => {
      showSettings = true;
    };
    window.addEventListener('open-provider-account-settings', handleOpenProviderAccountSettings);

    const handleFocusInput = () => inputRef?.focus();
    window.addEventListener('kory:focus-input', handleFocusInput);

    const handleHomePreset = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string; model?: string; reasoning?: string; permission?: string }>).detail;
      if (detail?.provider && detail.model) activeComposerModel = `${detail.provider}:${detail.model}`;
      if (detail?.reasoning) activeComposerReasoning = detail.reasoning;
      if (detail?.permission && ['yolo', 'guarded', 'edits', 'ask', 'custom'].includes(detail.permission)) {
        void agentSettingsStore.saveSettings({ permissionMode: detail.permission as 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom' }, { quietSuccess: true });
      }
    };
    window.addEventListener('kory:home-preset', handleHomePreset);

    window.addEventListener('kory:open-project-folder', openProjectFolderPicker);
    window.addEventListener('kory:workspace-new-chat', openWorkspaceNewChat);

    const handleWorkspaceSnapshot = (event: Event) => {
      const snapshot = (event as CustomEvent).detail as WorkspaceNavigationSnapshot | undefined;
      if (!snapshot) return;
      reconcileWorkspaceSnapshot(snapshot);
    };
    const handleWorkspaceRefresh = () => {
      void refreshWorkspaceNavigation();
    };
    const handleWorkspaceFocus = () => {
      if (document.visibilityState === 'visible') void refreshWorkspaceNavigation();
    };
    const handleProjectUnavailable = () => {
      workspace.setLastReconciledSessionId('');
      sessionStore.activeSessionId = '';
      toastStore.error(
        'The open project moved or was deleted. Choose a current folder to continue.',
      );
      // Clear the broken path from persistence so it doesn't survive a
      // relaunch or keep triggering API 400s via the requestPath header.
      void workspace.acknowledgeUnavailableProject();
      void refreshWorkspaceNavigation();
    };
    // Push events are authoritative; the interval is only a low-frequency
    // fallback for missed broadcasts (e.g. while the WS reconnects).
    const workspaceRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshWorkspaceNavigation();
    }, 30_000);
    window.addEventListener('focus', handleWorkspaceFocus);
    document.addEventListener('visibilitychange', handleWorkspaceFocus);
    window.addEventListener('kory-workspace-snapshot', handleWorkspaceSnapshot);
    window.addEventListener('kory-workspace-refresh', handleWorkspaceRefresh);
    window.addEventListener('kory-project-unavailable', handleProjectUnavailable);

    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('open-note', handleOpenNote);
      window.removeEventListener('open-notes-graph', handleOpenNotesGraph);
      window.removeEventListener('open-project-notes', handleOpenNotesGraph);
      window.removeEventListener('open-knowledge-settings', handleKnowledgeSettings);
      window.removeEventListener('kory-notes-ask-agent', handleNotesAskAgent);
      window.removeEventListener('kory-notes-save-finding', handleNotesSaveFinding);
      window.removeEventListener('open-team-settings', handleOpenTeamSettings);
      window.removeEventListener(
        'open-provider-account-settings',
        handleOpenProviderAccountSettings,
      );
      window.removeEventListener('open-team-settings', handleOpenTeamSettings);
      window.removeEventListener('kory:focus-input', handleFocusInput);
      window.removeEventListener('kory:home-preset', handleHomePreset);
      window.removeEventListener('kory:open-project-folder', openProjectFolderPicker);
      window.removeEventListener('kory:workspace-new-chat', openWorkspaceNewChat);
      window.removeEventListener('kory-workspace-snapshot', handleWorkspaceSnapshot);
      window.removeEventListener('kory-workspace-refresh', handleWorkspaceRefresh);
      window.clearInterval(workspaceRefreshTimer);
      window.clearInterval(cacheDiagnosticsTimer);
      window.removeEventListener('focus', handleWorkspaceFocus);
      window.removeEventListener('visibilitychange', handleWorkspaceFocus);
      window.removeEventListener('kory-project-unavailable', handleProjectUnavailable);
    };
  });

  const workspace = createWorkspaceController(
    {
      requestSnapshot: (path: string, init?: RequestInit) => apiFetch(apiUrl(path), init),
      getActiveSessionWorkingDirectory: () => {
        if (sessionStore.activeSessionId.startsWith('linked-')) return null;
        const active = sessionStore.sessions.find(
          (session) => session.id === sessionStore.activeSessionId,
        );
        return active?.workingDirectory ?? null;
      },
      clearActiveSession: () => {
        if (sessionStore.activeSessionId.startsWith('linked-')) return;
        sessionStore.activeSessionId = '';
      },
    },
    { onProjectChanged: () => void refreshComposerFileMentions() },
  );
  const reconcileWorkspaceSnapshot = workspace.reconcileWorkspaceSnapshot;
  const selectAuthoritativeProject = workspace.selectAuthoritativeProject;
  const deselectAuthoritativeProject = workspace.deselectAuthoritativeProject;
  const refreshWorkspaceNavigation = workspace.refreshWorkspaceNavigation;
  const acknowledgeUnavailableProject = workspace.acknowledgeUnavailableProject;

  function openWorkspaceNewChat() {
    if (isGuidedDemo || !projectStore.workspaceRoot) return;
    deviceStore.closeCreator();
    deviceStore.closeChat();
    collaborationStore.closeJoinedSession();
    agentRail.selectedAgentId = '';
    gitStore.closeDiff();
    workspace.setLastReconciledSessionId('');
    sessionStore.activeSessionId = '';
    void refreshWorkspaceNavigation();
  }

  // Seed the session→project fence with the stored last-session id. The
  // boot-restored session is not a user switch, so it must not bulldoze the
  // authoritative backend workspace state (deselecting the open project or
  // jumping to the old session's folder on every relaunch).
  workspace.setLastReconciledSessionId(loadLastSessionId());

  $effect(() => {
    const authenticated = appStore.authReady;
    const sessionId = sessionStore.activeSessionId;
    if (!authenticated || !sessionId || sessionId.startsWith('linked-') || sessionId === workspace.lastReconciledSessionId) return;
    workspace.setLastReconciledSessionId(sessionId);
    const session = sessionStore.sessions.find((item) => item.id === sessionId);
    if (session?.workingDirectory) {
      if (session.workingDirectory !== projectStore.currentPath) {
        void selectAuthoritativeProject(session.workingDirectory).then((selected) => {
          if (selected) return;
          workspace.setLastReconciledSessionId('');
          sessionStore.activeSessionId = '';
        });
      }
    } else if (projectStore.workspaceRoot && projectStore.currentPath) {
      void deselectAuthoritativeProject();
    }
  });

  // Enforce the product setting immediately: closing a currently open panel
  // also prevents every dashboard entry point from keeping it reachable.
  $effect(() => {
    if (!notesStore.settings.enabled) showNotes = false;
  });

  async function startDragging(e: MouseEvent) {
    if (
      typeof window === 'undefined' ||
      !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
    )
      return;

    const interactive = (e.target as HTMLElement | null)?.closest(
      'button, a, input, [role="button"]',
    );
    if (interactive) return;

    const target = (e.target as HTMLElement | null)?.closest('[data-tauri-drag-region]');
    if (target && target.getAttribute('data-tauri-drag-region') !== 'false') {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().startDragging();
      } catch (err) {
        console.error('Failed to start dragging:', err);
      }
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (showOnboarding && !showSettings) return;
    if (e.key === 'Escape' && showThemeQuickMenu) {
      showThemeQuickMenu = false;
      return;
    }

    if (e.key !== 'Escape') {
      lastIdleEscapeAt = 0;
    } else if (
      !e.repeat &&
      !e.defaultPrevented &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      !!sessionStore.activeSessionId &&
      !runStateStore.isBusy(sessionStore.activeSessionId) &&
      !showTimeTravel &&
      !showCommandPalette &&
      !showSettings &&
      !showThemeQuickMenu &&
      !document.querySelector('[aria-modal="true"], [role="menu"]')
    ) {
      const gesture = registerEligibleEscape(lastIdleEscapeAt, performance.now());
      lastIdleEscapeAt = gesture.nextAt;
      if (gesture.open) {
        e.preventDefault();
        showTimeTravel = true;
        return;
      }
    } else if (e.key === 'Escape') {
      lastIdleEscapeAt = 0;
    }

    if (shortcutStore.matches('toggle_palette', e)) {
      e.preventDefault();
      showCommandPalette = !showCommandPalette;
      return;
    }

    if (shortcutStore.matches('toggle_zen_mode', e)) {
      e.preventDefault();
      handleMenuAction('toggle_zen_mode');
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      if (notesStore.settings.enabled) showNotes = !showNotes;
      return;
    }

    if (shortcutStore.matches('settings', e)) {
      e.preventDefault();
      settingsInitialTab = undefined;
      settingsInitialAgentSection = undefined;
      showSettings = true;
    } else if (shortcutStore.matches('new_session', e)) {
      e.preventDefault();
      deviceStore.openCreator();
    } else if (shortcutStore.matches('focus_input', e)) {
      e.preventDefault();
      inputRef?.focus();
    }
  }

  async function requestSessionCompact() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to compact');
      return;
    }

    if (!activeComposerModel) {
      toastStore.error('Select a model before compacting');
      return;
    }
    try {
      const response = await apiFetch(apiUrl(`/api/sessions/${sessionId}/compact`), {
        method: 'POST',
        body: JSON.stringify({ model: activeComposerModel }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) throw new Error(data?.error ?? 'Compaction failed');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Compaction failed');
    }
  }

  function loadSuggestionIntoComposer(prompt: string) {
    composerDraft = prompt;
    inputRef?.focus();
  }

  let composerFilesRequest = 0;

  function composerWorkspaceKey(): string {
    const sessionId = sessionStore.activeSessionId;
    const session = sessionStore.sessions.find((item) => item.id === sessionId);
    return JSON.stringify([
      sessionId,
      session?.workingDirectory ?? projectStore.requestPath,
      session?.gitWorkspace?.path,
    ]);
  }

  // The execution context this feed is bound to, and whether auth has landed.
  //
  // This effect used to re-run on *any* invalidation of the signals it read and
  // do the work unconditionally. `authStore.isAuthenticated` reads `user`, which
  // `ensureSession()` reassigns on every single request it preflights — so this
  // effect fired once per in-flight API call, each time issuing two more
  // requests (/api/workspace/files and /api/git/status). That is a closed loop:
  // request → preflight → new `user` object → this effect → two more requests.
  // Measured 20 req/s idle, 8 of them `git status`, each spawning 8 git
  // subprocesses (~60 process spawns/second) at ~25% idle CPU.
  //
  // Compare the context and only act when it genuinely changes, with the whole
  // body untracked so incidental reads cannot re-arm it.
  let lastComposerContextKey = '';
  let lastComposerAuthenticated = false;
  $effect(() => {
    const authenticated = authStore.isAuthenticated;
    // Track execution context, not just source project: two chats can use
    // different checkouts of the same project.
    const contextKey = composerWorkspaceKey();
    untrack(() => {
      if (contextKey === lastComposerContextKey && authenticated === lastComposerAuthenticated) {
        return;
      }
      lastComposerContextKey = contextKey;
      lastComposerAuthenticated = authenticated;
      composerFilesRequest++;
      composerProjectFiles = [];
      gitStore.resetForContext();
      if (authenticated || isDemoMode) {
        void refreshComposerFileMentions();
        void gitStore.refreshStatus();
      }
    });
  });

  async function refreshComposerFileMentions(query = ''): Promise<string[]> {
    const key = composerWorkspaceKey();
    const request = ++composerFilesRequest;
    const isCurrent = () => request === composerFilesRequest && key === composerWorkspaceKey();
    const session = sessionStore.sessions.find((item) => item.id === sessionStore.activeSessionId);
    const fromContent = session?.gitWorkspace ? [] : extractProjectFiles(currentProjectContent);
    try {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const res = await apiFetch(apiUrl(`/api/workspace/files${qs}`));
      if (res.ok) {
        const data = await res.json();
        if (!isCurrent()) return [];
        if (data.ok && Array.isArray(data.data)) {
          composerProjectFiles = [...new Set([...fromContent, ...data.data])].sort((a, b) =>
            a.localeCompare(b),
          );
          return composerProjectFiles;
        }
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to fetch workspace file mentions:',
        err instanceof Error ? err.message : String(err),
      );
      // Workspace listing unavailable — use imported project content only
    }
    if (!isCurrent()) return [];
    composerProjectFiles = fromContent;
    return composerProjectFiles;
  }

  function extractProjectFiles(content: string): string[] {
    if (!content.trim()) return [];
    const unique = new Set<string>();

    const fileHeaderPattern = /^---\s+(.+?)\s+---$/gm;
    let match: RegExpExecArray | null;
    while ((match = fileHeaderPattern.exec(content)) !== null) {
      const candidate = match[1].trim();
      if (
        candidate &&
        !candidate.toLowerCase().startsWith('project structure') &&
        !candidate.toLowerCase().startsWith('file list')
      ) {
        unique.add(candidate);
      }
    }

    const fileListSection = content.match(/--- File List ---\n([\s\S]*)$/);
    if (fileListSection?.[1]) {
      for (const line of fileListSection[1].split('\n')) {
        const candidate = line.trim();
        if (candidate && !candidate.startsWith('...') && !candidate.startsWith('---')) {
          unique.add(candidate);
        }
      }
    }

    return Array.from(unique).slice(0, 500);
  }

  function resumePreviousChat() {
    const candidates = projectStore.currentPath
      ? sessionStore.sessionsForProject(projectStore.currentPath)
      : sessionStore.sessions;
    const previous = [...candidates]
      .filter((session) => session.id !== sessionStore.activeSessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (previous) sessionStore.activeSessionId = previous.id;
    else toastStore.info('No previous chat is available for this project');
  }

  function toggleAgentRail() {
    if (showAgents && !agentsDismissed) {
      showAgents = false;
      agentsDismissed = true;
    } else {
      showAgents = true;
      agentsDismissed = false;
    }
  }

  async function handleSlashCommand(command: string): Promise<boolean> {
    const parts = command.trim().slice(1).split(/\s+/).filter(Boolean);
    const root = parts[0]?.toLowerCase();

    if (!root) return false;

    if (root === 'help') {
      toastStore.info(
        'Commands: /new, /resume, /compact, /rewind, /activity, /workflow, /goal, /checklist, /clear, /settings, /theme, /sidebar, /zen',
      );
      return true;
    }

    if (root === 'new') {
      deviceStore.openCreator();
      return true;
    }

    if (root === 'resume') {
      resumePreviousChat();
      return true;
    }

    if (root === 'compact') {
      await requestSessionCompact();
      return true;
    }

    if (root === 'rewind') {
      if (parts.length > 1) toastStore.error('Usage: /rewind');
      else showTimeTravel = true;
      return true;
    }

    if (root === 'clear') {
      wsStore.clearFeed();
      toastStore.success('Current feed cleared');
      return true;
    }

    if (root === 'computer-use') {
      if (parts.length > 2) {
        toastStore.error('Usage: /computer-use [status]');
        return true;
      }
      if (parts[1] === 'status') {
        try {
          const response = await apiFetch(apiUrl('/api/v1/computer-use/status'));
          const payload = (await response.json()) as { ok?: boolean; data?: { platform?: string; available?: boolean; capabilities?: string[]; limitations?: string[] }; error?: string };
          if (!response.ok || !payload.ok || !payload.data) throw new Error(payload.error || 'Computer-use status unavailable');
          const state = payload.data.available ? 'available' : 'unavailable';
          toastStore.info(`${payload.data.platform ?? 'host'}: ${state}. Capabilities: ${(payload.data.capabilities ?? []).join(', ') || 'none'}. ${(payload.data.limitations ?? [])[0] ?? ''}`);
        } catch (error) {
          toastStore.error(error instanceof Error ? error.message : 'Computer-use status unavailable');
        }
        return true;
      }
      settingsInitialTab = 'agent';
      settingsInitialAgentSection = 'permissions';
      showSettings = true;
      return true;
    }

    if (root === 'settings') {
      settingsInitialTab = undefined;
      settingsInitialAgentSection = undefined;
      showSettings = true;
      return true;
    }

    if (root === 'theme') {
      showThemeQuickMenu = true;
      return true;
    }

    if (root === 'sidebar') {
      showSidebar = !showSidebar;
      return true;
    }

    if (root === 'zen') {
      handleMenuAction('toggle_zen_mode');
      return true;
    }

    if (root === 'activity' || root === 'agents') {
      if (parts.length > 1) {
        toastStore.error('Usage: /agents');
      } else {
        toggleAgentRail();
      }
      return true;
    }

    if (root === 'goal') {
      // Goal creation and goal detail both happen above the chat; the composer
      // bubble is the single Goal Mode surface.
      const request = parseGoalSlashCommand(parts.slice(1));
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent<GoalActionRequest>('kory:goal-action', { detail: request }),
        ),
      );
      return true;
    }

    if (root === 'checklist' || root === 'checklists') {
      // The docked list lives in the composer, so hand the request over the same
      // way /goal does instead of reaching into another component's state.
      const title = parts.slice(1).join(' ').trim();
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent<{ title: string }>('kory:checklist-action', { detail: { title } }),
        ),
      );
      return true;
    }

    if (root === 'workflow' || root === 'workflows') {
      workflowTask = parts.slice(1).join(' ') || composerDraft;
      showWorkflows = true;
      return true;
    }

    // Native CLI provider /command (e.g. Claude Code's /status, Devin's
    // /models): dispatch to the backend, which runs a real headless
    // equivalent (or surfaces an attributed note) and streams the reply back
    // as a native.command event labeled with the provider's name.
    const provider = providerFromModel(activeComposerModel);
    if (provider && NATIVE_CLI_PROVIDERS.has(provider) && nativeCommands) {
      const match = nativeCommands.commands.find(
        (c) => c.command === root || (c.aliases?.includes(root) ?? false),
      );
      if (match) {
        const sid = sessionStore.activeSessionId;
        if (sid) {
          void nativeCommandsStore.run(sid, command, activeComposerModel || undefined);
        }
        return true;
      }
    }

    // Unknown slash input: fall through and send it to the model as a
    // regular message. Other harnesses (Claude Code, etc.) treat unknown
    // /-prefixed text as normal user input, not commands — paths like
    // /home/user/project should reach the model, not error out.
    return false;
  }

  function loadLayoutPrefs() {
    try {
      const raw = localStorage.getItem(LAYOUT_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return;

      const maybe = parsed as Record<string, unknown>;
      if (typeof maybe.showSidebar === 'boolean') showSidebar = maybe.showSidebar;
      if (typeof maybe.showAgents === 'boolean') showAgents = maybe.showAgents;
      if (typeof maybe.agentsDismissed === 'boolean') agentsDismissed = maybe.agentsDismissed;
    } catch (err: unknown) {
      console.debug(
        'Failed to parse layout prefs from localStorage:',
        err instanceof Error ? err.message : String(err),
      );
      // Ignore malformed local prefs and fall back to defaults.
    }
  }

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      LAYOUT_PREFS_KEY,
      JSON.stringify({
        showSidebar,
        showAgents,
        agentsDismissed,
      }),
    );
  });

  async function readFolderFromTauri(folderPath: string): Promise<{
    title: string;
    text: string;
    folderName: string;
    fileCount: number;
    path: string;
  } | null> {
    try {
      const result = await invoke<{
        folder_name: string;
        files: Array<{ path: string; content?: string }>;
      }>('read_folder_contents', {
        folderPath,
      });

      const MAX_TOTAL_CHARS = 16000;
      let total = 0;
      const parts: string[] = [];

      for (const file of result.files) {
        if (total >= MAX_TOTAL_CHARS) break;
        if (file.content) {
          const slice =
            file.content.length + total > MAX_TOTAL_CHARS
              ? file.content.slice(0, MAX_TOTAL_CHARS - total)
              : file.content;
          total += slice.length;
          parts.push(`--- ${file.path} ---\n${slice}`);
        }
      }

      const fileList = result.files.map((f) => f.path).join('\n');
      if (fileList && total < MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - total;
        const listSlice =
          fileList.length > remaining
            ? fileList.slice(0, remaining) + '\n... (truncated)'
            : fileList;
        parts.push(`\n--- File List ---\n${listSlice}`);
      }

      const text = parts.join('\n\n');
      const title = `Project: ${result.folder_name}`.slice(0, 64);

      return {
        title,
        text,
        folderName: result.folder_name,
        fileCount: result.files.length,
        path: folderPath,
      };
    } catch (error) {
      console.error('Failed to read folder:', error);
      return null;
    }
  }

  /**
   * Resume the most recent session for `path`, or create a fresh one.
   * Returns the session id that is now active.
   */
  async function resumeOrCreateSession(path: string): Promise<string | null> {
    // Make sure the session list is fresh from the DB so we can search it.
    await sessionStore.fetchSessions();
    const existing = sessionStore.sessionsForProject(path);
    if (existing.length > 0) {
      // Resume the most-recently-updated session for this project.
      const latest = existing.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      sessionStore.activeSessionId = latest.id;
      return latest.id;
    }
    // No prior chats for this project — start a new one scoped to it. An
    // unscoped session here would trip the session reconciler into
    // deselecting the project the user just chose.
    return sessionStore.createSession({ workingDirectory: path });
  }

  /** Open a folder as a project. User explicitly selected this project
   *  → always start a fresh chat (launch resume is handled separately). */
  async function openProjectAtPath(
    path: string,
    fresh: { title: string; text: string; fileName?: string },
  ) {
    if (!(await selectAuthoritativeProject(path))) return;
    const newId = await sessionStore.createSession({ workingDirectory: path });
    if (newId) {
      void sessionStore.renameSession(newId, fresh.title);
      recentProjects = addRecentProject(recentProjects, {
        title: fresh.title,
        content: fresh.text,
        source: 'file',
        fileName: fresh.fileName,
        path,
      });
      currentProjectContent = fresh.text;
      void refreshComposerFileMentions();
      toastStore.success(`Opened ${projectDisplayName(path)} — new chat`);
    }
  }

  async function createProjectFromText(
    title: string,
    text: string,
    options?: { source?: RecentProject['source']; fileName?: string; path?: string },
  ) {
    const sessionId = await createProjectSession(title, text);
    if (!sessionId) return;

    recentProjects = addRecentProject(recentProjects, {
      title,
      content: text,
      source: options?.source ?? 'new',
      fileName: options?.fileName,
      path: options?.path,
    });
    currentProjectContent = text;
    void refreshComposerFileMentions();
    inputRef?.focus();
  }

  async function handleProjectFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const result = await readProjectFile(file);
      if (!result) {
        toastStore.error('Failed to read selected project file');
        return;
      }
      await createProjectFromText(result.title, result.text, {
        source: 'file',
        fileName: result.fileName,
      });
      if (result.truncated) {
        toastStore.warning('Large file imported; content was truncated for context size');
      } else {
        toastStore.success(`Imported ${file.name} into a new project`);
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to read selected project file:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Failed to read selected project file');
    } finally {
      input.value = '';
    }
  }

  async function handleProjectFolderSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files;
    if (!files?.length) return;

    try {
      const result = await readProjectFolder(files);
      if (!result) {
        toastStore.error('Failed to open project from folder');
        return;
      }
      await createProjectFromText(result.title, result.text, {
        source: 'file',
        fileName: result.folderName,
        path: result.folderName,
      });
      toastStore.success(
        `Opened project from folder: ${result.folderName} (${result.fileCount} files)`,
      );
    } catch (err: unknown) {
      console.warn(
        'Failed to open project from folder:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Failed to open project from folder');
    } finally {
      input.value = '';
    }
  }

  function removeRecentProjectEntry(id: string) {
    recentProjects = removeRecentProject(recentProjects, id);
  }

  async function openRecentProject(id: string) {    const found = recentProjects.find((p) => p.id === id);
    if (!found) {
      toastStore.error('Recent project not found');
      return;
    }

    // Recent entries with a real absolute path get full project scoping
    // (resume that folder's chats or start fresh); text-only briefs keep the
    // legacy behavior. (Web folder picks store a bare folder name, not a path.)
    if (found.path && (/^\//.test(found.path) || /^[A-Za-z]:[/\\]/.test(found.path))) {
      // Re-check existence at click time — the folder may have been deleted
      // after the list was loaded.
      const exists = await pathExists(found.path);
      if (!exists) {
        toastStore.error('Project folder no longer exists');
        recentProjects = await pruneRecentProjects(recentProjects);
        return;
      }
      await openProjectAtPath(found.path, {
        title: found.title,
        text: found.content,
        fileName: found.fileName,
      });
      return;
    }

    await createProjectFromText(found.title, found.content, {
      source: found.source,
      fileName: found.fileName,
    });
    toastStore.success(`Opened recent project: ${found.title}`);
  }

  // Themed replacement for the old native prompt() when naming a new project.
  let newProjectPrompt = $state<{ parentPath: string } | null>(null);
  let newProjectNameInput = $state('New Project');
  let newWorkspacePrompt = $state<{ parentPath: string } | null>(null);
  let newWorkspaceNameInput = $state('New Workspace');

  async function confirmNewProjectName() {
    const pending = newProjectPrompt;
    const projectName = newProjectNameInput.trim();
    if (!pending || !projectName) return;
    newProjectPrompt = null;
    try {
      const projectPath = await invoke<string>('create_project_folder', {
        parentPath: pending.parentPath,
        projectName,
      });
      toastStore.success(`Created project folder: ${projectPath}`);
      // Brand-new folder → scope future chats to it and start fresh.
      if (await selectAuthoritativeProject(projectPath)) {
        await createProjectFromText(projectName, buildNewProjectTemplate(), {
          source: 'new',
          path: projectPath,
        });
      }
    } catch (error) {
      toastStore.error(String(error));
    }
  }

  async function openWorkspaceAtPath(selectedPath: string) {
    const response = await apiFetch(apiUrl('/api/workspace/open'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: selectedPath }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      data?: WorkspaceNavigationSnapshot;
      error?: string;
    };
    if (!response.ok || !body.ok || !body.data) {
      toastStore.error(body.error || 'Workspace folder is unavailable');
      return false;
    }
    reconcileWorkspaceSnapshot(body.data);
    workspace.setLastReconciledSessionId('');
    sessionStore.activeSessionId = '';
    toastStore.success(
      `Opened workspace ${projectDisplayName(selectedPath)} with ${body.data.projects.length} project folders — choose a project to start chatting`,
    );
    return true;
  }

  async function handleNativeFolderSelected(
    selectedPath: string,
    mode: 'project' | 'workspace',
  ) {
    try {
      if (mode === 'workspace') await openWorkspaceAtPath(selectedPath);
      else await openProjectFolderAtPath(selectedPath);
    } catch (error) {
      toastStore.error(String(error));
    }
  }

  async function confirmNewWorkspaceName() {
    const pending = newWorkspacePrompt;
    const workspaceName = newWorkspaceNameInput.trim();
    if (!pending || !workspaceName) return;
    newWorkspacePrompt = null;
    try {
      const workspacePath = await invoke<string>('create_project_folder', {
        parentPath: pending.parentPath,
        projectName: workspaceName,
      });
      await openWorkspaceAtPath(workspacePath);
    } catch (error) {
      toastStore.error(String(error));
    }
  }

  async function openProjectFolderAtPath(selectedPath: string) {
    const result = await readFolderFromTauri(selectedPath);
    if (!result) {
      toastStore.error('Failed to open folder');
      return;
    }

    await openProjectAtPath(selectedPath, {
      title: result.title,
      text: result.text,
      fileName: result.folderName,
    });
  }

  /** Folder picker for "choose the folder you work in" (sidebar "+" and menu). */
  function openProjectFolderPicker() {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

    if (!inTauri) {
      projectFolderInput?.click();
      return;
    }

    deviceStore.openCreator('project');
  }

  async function selectProjectForQuickAction(path: string): Promise<boolean> {
    if (path === projectStore.currentPath) return true;
    const selected = await selectAuthoritativeProject(path);
    if (!selected) {
      toastStore.error('That project is no longer available. Refresh the workspace and try again.');
    }
    return selected;
  }

  async function openProjectIdentityFromQuickAction(encodedPath: string) {
    const path = decodeURIComponent(encodedPath);
    if (!(await selectProjectForQuickAction(path))) return;
    settingsInitialTab = 'project';
    settingsInitialAgentSection = undefined;
    showSettings = true;
  }

  async function openProjectFolderFromQuickAction(encodedPath: string) {
    const path = decodeURIComponent(encodedPath);
    if (!(await selectProjectForQuickAction(path))) return;
    toastStore.success(`Opened ${projectDisplayName(path)}`);
  }

  async function createProjectChatFromQuickAction(encodedPath: string) {
    const path = decodeURIComponent(encodedPath);
    if (!(await selectProjectForQuickAction(path))) return;
    const newId = await sessionStore.createSession({ workingDirectory: path });
    if (newId) toastStore.success(`New chat in ${projectDisplayName(path)}`);
  }

  async function handleMenuAction(action: string) {
    if (action.startsWith('goal_')) {
      // Goal Mode renders above the chat; the composer bubble handles every
      // non-create action itself.
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent<GoalActionRequest>('kory:goal-action', {
            detail: { action: action as GoalActionRequest['action'], source: 'palette' },
          }),
        ),
      );
      return;
    }
    switch (action) {
      case 'new_project': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

        if (!inTauri) {
          await createProjectFromText(
            `New Project ${new Date().toLocaleDateString()}`,
            buildNewProjectTemplate(),
            { source: 'new' },
          );
          break;
        }

        try {
          // Inside a workspace, new projects default to the workspace folder —
          // that's almost always where the user wants them.
          const selectedPath =
            projectStore.workspaceRoot ?? (await invoke<string | null>('select_folder_dialog'));
          if (!selectedPath) break;

          // Themed dialog (not a native prompt()) — see newProjectPrompt modal.
          newProjectNameInput = 'New Project';
          newProjectPrompt = { parentPath: selectedPath };
        } catch (error) {
          toastStore.error(String(error));
        }
        break;
      }
      case 'open_project_file':
        projectFileInput?.click();
        break;
      case 'open_project_folder':
        await openProjectFolderPicker();
        break;
      case 'open_workspace': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        if (!inTauri) {
          toastStore.error('Workspace folders require the desktop app');
          break;
        }
        deviceStore.openCreator('workspace');
        break;
      }
      case 'new_workspace': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        if (!inTauri) {
          toastStore.error('Workspace folders require the desktop app');
          break;
        }
        try {
          const parentPath = await invoke<string | null>('select_folder_dialog');
          if (!parentPath) break;
          newWorkspaceNameInput = 'New Workspace';
          newWorkspacePrompt = { parentPath };
        } catch (error) {
          toastStore.error(String(error));
        }
        break;
      }
      case 'new_session':
        deviceStore.openCreator();
        break;
      case 'resume_chat':
        resumePreviousChat();
        break;
      case 'focus_input':
        inputRef?.focus();
        break;
      case 'clear_feed':
        wsStore.clearFeed();
        toastStore.success('Current feed cleared');
        break;
      case 'toggle_agents':
        toggleAgentRail();
        break;
      case 'toggle_notes':
        if (notesStore.settings.enabled) showNotes = !showNotes;
        break;
      case 'toggle_theme':
        showThemeQuickMenu = true;
        break;
      case 'session_compact':
        requestSessionCompact();
        break;
      case 'open_time_travel':
        showTimeTravel = true;
        break;
      case 'toggle_sidebar':
        showSidebar = !showSidebar;
        break;
      case 'toggle_zen_mode':
        if (!zenMode) {
          showSidebarBeforeZen = showSidebar;
          showAgentsBeforeZen = showAgents;
          showSidebar = false;
          showAgents = false;
          zenMode = true;
        } else {
          zenMode = false;
          showSidebar = showSidebarBeforeZen;
          showAgents = showAgentsBeforeZen;
        }
        break;
      case 'open_settings':
        settingsInitialTab = undefined;
        settingsInitialAgentSection = undefined;
        showSettings = true;
        break;
      // The per-chat tracked-price popover links straight into the billing
      // section, so Settings has to be requestable with a specific pane.
      case 'open_settings_billing':
        settingsInitialTab = 'billing';
        settingsInitialAgentSection = undefined;
        showSettings = true;
        break;
      case 'link_device':
        settingsInitialTab = 'devices';
        settingsInitialAgentSection = undefined;
        showSettings = true;
        break;
      case 'toggle_palette':
        showCommandPalette = !showCommandPalette;
        break;
      case 'template_prd':
        insertPromptTemplate('prd', inputRef);
        break;
      case 'template_bugfix':
        insertPromptTemplate('bugfix', inputRef);
        break;
      case 'template_refactor':
        insertPromptTemplate('refactor', inputRef);
        break;
      case 'template_ship':
        insertPromptTemplate('ship', inputRef);
        break;
      default:
        if (action.startsWith('open_project_identity:')) {
          await openProjectIdentityFromQuickAction(action.slice('open_project_identity:'.length));
        } else if (action.startsWith('open_project_folder:')) {
          await openProjectFolderFromQuickAction(action.slice('open_project_folder:'.length));
        } else if (action.startsWith('new_project_chat:')) {
          await createProjectChatFromQuickAction(action.slice('new_project_chat:'.length));
        } else if (action.startsWith('open_recent:')) {
          await openRecentProject(action.slice('open_recent:'.length));
        } else if (action.startsWith('select_project:')) {
          const path = decodeURIComponent(action.slice('select_project:'.length));
          if (await selectAuthoritativeProject(path)) {
            const newId = await sessionStore.createSession({ workingDirectory: path });
            if (newId) toastStore.success(`Opened ${projectDisplayName(path)} — new chat`);
          }
        }
        break;
    }
  }

  // Session-scoped consent for remote CLI (agentic) providers that copy the
  // project to the host. Keyed by provider name.
  let agenticConsent = $state<Set<string>>(new Set());
  let agenticConsentPrompt = $state<{
    provider: string;
    hostName: string;
    pending: {
      message: string;
      model?: string;
      reasoningLevel?: string;
      attachments?: Array<{ type: string; data: string; name: string }>;
      fastMode?: boolean;
      imageInputMode?: ImageInputMode;
    };
  } | null>(null);

  async function confirmAgenticConsent() {
    const p = agenticConsentPrompt;
    if (!p) return;
    agenticConsent = new Set([...agenticConsent, p.provider]);
    agenticConsentPrompt = null;
    const sent = await handleSend(
      p.pending.message,
      p.pending.model,
      p.pending.reasoningLevel,
      p.pending.attachments,
      p.pending.fastMode,
      p.pending.imageInputMode,
    );
    if (sent) clearComposerDraftRequest += 1;
  }

  async function handleSend(
    message: string,
    model?: string,
    reasoningLevel?: string,
    attachments?: Array<{ type: string; data: string; name: string }>,
    fastMode?: boolean,
    imageInputMode?: ImageInputMode,
  ): Promise<boolean> {
    if (isDemoMode) {
      composerDraft = '';
      // Full demo: simulate a manager turn for the user's own prompt.
      // Guided demo: replay the scripted example turn.
      void import('$lib/demo.svelte').then((m) =>
        isFullDemo ? m.demoSend(message) : m.replayDemo(),
      );
      return true;
    }
    if (!projectStore.currentPath && !deviceStore.activeChat) {
      // Fail closed until the user chooses a current folder. Treating HOME as
      // an ephemeral project conflicted with authoritative workspace refresh:
      // the next snapshot correctly rejected the broad path and detached the
      // newly created session.
      noProjectPrompt = {
        message,
        model,
        reasoningLevel,
        attachments,
        fastMode,
        imageInputMode,
      };
      return false;
    }
    const configurationWarning = getModelConfigurationWarning(wsStore.providers, model);
    if (configurationWarning) {
      toastStore.error(configurationWarning);
      settingsInitialTab = 'providers';
      settingsInitialAgentSection = undefined;
      showSettings = true;
      return false;
    }
    // Remote CLI model: copies this project to the host to run there. Confirm
    // once per session so the client always knows their files are leaving.
    const providerName =
      parseProviderModelSelection(
        model,
        wsStore.providers.map((p) => p.name),
      ).provider ?? '';
    const remoteProvider = providerName
      ? wsStore.providers.find((p) => p.name === providerName)
      : undefined;
    if (remoteProvider?.remoteAgentic && !agenticConsent.has(providerName)) {
      agenticConsentPrompt = {
        provider: providerName,
        hostName: remoteProvider.remoteHostName ?? remoteProvider.label ?? 'the host',
        pending: { message, model, reasoningLevel, attachments, fastMode, imageInputMode },
      };
      return false;
    }
    if (!message.trim() && !(attachments && attachments.length > 0)) return false;

    // A first send can use an already selected project, but every chat needs
    // an explicit folder. Returning false preserves the composer draft.
    if (!sessionStore.activeSessionId) {
      if (!projectStore.currentPath) {
        deviceStore.openCreator();
        return false;
      }
      const createdSessionId = await sessionStore.newChat();
      if (!createdSessionId) return false;
    }
    const sessionId = sessionStore.activeSessionId;
    const agentId = agentRail.selectedAgentId;
    if (agentId) {
      // Sub-agents get the same controls as the manager: the composer's model
      // and reasoning pickers apply to the selected agent's next turn.
      return wsStore.sendAgentMessage(
        sessionId,
        agentId,
        message,
        model,
        reasoningLevel,
      );
    }
    return wsStore.sendMessage(
      sessionId,
      message,
      model,
      reasoningLevel,
      attachments,
      fastMode,
      imageInputMode,
    );
  }

  /** Steering is a cancel-then-continue handoff, not a second concurrent turn.
   * The websocket store waits for the captured cancellation to settle before
   * admitting the new instruction, so the provider never has two live turns
   * competing for the same session. */
  async function handleSteer(
    message: string,
    model?: string,
    reasoningLevel?: string,
    attachments?: Array<{ type: string; data: string; name: string }>,
    fastMode?: boolean,
    imageInputMode?: ImageInputMode,
  ): Promise<boolean> {
    if (isDemoMode) {
      void import('$lib/demo.svelte').then((m) => {
        m.demoStop();
        void m.demoSend(message);
      });
      return true;
    }
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return false;
    const agentId = agentRail.selectedAgentId;
    if (agentId) {
      if (!message.trim()) return false;
      try {
        await wsStore.cancelAgent(sessionId, agentId);
        return wsStore.sendAgentMessage(sessionId, agentId, message, model, reasoningLevel);
      } catch {
        return false;
      }
    }
    return wsStore.steerMessage(
      sessionId,
      message,
      model,
      reasoningLevel,
      attachments,
      fastMode,
      imageInputMode,
    );
  }

  function handleStop() {
    if (isDemoMode) {
      void import('$lib/demo.svelte').then((m) => m.demoStop());
      return;
    }
    const sessionId = sessionStore.activeSessionId;
    const agentId = agentRail.selectedAgentId;
    if (!sessionId) return;
    if (agentId) {
      // Capture both identities before the asynchronous request. A late
      // response belongs to this turn only and cannot cancel a replacement
      // turn in another session or agent thread.
      void wsStore.cancelAgent(sessionId, agentId).catch(() => undefined);
      return;
    }
    void wsStore.cancelSession(sessionId).catch(() => undefined);
  }

  let composerStopping = $derived(
    !!sessionStore.activeSessionId && wsStore.isCancellationPending(
      sessionStore.activeSessionId,
      agentRail.selectedAgentId || undefined,
    ),
  );

  let activeAgents = $derived(
    [...wsStore.agents.values()].filter(
      (a) =>
        a.identity.id !== 'kory-manager' &&
        a.identity.role !== 'manager' &&
        a.sessionId === sessionStore.activeSessionId &&
        a.status !== 'done' &&
        a.status !== 'idle',
    ),
  );
  let composerFileMentions = $derived(
    composerProjectFiles.length > 0
      ? composerProjectFiles
      : sessionStore.sessions.find((item) => item.id === sessionStore.activeSessionId)?.gitWorkspace
        ? []
        : extractProjectFiles(currentProjectContent),
  );
  let connectedProviders = $derived(
    wsStore.providers.filter((provider) => provider.connectionState === 'verified').length,
  );
  let connectionDot = $derived(
    isDemoMode
      ? 'bg-emerald-500'
      : wsStore.status === 'connected'
        ? 'bg-emerald-500'
        : wsStore.status === 'connecting'
          ? 'bg-amber-500 animate-pulse'
          : 'bg-red-500',
  );
  let connectionStatusLabel = $derived(
    isDemoMode
      ? 'Realtime online'
      : wsStore.status === 'connected'
        ? 'Realtime connected'
        : wsStore.status === 'connecting'
          ? 'Realtime connecting'
          : wsStore.status === 'error'
            ? 'Realtime connection error'
            : 'Realtime offline',
  );
</script>

<svelte:head>
  <title
    >{collaborationStore.activeJoinedSession
      ? `${collaborationStore.activeJoinedSession.sessionName} — Koryphaios`
      : projectStore.currentPath
        ? `${projectStore.displayName} — Koryphaios`
        : 'Koryphaios — Workspace'}</title
  >
</svelte:head>

<AppShell
  {showSidebar}
  {zenMode}
  modalOpen={showSettings || showOnboarding}
  showNotes={notesStore.settings.enabled && showNotes && !collaborationStore.activeJoinedSession && !deviceStore.activeChat}
  activeSessionId={sessionStore.activeSessionId}
  {connectionDot}
  {connectionStatusLabel}
  {connectedProviders}
  {recentProjects}
  onSidebarAction={handleMenuAction}
  onHideSidebar={() => (showSidebar = false)}
  onShowSidebar={() => (showSidebar = true)}
  onCloseNotes={() => (showNotes = false)}
  {startDragging}
>
  {#snippet menubar()}
    <MenuBar
      {showSidebar}
      {showAgents}
      {showNotes}
      notesEnabled={notesStore.settings.enabled}
      {zenMode}
      projectName={deviceStore.activeChat ? 'Micah’s agents' : collaborationStore.activeJoinedSession?.sessionName ?? projectStore.displayName}
      linkedDeviceName={deviceStore.activeChat?.deviceName}
      {activeAgents}
      {recentProjects}
      onAction={handleMenuAction}
    />
  {/snippet}

  {#snippet fileInputs()}
    <input
      bind:this={projectFileInput}
      type="file"
      class="hidden"
      accept=".txt,.md,.json,.yaml,.yml,.toml,.csv"
      onchange={handleProjectFileSelected}
    />
    <input
      bind:this={projectFolderInput}
      type="file"
      class="hidden"
      webkitdirectory
      multiple
      onchange={handleProjectFolderSelected}
    />
  {/snippet}

  {#snippet agentRailSlot()}
    {#if !collaborationStore.activeJoinedSession}<AgentRail
        rail={agentRail}
        visible={showAgents}
        forceHidden={agentsDismissed}
      />{/if}
  {/snippet}

  {#snippet feed()}
    {#if deviceStore.activeChat}
      <div class="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-secondary)]">
        <Monitor size={15} /><strong class="text-[var(--color-text-primary)]">Micah’s agents</strong>
        <span class="truncate">{deviceStore.activeChat.deviceName} · {deviceStore.activeChat.workspaceName}</span>
        {#if deviceStore.error}<span role="alert" class="text-[var(--color-error)]">{deviceStore.error}</span>{/if}
      </div>
    {/if}
    {#if collaborationStore.activeJoinedSession}
      <TeamWorkspace />
    {:else if projectStore.workspaceRoot && !sessionStore.activeSessionId}
      <WorkspaceNewChat
        onSelectFolder={(path) =>
          handleMenuAction(`select_project:${encodeURIComponent(path)}`).catch((error) =>
            toastStore.error(String(error)),
          )}
        onBrowseFolder={() => void handleMenuAction('open_project_folder')}
        onOpenWorkspace={() => void handleMenuAction('open_workspace')}
        onNewProject={() => void handleMenuAction('new_project')}
      />
    {:else if !projectStore.currentPath && !sessionStore.activeSessionId}
      <!--
        Welcome screen: centered within the FEED AREA, not the viewport.
        The previous `position: fixed; top: 50%` anchored to the viewport, so
        the card visually overlapped the menubar (top, 52px) and the composer
        (bottom, ~150px) as the window shrunk. Centering inside the feed
        container (flex items-center justify-center) makes the card respect
        the available area; overflow-y-auto lets it scroll when too tall, and
        min-h-0 ensures the flex item can actually shrink below its content
        height on very short windows.
      -->
      <div
        class="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-3 sm:p-4"
        style="background: var(--color-surface-1);"
      >
        <div
          class="w-full max-w-xl rounded-lg border px-4 py-5 text-center sm:px-5 sm:py-6"
          style="background: var(--color-surface-2); border-color: var(--color-border);"
        >
          <div class="mb-4">
            <img
              src="/logo-64.png"
              alt="Koryphaios"
              class="mx-auto rounded-lg opacity-90"
              style="width: 48px; height: 48px;"
            />
          </div>

          <h2 class="mb-2 text-xl font-semibold" style="color: var(--color-text-primary);">
            Open a project to start working
          </h2>
          <p
            class="mx-auto mb-5 max-w-md text-sm leading-relaxed"
            style="color: var(--color-text-secondary);"
          >
            Open a folder or choose a recent project to start a session.
          </p>

          {#if projectStore.unavailablePath}
            <div
              class="mb-4 rounded-lg border px-3 py-2.5 text-left"
              style="border-color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 10%, transparent);"
              role="status"
            >
              <div class="flex items-start gap-3">
                <AlertTriangle
                  size={18}
                  class="mt-0.5 shrink-0"
                  style="color: var(--color-warning);"
                />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold" style="color: var(--color-text-primary);">
                    Folder moved or deleted
                  </div>
                  <div class="mt-1 truncate text-xs" style="color: var(--color-text-secondary);">
                    {projectStore.unavailablePath}
                  </div>
                  <p class="mt-2 text-xs leading-relaxed" style="color: var(--color-text-muted);">
                    Koryphaios stopped using the stale path. Open its new location or choose one of
                    the current workspace folders below.
                  </p>
                  <button
                    type="button"
                    class="mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]"
                    style="border-color: var(--color-border); color: var(--color-text-secondary);"
                    onclick={() => void acknowledgeUnavailableProject()}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          {/if}

          <div class="mb-5 flex flex-col gap-1">
            <button
              type="button"
              class="flex items-center justify-center gap-3 rounded-md px-2 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-primary);"
              onclick={() => handleMenuAction('open_project_folder')}
            >
              <FolderOpen size={18} />
              <span>Open Folder</span>
            </button>

            <button
              type="button"
              class="flex items-center justify-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={() => handleMenuAction('open_workspace')}
            >
              <FolderPlus size={18} />
              <span>Open Workspace</span>
            </button>

            <button
              type="button"
              class="flex items-center justify-center gap-3 rounded-md px-2 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-primary);"
              onclick={() => handleMenuAction('new_project')}
            >
              <FolderPlus size={18} />
              <span>New Project</span>
            </button>
          </div>

          {#if projectStore.workspaceRoot || projectStore.openProjects.length > 0}
            <div class="mb-5 text-left">
              <div
                class="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.14em]"
                style="color: var(--color-text-muted);"
              >
                Projects
              </div>
              <div class="flex flex-wrap gap-2">
                {#if projectStore.workspaceRoot}
                  <button
                    type="button"
                    class="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
                    style="border-color: {projectStore.currentPath === projectStore.workspaceRoot
                      ? 'var(--color-accent)'
                      : 'var(--color-border)'}; color: var(--color-text-primary);"
                    onclick={() =>
                      handleMenuAction(
                        `select_project:${encodeURIComponent(projectStore.workspaceRoot ?? '')}`,
                      )}
                    title={projectStore.workspaceRoot}
                  >
                    {projectDisplayName(projectStore.workspaceRoot)} · workspace root
                  </button>
                {/if}
                {#each projectStore.openProjects as path (path)}
                  <button
                    type="button"
                    class="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
                    style="border-color: {projectStore.currentPath === path
                      ? 'var(--color-accent)'
                      : 'var(--color-border)'}; color: var(--color-text-primary);"
                    onclick={() => handleMenuAction(`select_project:${encodeURIComponent(path)}`)}
                    title={path}
                  >
                    {projectDisplayName(path)}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          {#if recentProjects.length > 0}
            <div class="text-left">
              <div class="mb-2 flex items-center gap-2 px-1">
                <Clock size={14} style="color: var(--color-text-muted);" />
                <span
                  class="text-xs font-semibold uppercase tracking-[0.14em]"
                  style="color: var(--color-text-muted);">Recent projects</span
                >
              </div>
              <div class="flex flex-col gap-1">
              {#each recentProjects.slice(0, 5) as project (project.id)}
                <div
                  role="button"
                  tabindex="0"
                  class="flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-primary); border-color: var(--color-border); background: var(--color-surface-1);"
                  onclick={() => handleMenuAction(`open_recent:${project.id}`)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') handleMenuAction(`open_recent:${project.id}`);
                  }}
                  title={project.path || project.fileName || project.title}
                >
                  <button
                    type="button"
                    class="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-muted);"
                    onclick={(e) => {
                      e.stopPropagation();
                      removeRecentProjectEntry(project.id);
                    }}
                    title="Remove from recent projects"
                    aria-label={`Remove ${project.title} from recent projects`}
                  >
                    <X size={13} />
                  </button>
                  <span class="truncate font-medium flex-1">{project.title}</span>
                    <span
                      class="shrink-0 text-xs truncate max-w-[150px]"
                      style="color: var(--color-text-muted);"
                    >
                      {project.path
                        ? project.path.split('/').pop() || project.path.split('\\').pop()
                        : project.fileName || ''}
                    </span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {:else if gitStore.state.activeDiff}
      <DiffEditor {zenMode} />
    {:else if agentRail.selectedAgent}
      <AgentThreadFeed
        agent={agentRail.selectedAgent}
        feed={agentRail.selectedAgentFeed}
        isStreaming={agentRail.selectedAgentIsRunning}
        onClose={() => void agentRail.closeAgent(agentRail.selectedAgentId)}
      />
    {:else}
      <ManagerFeed onUseSuggestion={loadSuggestionIntoComposer} centered={startWindowOnly} />
    {/if}
  {/snippet}

  {#snippet contextBar()}
    {#if !startWindowOnly}
    <!-- Context occupancy is informational (not cost tracking) — ALWAYS visible
         for an open session: known window → segmented bar; unknown window →
         tokens-used with an explicit "window unknown" label; no data yet →
         muted awaiting state. Never silently absent. -->
    {#if !collaborationStore.activeJoinedSession && (deviceStore.activeChat || projectStore.currentPath) && sessionStore.activeSessionId}
      <div
        class="context-bar shrink-0 px-2 sm:px-4"
        style="container-type: inline-size; padding-top: var(--space-2); padding-bottom: var(--space-2); border-top: 1px solid var(--color-border); background: var(--color-surface-1);"
        role="group"
        onmouseenter={() => (contextBarHover = true)}
        onmouseleave={() => (contextBarHover = false)}
      >
        <div class="context-bar-summary flex min-w-0 items-center gap-2 sm:gap-3" role="group" aria-label="Context window usage">
          <span
            class="w-[74px] shrink-0 context-bar-label"
            style="font-size: var(--text-xs); color: var(--color-text-muted);"
            title="How much of the model's context window this session is using. The bar splits that total by what fills it. Hover to see every part."
          >
            Context
          </span>
          <div
            class="relative min-w-8 flex-1 rounded-full overflow-hidden flex context-bar-meter"
            style="height: 6px; background: var(--color-surface-3);"
          >
            {#if !wsStore.contextUsage.isReliable}
              <div
                class="h-full rounded-full"
                style="width: 100%; background: var(--color-surface-4, var(--color-surface-3)); opacity: 0.5;"
              ></div>
            {:else if contextSegments}
              {#each contextSegments as seg (seg.key)}
                <div
                  class="h-full transition-all"
                  title="{seg.label}: ~{formatTokenCount(seg.tokens)} tokens. {seg.hint}"
                  style="width: {seg.widthPercent}%; transition-duration: var(--duration-slower); background: {seg.color};"
                ></div>
              {/each}
            {:else}
              <div
                class="h-full rounded-full transition-all"
                style="width: {wsStore.contextUsage
                  .percent}%; transition-duration: var(--duration-slower); background: {wsStore
                  .contextUsage.percent > 85
                  ? '#ef4444'
                  : wsStore.contextUsage.percent > 65
                    ? '#f59e0b'
                    : 'var(--color-accent)'};"
              ></div>
            {/if}
          </div>
          {#if wsStore.contextUsage.isReliable && wsStore.contextUsage.max > 0}
            <span
              class="shrink-0 tabular-nums context-bar-value"
              style="font-size: var(--text-xs); color: {!wsStore.contextUsage.estimated && wsStore.contextUsage.percent > 85
                ? '#ef4444'
                : 'var(--color-text-muted)'};"
            >
              {#if wsStore.contextUsage.estimated}
                ~{formatTokenCount(wsStore.contextUsage.used)} / {formatTokenCount(wsStore.contextUsage.max)}
                estimate
              {:else}
                {formatTokenCount(wsStore.contextUsage.used)} / {formatTokenCount(wsStore.contextUsage.max)}
              {/if}
            </span>
          {:else if wsStore.contextUsage.used > 0}
            <span
              class="shrink-0 tabular-nums context-bar-value"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title={wsStore.contextUsage.estimated
                ? 'The provider reported turn-level usage, but did not establish exact live occupancy or a verified window.'
                : 'The provider reported usage but no verified window size for this model.'}
            >
              {#if wsStore.contextUsage.estimated}
                live context not reported · window unknown
              {:else}
                {formatTokenCount(wsStore.contextUsage.used)} used · window not reported by provider
              {/if}
            </span>
          {:else if wsStore.contextUsage.reason === 'usage_unknown' && wsStore.contextUsage.max > 0}
            <span
              class="shrink-0 tabular-nums context-bar-value"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title="Verified {formatTokenCount(wsStore.contextUsage.max)} window. Usage appears after the provider's first token report."
            >
              {formatTokenCount(wsStore.contextUsage.max)} window · usage not yet reported
            </span>
          {:else if wsStore.contextUsage.reason === 'context_unknown'}
            <span
              class="shrink-0 tabular-nums context-bar-value"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title="The selected provider or CLI did not report a verified context-window size for this model."
            >
              usage and model window not reported
            </span>
          {:else}
            <span
              class="shrink-0 context-bar-value"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title="Waiting for the selected provider or CLI to report an authoritative token count. Local character estimates are intentionally not shown as token truth."
            >
              awaiting provider token report
            </span>
          {/if}
        </div      >
        {#if contextSegments && contextBarHover}
          <div class="flex items-center gap-4 flex-wrap" style="padding-top: var(--space-2);">
            {#each contextSegments as seg (seg.key)}
              <span
                class="flex items-center gap-1.5"
                style="font-size: var(--text-xs); color: var(--color-text-muted);"
              >
                <span
                  class="rounded-full inline-block"
                  style="width: 8px; height: 8px; background: {seg.color};"
                ></span>
                {seg.label}
                <span class="tabular-nums">~{formatTokenCount(seg.tokens)}</span>
              </span>
            {/each}
            {#if !wsStore.contextUsage.estimated}
              <span style="font-size: var(--text-xs); color: var(--color-text-muted);">
                Free {formatTokenCount(Math.max(0, wsStore.contextUsage.max - wsStore.contextUsage.used))}
              </span>
            {/if}
          </div>
        {/if}
        {#if wsStore.contextUsage.estimated}
          <div style="padding-top: var(--space-1); font-size: var(--text-xs); color: var(--color-text-muted);">
            Provider totals may span multiple internal requests · category breakdown is estimated
          </div>
        {/if}
        {#if contextCache.label}
          <div title={contextCache.hint} style="padding-top: var(--space-1); font-size: var(--text-xs); color: var(--color-text-muted);">
            {contextCache.label}
          </div>
        {/if}
        <!-- Cache health sits in its own group under a hairline so the context
             meter stays the one thing read at a glance. The per-turn receipt
             is the only part visible by default; the harness/30d breakdown is
             hover-only, and every part of it is omitted while it reads zero. -->
        {#if cacheTurnReceipt || (contextBarHover && (cacheFabricLabel || cacheLastBust || cacheProviderScorecard.length > 0))}
          <div
            class="flex flex-col gap-1"
            style="margin-top: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--color-border); font-size: var(--text-xs); color: var(--color-text-muted);"
          >
            {#if cacheTurnReceipt}
              <div class="flex items-baseline gap-3">
                <span class="w-[74px] shrink-0">Cache</span>
                <span class="min-w-0 truncate" title={contextCache.label ? contextCache.hint : cacheTurnReceipt}>
                  {cacheTurnReceipt}
                </span>
              </div>
            {/if}
            {#if contextBarHover && (cacheFabricLabel || cacheLastBust)}
              <div class="flex items-baseline gap-3" title={cacheDiagnosticsNotice}>
                <span class="w-[74px] shrink-0">Cache fabric</span>
                <span class="min-w-0 truncate">
                  {cacheFabricLabel ?? ''}{#if cacheLastBust}<span class="opacity-60"
                      >· last bust: {cacheLastBust}</span
                    >{/if}
                </span>
              </div>
            {/if}
            {#if contextBarHover && cacheProviderScorecard.length > 0}
              <div class="flex items-baseline gap-3" title={cacheDiagnosticsNotice}>
                <span class="w-[74px] shrink-0">30d cache</span>
                <div class="flex flex-wrap gap-x-4 gap-y-0.5 min-w-0">
                  {#each cacheProviderScorecard as card (card.provider)}
                    <span class="flex items-baseline gap-1.5" title={card.tooltip}>
                      <span style="color: var(--color-text-secondary);">{card.provider}</span>
                      {#if card.hitRateLabel}<span class="tabular-nums">{card.hitRateLabel}</span>{/if}
                      {#if card.savingsLabel}<span class="tabular-nums">{card.savingsLabel}</span>{/if}
                      {#if card.ttftLabel}<span class="tabular-nums opacity-60">{card.ttftLabel}</span>{/if}
                    </span>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {/if}
  {/snippet}

  {#snippet composer()}
    {#if !startWindowOnly && !collaborationStore.activeJoinedSession && (deviceStore.activeChat || !(projectStore.workspaceRoot && !sessionStore.activeSessionId))}
      <WorkflowPanel
        open={showWorkflows}
        sessionId={sessionStore.activeSessionId}
        initialTask={workflowTask}
        onclose={() => (showWorkflows = false)}
        onchange={() => void refreshActiveWorkflow()}
      />
      <CommandInput
        bind:inputRef
        bind:value={composerDraft}
        draftKey={sessionStore.activeSessionId || 'welcome'}
        clearDraftRequest={clearComposerDraftRequest}
        onSend={handleSend}
        onSteer={handleSteer}
        onExecuteCommand={handleSlashCommand}
         isRunning={agentRail.selectedAgent
           ? agentRail.selectedAgentIsRunning
           : runStateStore.isRunning(sessionStore.activeSessionId)}
         isStopping={composerStopping}
        isWaiting={!agentRail.selectedAgent &&
          runStateStore.isWaiting(sessionStore.activeSessionId)}
        waitingReason={runStateStore.getWaitingReason(sessionStore.activeSessionId)}
        onStop={handleStop}
        onOpenSettings={(section, agentSection) => {
          settingsInitialTab =
            section === 'advanced' ? 'experimental' : section === 'agent' ? 'agent' : 'providers';
          settingsInitialAgentSection = agentSection;
          showSettings = true;
        }}
        onOpenWorkflows={() => {
          workflowTask = composerDraft;
          showWorkflows = true;
        }}
        workflowStatus={activeWorkflow}
        slashCommands={composerSlashCommandList}
        fileMentions={composerFileMentions}
        onRefreshFileMentions={refreshComposerFileMentions}
        placeholder={agentRail.inputPlaceholder}
        initialModel={isDemoMode ? 'codex:gpt-5.6-sol' : ''}
        disableModelPreviewRequests={isDemoMode || !!deviceStore.activeChat}
        bind:selectedModel={activeComposerModel}
        bind:selectedReasoningLevel={activeComposerReasoning}
        forcedModel={agentRail.selectedAgent
          ? `${agentRail.selectedAgent.identity.provider}:${agentRail.selectedAgent.identity.model}`
          : ''}
        {interactionMode}
        {planReady}
        onInteractionModeChange={async (mode) => {
          if (isGuidedDemo) {
            toastStore.info('Not available in this demo');
            return;
          }
          if (!sessionStore.activeSessionId) return;
          if (await sessionStore.setInteractionMode(sessionStore.activeSessionId, mode)) {
            toastStore.info(
              mode === 'plan' ? 'Plan mode active — project writes are blocked' : 'Act mode active',
            );
          }
        }}
        onApprovePlan={async () => {
          const session = sessionStore.sessions.find(
            (item) => item.id === sessionStore.activeSessionId,
          );
          if (!session || !planReady) return;
          if (!(await sessionStore.setInteractionMode(session.id, 'act'))) return;
          const objective = originalPlanRequest(wsStore.feed, session.title);
          handleSend(
            implementationPrompt(objective, currentPlanText),
            activeComposerModel || undefined,
          );
        }}
      />
    {/if}
  {/snippet}

  {#snippet backgroundShells()}
    {#if !isDemoMode && !collaborationStore.activeJoinedSession && sessionStore.activeSessionId}
      <BackgroundShells sessionId={sessionStore.activeSessionId} />
    {/if}
  {/snippet}
</AppShell>

<PermissionDialog />
<QuestionDialog />
<TimeTravelPanel bind:open={showTimeTravel} />
<RewindDialog />
{#if saveFinding}
  <SaveFindingDialog finding={saveFinding} onClose={() => (saveFinding = null)} />
{/if}

{#if !showGitConflicts && gitStore.state.conflicts.length > 0}
  <button
    type="button"
    class="fixed bottom-5 right-5 z-[80] flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold shadow-lg transition-colors hover:bg-[var(--color-surface-3)]"
    style="background: var(--color-error-bg); border-color: color-mix(in srgb, var(--color-error) 35%, var(--color-border)); color: var(--color-error);"
    aria-label={`Review ${gitStore.state.conflicts.length} unresolved Git conflict${gitStore.state.conflicts.length === 1 ? '' : 's'}`}
    onclick={() => (showGitConflicts = true)}
  >
    <AlertTriangle size={15} aria-hidden="true" />
    <span>Unresolved Git conflicts</span>
    <span
      class="min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px]"
      style="background: color-mix(in srgb, var(--color-error) 16%, transparent);"
    >
      {gitStore.state.conflicts.length}
    </span>
  </button>
{/if}
{#if showGitConflicts && gitStore.state.conflicts.length > 0}
  <GitConflictDialog
    conflicts={gitStore.state.conflicts}
    onClose={() => (showGitConflicts = false)}
  />
{/if}
<ThemePickerModal open={showThemeQuickMenu} onClose={() => (showThemeQuickMenu = false)} />

{#if noProjectPrompt}
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="alertdialog"
      aria-label="No project open"
    >
      <h3 class="text-base font-semibold mb-2" style="color: var(--color-text-primary);">
        No project open
      </h3>
      <p class="text-sm mb-5 leading-relaxed" style="color: var(--color-text-secondary);">
        The agent works inside a current project folder. Choose one so file access, sessions, and
        workspace refresh all stay scoped to the same location.
      </p>
      <div class="flex flex-col gap-2">
        <button
          type="button"
          class="w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors"
          style="background: var(--color-accent); color: var(--color-surface-0);"
          onclick={() => {
            composerDraft = noProjectPrompt?.message ?? '';
            noProjectPrompt = null;
            handleMenuAction('open_project_folder');
          }}
        >
          Choose Project Folder…
        </button>
        <button
          type="button"
          class="w-full rounded-xl px-4 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => {
            composerDraft = noProjectPrompt?.message ?? '';
            noProjectPrompt = null;
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

{#if newProjectPrompt}
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="dialog"
      aria-label="Name your project"
    >
      <h3 class="text-base font-semibold mb-2" style="color: var(--color-text-primary);">
        Name your project
      </h3>
      <p class="text-sm mb-4 leading-relaxed" style="color: var(--color-text-secondary);">
        A folder with this name will be created in {newProjectPrompt.parentPath}.
      </p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="input w-full text-sm mb-4"
        bind:value={newProjectNameInput}
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') void confirmNewProjectName();
          if (e.key === 'Escape') newProjectPrompt = null;
        }}
      />
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => (newProjectPrompt = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
          style="background: var(--color-accent); color: var(--color-surface-0);"
          disabled={!newProjectNameInput.trim()}
          onclick={() => void confirmNewProjectName()}
        >
          Create Project
        </button>
      </div>
    </div>
  </div>
{/if}

{#if newWorkspacePrompt}
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="dialog"
      aria-label="Name your workspace"
    >
      <h3 class="mb-2 text-base font-semibold" style="color: var(--color-text-primary);">
        Name your workspace
      </h3>
      <p class="mb-4 text-sm leading-relaxed" style="color: var(--color-text-secondary);">
        A workspace folder with this name will be created in {newWorkspacePrompt.parentPath}.
      </p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="input mb-4 w-full text-sm"
        bind:value={newWorkspaceNameInput}
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') void confirmNewWorkspaceName();
          if (e.key === 'Escape') newWorkspacePrompt = null;
        }}
      />
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => (newWorkspacePrompt = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
          style="background: var(--color-accent); color: var(--color-surface-0);"
          disabled={!newWorkspaceNameInput.trim()}
          onclick={() => void confirmNewWorkspaceName()}
        >
          Create Workspace
        </button>
      </div>
    </div>
  </div>
{/if}

{#if agenticConsentPrompt}
  <div
    class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
  >
    <div
      class="w-full max-w-md rounded-2xl border p-6 shadow-2xl"
      style="background: var(--color-surface-2); border-color: var(--color-border);"
      role="alertdialog"
      aria-label="Remote CLI model"
    >
      <h3 class="text-base font-semibold mb-2" style="color: var(--color-text-primary);">
        This model runs on {agenticConsentPrompt.hostName}
      </h3>
      <p class="text-sm mb-3 leading-relaxed" style="color: var(--color-text-secondary);">
        It's a CLI tool, so it runs on the host's computer — not yours. To do that,
        <strong>your project files are copied to a temporary folder on the host</strong> each turn, the
        CLI edits them there, and the changes are written back to your project here.
      </p>
      <p class="text-xs mb-5 leading-relaxed" style="color: var(--color-text-muted);">
        Only text files are sent (node_modules, .git, and build output are skipped). Regular API
        models never do this — their files stay on your machine.
      </p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => (agenticConsentPrompt = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-xl px-4 py-2 text-sm font-semibold transition-colors"
          style="background: var(--color-accent); color: var(--color-surface-0);"
          onclick={() => void confirmAgenticConsent()}
        >
          Send my files &amp; run
        </button>
      </div>
    </div>
  </div>
{/if}

  <DeviceNewChat onAction={handleMenuAction} onSelectFolder={handleNativeFolderSelected} />
{#if showOnboarding}
  <OnboardingWalkthrough
    suspended={showSettings}
    onOpenProviders={() => {
      settingsInitialTab = 'providers';
      settingsInitialAgentSection = undefined;
      showSettings = true;
    }}
    onOpenDevices={() => {
      settingsInitialTab = 'devices';
      settingsInitialAgentSection = undefined;
      showSettings = true;
    }}
  />
{/if}
<SettingsDrawer
  open={showSettings}
  initialTab={settingsInitialTab}
  initialAgentSection={settingsInitialAgentSection}
  onClose={() => {
    showSettings = false;
    settingsInitialTab = undefined;
    settingsInitialAgentSection = undefined;
  }}
/>
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />
