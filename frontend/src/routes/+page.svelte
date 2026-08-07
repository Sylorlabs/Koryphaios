<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { isDemoMode, isFullDemo, isGuidedDemo } from '$lib/demo.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import AgentThreadFeed from '$lib/components/AgentThreadFeed.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import RewindDialog from '$lib/components/RewindDialog.svelte';
  import TimeTravelPanel from '$lib/components/TimeTravelPanel.svelte';
  import ChangesSummary from '$lib/components/ChangesSummary.svelte';
  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import WorkflowPanel from '$lib/components/WorkflowPanel.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
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
  import { FolderOpen, FolderPlus, Clock } from 'lucide-svelte';
  import TeamWorkspace from '$lib/components/TeamWorkspace.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import {
    type RecentProject,
    parseRecentProjects,
    addRecentProject,
    buildNewProjectTemplate,
    createProjectSession,
    readProjectFile,
    readProjectFolder,
    insertPromptTemplate,
  } from '$lib/utils/projectManager';
  import { getModelConfigurationWarning } from '$lib/utils/model-config';
  import { registerEligibleEscape } from '$lib/utils/double-escape';
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

  let showSettings = $state(false);
  let showAgents = $state(false);
  let agentsDismissed = $state(false);
  let showSidebar = $state(true);
  let showNotes = $state(false);
  let showSidebarBeforeZen = $state(true);
  let showAgentsBeforeZen = $state(false);
  let showCommandPalette = $state(false);
  let showThemeQuickMenu = $state(false);
  let showTimeTravel = $state(false);
  let showWorkflows = $state(false);
  let workflowTask = $state('');
  let activeWorkflow = $state<
    { name: string; stage: string; status: string; task: string } | undefined
  >();
  let lastIdleEscapeAt = 0;
  let zenMode = $state(false);
  let settingsInitialTab = $state<'providers' | 'agent' | 'experimental'>('providers');
  let settingsInitialAgentSection = $state<'permissions' | undefined>(undefined);
  let inputRef = $state<HTMLTextAreaElement>();
  let projectFileInput = $state<HTMLInputElement>();
  let projectFolderInput = $state<HTMLInputElement>();
  let recentProjects = $state<RecentProject[]>([]);
  let composerDraft = $state('');
  let interactionMode = $derived(
    sessionStore.sessions.find((session) => session.id === sessionStore.activeSessionId)
      ?.interactionMode ?? 'act',
  );
  let currentPlanText = $derived(latestPlanText(wsStore.feed));
  let planReady = $derived(validatePlanReadiness(currentPlanText).ready);
  let currentProjectContent = $state('');
  let composerProjectFiles = $state<string[]>([]);
  let contextBarHover = $state(false);
  // Set when the user tries to send without a project open — holds the pending
  // message so it can be dispatched after they pick a project or opt into home.
  let noProjectPrompt = $state<{
    message: string;
    model?: string;
    reasoningLevel?: string;
    attachments?: Array<{ type: string; data: string; name: string }>;
    fastMode?: boolean;
  } | null>(null);

  // Segmented context bar: what's occupying the window (system prompt, memory
  // notes, tool defs, chat history). Segment ratios come from the backend's
  // dispatch-time estimate; the TOTAL width stays pinned to the provider's real
  // token count so estimates can't overstate usage.
  const CONTEXT_SEGMENTS = [
    { key: 'system', label: 'System', color: '#8b5cf6' },
    { key: 'memory', label: 'Memory', color: '#14b8a6' },
    { key: 'tools', label: 'Tools', color: '#f59e0b' },
    { key: 'chat', label: 'Chat', color: '#3b82f6' },
  ] as const;

  let contextSegments = $derived.by(() => {
    const usage = wsStore.contextUsage;
    const b = usage.breakdown;
    if (!b || !usage.isReliable || usage.max <= 0) return null;
    const sum = b.system + b.memory + b.tools + b.chat;
    if (sum <= 0) return null;
    // Unrounded percent — the store's integer percent collapses small
    // sessions' segments to zero width.
    const percentFloat = Math.min(100, (usage.used / usage.max) * 100);
    if (usage.used > sum) {
      // Provider reports MORE than we composed: the gap is the provider's own
      // harness overhead (e.g. Claude Code's system prompt + native tool
      // defs). Show each segment at its true estimate plus an explicit
      // "Provider harness" segment — never smear the gap across our segments.
      const harness = usage.used - sum;
      const perToken = percentFloat / usage.used;
      return [
        ...CONTEXT_SEGMENTS.map((s) => ({
          ...s,
          tokens: b[s.key],
          widthPercent: b[s.key] * perToken,
        })),
        {
          key: 'harness',
          label: 'Provider harness',
          color: '#9ca3af',
          tokens: harness,
          widthPercent: harness * perToken,
        },
      ].filter((s) => s.tokens > 0);
    }
    return CONTEXT_SEGMENTS.map((s) => {
      const share = b[s.key] / sum;
      return {
        ...s,
        tokens: Math.round(usage.used * share),
        widthPercent: percentFloat * share,
      };
    }).filter((s) => s.tokens > 0);
  });

  function formatTokenCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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
      console.warn('Failed to refresh active workflow:', err instanceof Error ? err.message : String(err));
      activeWorkflow = undefined;
    }
  }

  $effect(() => {
    void refreshActiveWorkflow();
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
    { command: 'theme', label: 'Theme Picker', description: 'Open theme selection.' },
    { command: 'sidebar', label: 'Toggle Sidebar', description: 'Show or hide the sidebar.' },
    { command: 'zen', label: 'Toggle Zen', description: 'Enter or exit zen mode.' },
    { command: 'goal', label: 'Goal Mode', description: 'Open durable goals and their progress.' },
    {
      command: 'workflow',
      label: 'Workflows',
      description: 'Attach a host-owned workflow to the current task.',
    },
    {
      command: 'agents',
      label: 'Toggle subagents',
      description: 'Show or hide the current worker and critic agents above the chat.',
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
  // active CLI provider's own /commands in the slash picker.
  let activeComposerModel = $state<string>('');
  let lastComposerTarget = $state('');
  let nativeCommands = $state<{ label: string; commands: NativeSlashCommand[] } | null>(null);

  // A worker tab is a direct conversation with that worker. Keep the composer
  // identity truthful when the tab changes so a Gemini/Claude worker never
  // appears to be running the manager's Codex model. A manual model choice is
  // preserved until the user changes tabs again.
  $effect(() => {
    const agent = agentRail.selectedAgent;
    const target = agent
      ? `agent:${agent.identity.id}:${agent.identity.provider}:${agent.identity.model}`
      : 'manager';
    if (target === lastComposerTarget) return;
    lastComposerTarget = target;
    activeComposerModel = agent
      ? `${agent.identity.provider}:${agent.identity.model}`
      : isDemoMode
        ? 'codex:gpt-5.6-sol'
        : '';
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
      appStore.initialize(authStore, sessionStore).then(() => {
        if (authStore.isAuthenticated) {
          wsStore.connect();
        }
        if (projectStore.currentPath) {
          void refreshComposerFileMentions();
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
    recentProjects = parseRecentProjects();
    loadLayoutPrefs();

    window.addEventListener('keydown', handleGlobalKeydown);

    const handleOpenNote = async (e: Event) => {
      if (!notesStore.settings.enabled) return;
      const title = (e as CustomEvent<{ title: string }>).detail?.title;
      if (!title) return;
      showNotes = true;
      await notesStore.openNoteByTitle(title);
    };
    window.addEventListener('open-note', handleOpenNote);

    const handleOpenNotesGraph = () => {
      if (!notesStore.settings.enabled) return;
      showNotes = true;
    };
    window.addEventListener('open-notes-graph', handleOpenNotesGraph);
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

    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('open-note', handleOpenNote);
      window.removeEventListener('open-notes-graph', handleOpenNotesGraph);
      window.removeEventListener('open-team-settings', handleOpenTeamSettings);
      window.removeEventListener(
        'open-provider-account-settings',
        handleOpenProviderAccountSettings,
      );
      window.removeEventListener('open-team-settings', handleOpenTeamSettings);
      window.removeEventListener('kory:focus-input', handleFocusInput);
    };
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
      showSettings = true;
    } else if (shortcutStore.matches('new_session', e)) {
      e.preventDefault();
      void sessionStore.newChat({ shift: e.shiftKey });
      inputRef?.focus();
    } else if (shortcutStore.matches('focus_input', e)) {
      e.preventDefault();
      inputRef?.focus();
    } else if (shortcutStore.matches('close', e) && showSettings) {
      showSettings = false;
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

  async function refreshComposerFileMentions(query = ''): Promise<string[]> {
    const fromContent = extractProjectFiles(currentProjectContent);
    try {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const res = await apiFetch(apiUrl(`/api/workspace/files${qs}`));
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.data)) {
          composerProjectFiles = [...new Set([...fromContent, ...data.data])].sort((a, b) =>
            a.localeCompare(b),
          );
          return composerProjectFiles;
        }
      }
    } catch (err: unknown) {
      console.warn('Failed to fetch workspace file mentions:', err instanceof Error ? err.message : String(err));
      // Workspace listing unavailable — use imported project content only
    }
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
        'Commands: /new, /resume, /compact, /rewind, /agents, /workflow, /goal, /clear, /settings, /theme, /sidebar, /zen',
      );
      return true;
    }

    if (root === 'new') {
      await sessionStore.newChat();
      inputRef?.focus();
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

    if (root === 'settings') {
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

    if (root === 'agents') {
      if (parts.length > 1) {
        toastStore.error('Usage: /agents');
      } else {
        toggleAgentRail();
      }
      return true;
    }

    if (root === 'goal') {
      goalDisplayStore.update({ sidebar: true });
      const request = parseGoalSlashCommand(parts.slice(1));
      queueMicrotask(() =>
        window.dispatchEvent(
          new CustomEvent<GoalActionRequest>('kory:goal-action', { detail: request }),
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
    } catch (err: unknown) {
      console.debug('Failed to parse layout prefs from localStorage:', err instanceof Error ? err.message : String(err));
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
    // No prior chats for this project — start a new one.
    return sessionStore.createSession();
  }

  /** Open a folder as a project. Resumes the last session for the path if one
   *  exists; otherwise creates a fresh chat with the provided content. */
  async function openProjectAtPath(
    path: string,
    fresh: { title: string; text: string; fileName?: string },
  ) {
    // Opening a folder outside the current workspace exits workspace mode —
    // projects inside the workspace root stay workspace members.
    const root = projectStore.workspaceRoot;
    if (root && !path.startsWith(root.replace(/[/\\]+$/, '') + '/')) projectStore.clearWorkspace();
    projectStore.setProject(path);
    // Refresh session list from DB so we find prior chats for this path.
    await sessionStore.fetchSessions();
    const existing = sessionStore.sessionsForProject(path);
    if (existing.length > 0) {
      // Resume the most recent session — don't create a blank one.
      const latest = existing.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
      sessionStore.activeSessionId = latest.id;
      toastStore.success(`Resumed ${projectDisplayName(path)} — ${latest.title}`);
    } else {
      // First time opening this project — bootstrap with the scanned content.
      await createProjectFromText(fresh.title, fresh.text, {
        source: 'file',
        fileName: fresh.fileName,
        path,
      });
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
      console.warn('Failed to read selected project file:', err instanceof Error ? err.message : String(err));
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
      console.warn('Failed to open project from folder:', err instanceof Error ? err.message : String(err));
      toastStore.error('Failed to open project from folder');
    } finally {
      input.value = '';
    }
  }

  async function openRecentProject(id: string) {
    const found = recentProjects.find((p) => p.id === id);
    if (!found) {
      toastStore.error('Recent project not found');
      return;
    }

    // Recent entries with a real absolute path get full project scoping
    // (resume that folder's chats or start fresh); text-only briefs keep the
    // legacy behavior. (Web folder picks store a bare folder name, not a path.)
    if (found.path && (/^\//.test(found.path) || /^[A-Za-z]:[/\\]/.test(found.path))) {
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
      projectStore.setProject(projectPath);
      await createProjectFromText(projectName, buildNewProjectTemplate(), {
        source: 'new',
        path: projectPath,
      });
    } catch (error) {
      toastStore.error(String(error));
    }
  }

  async function handleMenuAction(action: string) {
    if (action.startsWith('goal_')) {
      goalDisplayStore.update({ sidebar: true });
      // The Goal panel is conditionally mounted; dispatch after Svelte commits it.
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
      case 'open_project_folder': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

        if (!inTauri) {
          projectFolderInput?.click();
          break;
        }

        try {
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break;

          const result = await readFolderFromTauri(selectedPath);
          if (!result) {
            toastStore.error('Failed to open folder');
            break;
          }

          await openProjectAtPath(selectedPath, {
            title: result.title,
            text: result.text,
            fileName: result.folderName,
          });
        } catch (error) {
          toastStore.error(String(error));
        }
        break;
      }
      case 'open_workspace': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        if (!inTauri) {
          toastStore.error('Workspace folders require the desktop app');
          break;
        }
        try {
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break;
          const projects = await invoke<string[]>('list_workspace_projects', {
            folderPath: selectedPath,
          });
          projectStore.setWorkspace(selectedPath, projects);
          // Mark the root server-side so all its projects share ONE .koryphaios
          // (memory/rules/preferences) instead of one per project.
          apiFetch(apiUrl('/api/workspace/register'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root: selectedPath }),
          }).catch((err: unknown) => {
            console.warn('Workspace register failed:', err instanceof Error ? err.message : String(err));
          });
          sessionStore.activeSessionId = '';
          toastStore.success(
            `Opened workspace ${projectDisplayName(selectedPath)} with ${projects.length} project folders`,
          );
        } catch (error) {
          toastStore.error(String(error));
        }
        break;
      }
      case 'new_session':
        await sessionStore.newChat();
        inputRef?.focus();
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
        if (action.startsWith('open_recent:')) {
          await openRecentProject(action.slice('open_recent:'.length));
        } else if (action.startsWith('select_project:')) {
          const path = decodeURIComponent(action.slice('select_project:'.length));
          projectStore.setProject(path);
          await resumeOrCreateSession(path);
        }
        break;
    }
  }

  async function runPendingInHome() {
    const pending = noProjectPrompt;
    if (!pending) return;
    try {
      const res = await apiFetch(apiUrl('/api/workspace/home'));
      const data = await res.json();
      if (!res.ok || !data.ok || typeof data.data !== 'string') {
        toastStore.error('Could not resolve your home folder — open a project instead');
        return;
      }
      noProjectPrompt = null;
      projectStore.setProject(data.data);
      await resumeOrCreateSession(data.data);
      toastStore.warning('Running in your home folder — no project scoping');
      handleSend(
        pending.message,
        pending.model,
        pending.reasoningLevel,
        pending.attachments,
        pending.fastMode,
      );
    } catch (err: unknown) {
      console.warn('Failed to resolve home folder:', err instanceof Error ? err.message : String(err));
      toastStore.error('Could not resolve your home folder — open a project instead');
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
    };
  } | null>(null);

  function confirmAgenticConsent() {
    const p = agenticConsentPrompt;
    if (!p) return;
    agenticConsent = new Set([...agenticConsent, p.provider]);
    agenticConsentPrompt = null;
    handleSend(
      p.pending.message,
      p.pending.model,
      p.pending.reasoningLevel,
      p.pending.attachments,
      p.pending.fastMode,
    );
  }

  async function handleSend(
    message: string,
    model?: string,
    reasoningLevel?: string,
    attachments?: Array<{ type: string; data: string; name: string }>,
    fastMode?: boolean,
  ) {
    if (isDemoMode) {
      composerDraft = '';
      // Full demo: simulate a manager turn for the user's own prompt.
      // Guided demo: replay the scripted example turn.
      void import('$lib/demo.svelte').then((m) =>
        isFullDemo ? m.demoSend(message) : m.replayDemo(),
      );
      return;
    }
    if (!projectStore.currentPath) {
      // Don't hard-block: warn and let the user pick a project, or knowingly
      // run a quick task scoped to their home folder.
      noProjectPrompt = { message, model, reasoningLevel, attachments, fastMode };
      return;
    }
    const configurationWarning = getModelConfigurationWarning(wsStore.providers, model);
    if (configurationWarning) {
      toastStore.error(configurationWarning);
      showSettings = true;
      return;
    }
    // Remote CLI model: copies this project to the host to run there. Confirm
    // once per session so the client always knows their files are leaving.
    const providerName = model?.includes(':') ? model.split(':')[0] : '';
    const remoteProvider = providerName
      ? wsStore.providers.find((p) => p.name === providerName)
      : undefined;
    if (remoteProvider?.remoteAgentic && !agenticConsent.has(providerName)) {
      agenticConsentPrompt = {
        provider: providerName,
        hostName: remoteProvider.remoteHostName ?? remoteProvider.label ?? 'the host',
        pending: { message, model, reasoningLevel, attachments, fastMode },
      };
      return;
    }
    if (!message.trim() && !(attachments && attachments.length > 0)) return;

    // The welcome screen deliberately has a usable composer. Its first send
    // creates a correctly scoped chat and continues immediately—requiring a
    // separate click on "+" made the primary action look broken.
    if (!sessionStore.activeSessionId) {
      const createdSessionId = await sessionStore.newChat();
      if (!createdSessionId) return;
    }
    if (agentRail.selectedAgentId) {
      // Sub-agents get the same controls as the manager: the composer's model
      // and reasoning pickers apply to the selected agent's next turn.
      wsStore.sendAgentMessage(
        sessionStore.activeSessionId,
        agentRail.selectedAgentId,
        message,
        model,
        reasoningLevel,
      );
      return;
    }
    wsStore.sendMessage(
      sessionStore.activeSessionId,
      message,
      model,
      reasoningLevel,
      attachments,
      fastMode,
    );
  }

  function handleStop() {
    if (isDemoMode) {
      void import('$lib/demo.svelte').then((m) => m.demoStop());
      return;
    }
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    if (agentRail.selectedAgentId) {
      wsStore.markAgentStopped(agentRail.selectedAgentId);
      apiFetch(apiUrl(`/api/agent/${agentRail.selectedAgentId}/cancel`), { method: 'POST' }).catch(
        (err: unknown) => {
          console.debug('Failed to cancel agent:', err instanceof Error ? err.message : String(err));
        },
      );
      return;
    }
    wsStore.markSessionAgentsStopped(sid);
    wsStore.clearAnalyzing();
    apiFetch(apiUrl(`/api/sessions/${sid}/cancel`), { method: 'POST' }).catch((err: unknown) => {
      console.warn('Session cancel failed:', err instanceof Error ? err.message : String(err));
    });
  }

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
      : extractProjectFiles(currentProjectContent),
  );
  let connectedProviders = $derived(wsStore.providers.filter((p) => p.authenticated).length);
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
        : 'Koryphaios — AI Agent Orchestrator'}</title
  >
</svelte:head>

<AppShell
  {showSidebar}
  {zenMode}
  showNotes={notesStore.settings.enabled && showNotes && !collaborationStore.activeJoinedSession}
  activeSessionId={sessionStore.activeSessionId}
  {connectionDot}
  {connectionStatusLabel}
  {connectedProviders}
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
      projectName={collaborationStore.activeJoinedSession?.sessionName ?? projectStore.displayName}
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
    {#if collaborationStore.activeJoinedSession}
      <TeamWorkspace />
    {:else if !projectStore.currentPath && !sessionStore.activeSessionId}
      <div class="flex-1" style="background: var(--color-surface-1);">
        <!-- Fixed to the viewport center so the banner never shifts with the
             sidebar or other panels — it stays in the true middle. -->
        <div
          class="max-w-xl w-full text-center rounded-[24px] border px-8 py-10 overflow-y-auto"
          style="position: fixed; left: 50vw; top: 50%; transform: translate(-50%, -50%); max-height: calc(100vh - 200px); background: linear-gradient(180deg, rgba(var(--color-accent-rgb), 0.1), rgba(var(--color-accent-rgb), 0.03)); border-color: rgba(var(--color-accent-rgb), 0.22);"
        >
          <div class="mb-8">
            <img
              src="/logo-64.png"
              alt="Koryphaios"
              class="mx-auto rounded-2xl opacity-90"
              style="width: 72px; height: 72px;"
            />
          </div>

          <h2 class="text-2xl font-semibold mb-3" style="color: var(--color-text-primary);">
            Open a project to start working
          </h2>
          <p
            class="text-sm mb-8 max-w-md mx-auto leading-relaxed"
            style="color: var(--color-text-secondary);"
          >
            Koryphaios works best when it can inspect a real codebase, explain the current state,
            and then make targeted changes.
          </p>

          <div class="flex flex-col gap-3 mb-8">
            <button
              type="button"
              class="flex items-center justify-center gap-3 px-2 py-3 rounded-xl text-sm font-semibold transition-colors hover:bg-[var(--color-surface-2)]"
              style="color: var(--color-text-primary);"
              onclick={() => handleMenuAction('open_project_folder')}
            >
              <FolderOpen size={18} />
              <span>Open Folder</span>
            </button>

            <button
              type="button"
              class="flex items-center justify-center gap-3 px-2 py-3 rounded-xl text-sm font-medium transition-colors hover:bg-[var(--color-surface-2)]"
              style="color: var(--color-text-secondary);"
              onclick={() => handleMenuAction('open_workspace')}
            >
              <FolderPlus size={18} />
              <span>Open Workspace</span>
            </button>

            <button
              type="button"
              class="flex items-center justify-center gap-3 px-2 py-3 rounded-xl text-sm font-semibold transition-colors hover:bg-[var(--color-surface-2)]"
              style="color: var(--color-text-primary);"
              onclick={() => handleMenuAction('new_project')}
            >
              <FolderPlus size={18} />
              <span>New Project</span>
            </button>
          </div>

          {#if projectStore.openProjects.length > 0}
            <div class="mb-8 text-left">
              <div
                class="mb-3 px-1 text-xs font-semibold uppercase tracking-[0.14em]"
                style="color: var(--color-text-muted);"
              >
                Choose a project for this chat
              </div>
              <div class="flex flex-wrap gap-2">
                {#each projectStore.openProjects as path (path)}
                  <button
                    type="button"
                    class="rounded-xl border px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]"
                    style="border-color: var(--color-border); color: var(--color-text-primary);"
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
              <div class="flex items-center gap-2 mb-3 px-1">
                <Clock size={14} style="color: var(--color-text-muted);" />
                <span
                  class="text-xs font-semibold uppercase tracking-[0.14em]"
                  style="color: var(--color-text-muted);">Recent projects</span
                >
              </div>
              <div class="flex flex-col gap-2">
                {#each recentProjects.slice(0, 5) as project (project.id)}
                  <button
                    type="button"
                    class="flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-left text-sm transition-colors border hover:bg-[var(--color-surface-2)]"
                    style="color: var(--color-text-primary); border-color: var(--color-border); background: rgba(12, 10, 9, 0.2);"
                    onclick={() => handleMenuAction(`open_recent:${project.id}`)}
                    title={project.path || project.fileName || project.title}
                  >
                    <span class="truncate font-medium">{project.title}</span>
                    <span
                      class="shrink-0 text-xs truncate max-w-[150px]"
                      style="color: var(--color-text-muted);"
                    >
                      {project.path
                        ? project.path.split('/').pop() || project.path.split('\\').pop()
                        : project.fileName || ''}
                    </span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    {:else if gitStore.state.activeDiff}
      <DiffEditor />
    {:else if agentRail.selectedAgent}
      <AgentThreadFeed
        agent={agentRail.selectedAgent}
        feed={agentRail.selectedAgentFeed}
        isStreaming={agentRail.selectedAgentIsRunning}
      />
    {:else}
      <ManagerFeed onUseSuggestion={loadSuggestionIntoComposer} />
    {/if}
  {/snippet}

  {#snippet contextBar()}
    <!-- Context occupancy is informational (not cost tracking) — ALWAYS visible
         for an open session: known window → segmented bar; unknown window →
         tokens-used with an explicit "window unknown" label; no data yet →
         muted awaiting state. Never silently absent. -->
    {#if !collaborationStore.activeJoinedSession && projectStore.currentPath && sessionStore.activeSessionId}
      <div
        class="shrink-0 px-4"
        style="padding-top: var(--space-2); padding-bottom: var(--space-2); border-top: 1px solid var(--color-border); background: var(--color-surface-1);"
        role="group"
        onmouseenter={() => (contextBarHover = true)}
        onmouseleave={() => (contextBarHover = false)}
      >
        <div class="flex items-center gap-3">
          <span class="shrink-0" style="font-size: var(--text-xs); color: var(--color-text-muted);">
            Context
          </span>
          <div
            class="flex-1 rounded-full overflow-hidden flex"
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
                  title="{seg.label}: ~{formatTokenCount(seg.tokens)} tokens"
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
          {#if wsStore.contextUsage.max > 0}
            <span
              class="shrink-0 tabular-nums"
              style="font-size: var(--text-xs); color: {wsStore.contextUsage.percent > 85
                ? '#ef4444'
                : 'var(--color-text-muted)'};"
            >
              {formatTokenCount(wsStore.contextUsage.used)} / {formatTokenCount(
                wsStore.contextUsage.max,
              )}
            </span>
          {:else if wsStore.contextUsage.used > 0}
            <span
              class="shrink-0 tabular-nums"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title="Usage is real (provider-reported). The provider/CLI did not report a verified window size for this model, so no percentage can be shown honestly."
            >
              ~{formatTokenCount(wsStore.contextUsage.used)} used · window not reported by provider
            </span>
          {:else if wsStore.contextUsage.reason === 'context_unknown'}
            <span
              class="shrink-0 tabular-nums"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
              title="The selected provider or CLI did not report a verified context-window size for this model."
            >
              0 used · model window not reported
            </span>
          {:else}
            <span
              class="shrink-0"
              style="font-size: var(--text-xs); color: var(--color-text-muted); opacity: 0.6;"
              title="Waiting for the selected provider or CLI to report an authoritative token count. Local character estimates are intentionally not shown as token truth."
            >
              awaiting provider token report
            </span>
          {/if}
        </div>
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
            <span style="font-size: var(--text-xs); color: var(--color-text-muted); opacity: 0.7;">
              Free {formatTokenCount(
                Math.max(0, wsStore.contextUsage.max - wsStore.contextUsage.used),
              )}
            </span>
          </div>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#snippet composer()}
    {#if !collaborationStore.activeJoinedSession}<CommandInput
        bind:inputRef
        bind:value={composerDraft}
        onSend={handleSend}
        onExecuteCommand={handleSlashCommand}
        isRunning={agentRail.selectedAgent
          ? agentRail.selectedAgentIsRunning
          : runStateStore.isRunning(sessionStore.activeSessionId)}
        isWaiting={!agentRail.selectedAgent &&
          runStateStore.isWaiting(sessionStore.activeSessionId)}
        waitingReason={runStateStore.getWaitingReason(sessionStore.activeSessionId)}
        onStop={handleStop}
        onOpenSettings={(section, agentSection) => {
          settingsInitialTab = section === 'advanced' ? 'experimental' : section === 'agent' ? 'agent' : 'providers';
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
        disableModelPreviewRequests={isDemoMode}
        bind:selectedModel={activeComposerModel}
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
      />{/if}
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
<WorkflowPanel
  open={showWorkflows}
  sessionId={sessionStore.activeSessionId}
  initialTask={workflowTask}
  onclose={() => (showWorkflows = false)}
  onchange={() => void refreshActiveWorkflow()}
/>
<RewindDialog />
<ChangesSummary />
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
        The agent works inside a folder. Choose a project so it runs in the right place — or, for a
        quick one-off task, run it scoped to your home folder.
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
          class="w-full rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="border-color: var(--color-border); color: var(--color-text-primary);"
          onclick={runPendingInHome}
        >
          Run in Home Folder (~)
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
          onclick={confirmAgenticConsent}
        >
          Send my files &amp; run
        </button>
      </div>
    </div>
  </div>
{/if}

<SettingsDrawer
  open={showSettings}
  initialTab={settingsInitialTab}
  initialAgentSection={settingsInitialAgentSection}
  onClose={() => (showSettings = false)}
/>
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />
