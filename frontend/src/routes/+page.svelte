<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import SourceControlPanel from '$lib/components/SourceControlPanel.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import ChangesSummary from '$lib/components/ChangesSummary.svelte';
  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { getModKeyName } from '$lib/utils/platform';
  import {
    Settings,
    Activity,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    GitBranch,
    Zap,
    Search,
    SunMoon,
    Check,
    X,
  } from 'lucide-svelte';

  let showSettings = $state(false);
  let showAgents = $state(false);
  let showSidebar = $state(true);
  let showGit = $state(false);
  let showSidebarBeforeZen = $state(true);
  let showAgentsBeforeZen = $state(false);
  let showGitBeforeZen = $state(false);
  let showCommandPalette = $state(false);
  let showThemeQuickMenu = $state(false);
  let zenMode = $state(false);
  let inputRef = $state<HTMLTextAreaElement>();
  let projectFileInput = $state<HTMLInputElement>();
  let projectFolderInput = $state<HTMLInputElement>();
  let openMenu = $state<'file' | 'edit' | 'view' | null>(null);
  let recentProjects = $state<RecentProject[]>([]);

  const RECENT_PROJECTS_KEY = 'koryphaios-recent-projects';
  const LAYOUT_PREFS_KEY = 'koryphaios-layout-prefs';
  const MAX_RECENT_PROJECTS = 12;

  type RecentProject = {
    id: string;
    title: string;
    content: string;
    source: 'new' | 'file' | 'template';
    fileName?: string;
    updatedAt: number;
  };

  type PromptTemplate = {
    id: 'prd' | 'bugfix' | 'refactor' | 'ship';
    label: string;
    content: string;
  };

  const promptTemplates: PromptTemplate[] = [
    {
      id: 'prd',
      label: 'Insert PRD Template',
      content: `Build Spec
- Problem:
- Target user:
- Success metrics:

Requirements
- Must have:
- Nice to have:
- Out of scope:

Execution plan
- Milestone 1:
- Milestone 2:
- Milestone 3:

Open questions
- `,
    },
    {
      id: 'bugfix',
      label: 'Insert Bugfix Template',
      content: `Bug Report
- Expected:
- Actual:
- Repro steps:
- Environment:

Debug plan
- Suspected root cause:
- Verification steps:
- Regression risks:

Definition of done
- `,
    },
    {
      id: 'refactor',
      label: 'Insert Refactor Template',
      content: `Refactor Goal
- Why now:
- Scope:
- Constraints:

Current pain points
- 

Refactor approach
- Architecture changes:
- Migration steps:
- Test strategy:

Acceptance criteria
- `,
    },
    {
      id: 'ship',
      label: 'Insert Ship Checklist',
      content: `Ship Checklist
- Feature complete
- Tests passing
- Edge cases reviewed
- Docs updated
- Monitoring/alerts defined
- Rollback plan prepared

Release notes
- `,
    },
  ];

  onMount(() => {
    theme.init();
    appStore.initialize(authStore, sessionStore).then(() => {
      wsStore.connect();
    });
    loadRecentProjects();
    loadLayoutPrefs();

    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('click', handleWindowClick);
    return () => {
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('click', handleWindowClick);
    };
  });

  // Automatically subscribe WebSocket to the active session when it changes
  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (activeId && wsStore.status === 'connected') {
      wsStore.subscribeToSession(activeId);
    }
  });

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-top-menu]')) return;
    openMenu = null;
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && showThemeQuickMenu) {
      showThemeQuickMenu = false;
      return;
    }

    if (e.key === 'Escape' && openMenu) {
      openMenu = null;
      return;
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

    if (shortcutStore.matches('toggle_yolo', e)) {
      e.preventDefault();
      setYoloMode(!wsStore.isYoloMode);
      return;
    }

    if (shortcutStore.matches('settings', e)) {
      e.preventDefault();
      showSettings = true;
    } else if (shortcutStore.matches('new_session', e)) {
      e.preventDefault();
      sessionStore.createSession();
    } else if (shortcutStore.matches('focus_input', e)) {
      e.preventDefault();
      inputRef?.focus();
    } else if (shortcutStore.matches('close', e) && showSettings) {
      showSettings = false;
    }
  }

  function toggleMenu(menu: 'file' | 'edit' | 'view') {
    openMenu = openMenu === menu ? null : menu;
  }

  function setYoloMode(enabled: boolean) {
    wsStore.setYoloMode(enabled);
    if (enabled) {
      toastStore.warning('YOLO Mode Active');
    } else {
      toastStore.success('YOLO Mode Disabled');
    }
  }

  function requestSessionCompact() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to compact');
      return;
    }

    wsStore.sendMessage(
      sessionId,
      [
        'Compact the session for context efficiency.',
        'Return:',
        '1) one short project summary,',
        '2) current status,',
        '3) key decisions,',
        '4) open issues,',
        '5) next actions.',
        'Keep it concise and implementation-focused.',
      ].join('\n')
    );
    toastStore.info('Compaction request sent to manager');
  }

  async function handleSlashCommand(command: string): Promise<boolean> {
    const parts = command.trim().slice(1).split(/\s+/).filter(Boolean);
    const root = parts[0]?.toLowerCase();

    if (!root) return false;

    if (root === 'help') {
      toastStore.info('Commands: /new, /compact, /yolo');
      return true;
    }

    if (root === 'new') {
      await sessionStore.createSession();
      inputRef?.focus();
      return true;
    }

    if (root === 'compact') {
      requestSessionCompact();
      return true;
    }

    if (root === 'yolo') {
      if (parts.length > 1) {
        toastStore.error('Usage: /yolo');
      } else {
        setYoloMode(!wsStore.isYoloMode);
      }
      return true;
    }

    toastStore.error(`Unknown command: /${root}. Use /help`);
    return true;
  }

  function loadRecentProjects() {
    try {
      const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;

      recentProjects = parsed
        .filter((entry): entry is RecentProject =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RecentProject).id === 'string' &&
          typeof (entry as RecentProject).title === 'string' &&
          typeof (entry as RecentProject).content === 'string' &&
          typeof (entry as RecentProject).source === 'string' &&
          typeof (entry as RecentProject).updatedAt === 'number'
        )
        .slice(0, MAX_RECENT_PROJECTS);
    } catch {
      recentProjects = [];
    }
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
      if (typeof maybe.showGit === 'boolean') showGit = maybe.showGit;
    } catch {
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
        showGit,
      })
    );
  });

  function persistRecentProjects() {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recentProjects));
  }

  function saveRecentProject(entry: Omit<RecentProject, 'id' | 'updatedAt'>) {
    const normalizedTitle = entry.title.trim().toLowerCase();
    const normalizedContent = entry.content.trim();
    const existing = recentProjects.find((p) =>
      p.title.trim().toLowerCase() === normalizedTitle && p.content.trim() === normalizedContent
    );

    const now = Date.now();
    if (existing) {
      recentProjects = [
        {
          ...existing,
          ...entry,
          updatedAt: now,
        },
        ...recentProjects.filter((p) => p.id !== existing.id),
      ].slice(0, MAX_RECENT_PROJECTS);
    } else {
      recentProjects = [
        {
          id: `recent-${now}-${Math.random().toString(36).slice(2, 8)}`,
          ...entry,
          updatedAt: now,
        },
        ...recentProjects,
      ].slice(0, MAX_RECENT_PROJECTS);
    }

    persistRecentProjects();
  }

  function formatRecentDate(ts: number) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function buildNewProjectTemplate() {
    return 'Set up a new project plan with milestones, risks, and first tasks.';
  }

  async function createProjectFromText(
    title: string,
    text: string,
    options?: { source?: RecentProject['source']; fileName?: string }
  ) {
    const sessionId = await sessionStore.createSession();
    if (!sessionId) {
      toastStore.error('Could not create project session');
      return;
    }

    await sessionStore.renameSession(sessionId, title);

    if (text.trim()) {
      wsStore.sendMessage(
        sessionId,
        `Project brief loaded from file:\n\n${text}`
      );
    }

    saveRecentProject({
      title,
      content: text,
      source: options?.source ?? 'new',
      fileName: options?.fileName,
    });

    inputRef?.focus();
  }

  async function handleProjectFileSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      const maxChars = 12000;
      const trimmed = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
      const baseTitle = file.name.replace(/\.[^/.]+$/, '').trim();
      const title = baseTitle ? `Project: ${baseTitle}` : 'Imported Project';

      await createProjectFromText(title.slice(0, 64), trimmed, { source: 'file', fileName: file.name });
      if (raw.length > maxChars) {
        toastStore.warning('Large file imported; content was truncated for context size');
      } else {
        toastStore.success(`Imported ${file.name} into a new project`);
      }
    } catch {
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
      const MAX_TOTAL_CHARS = 16000;
      const KEY_FILES = /^(README|readme|Readme)(\.(md|txt|rst))?$|^package\.json$|^package-lock\.json$|^Cargo\.toml$|^pyproject\.toml$|^go\.mod$|^\.env\.example$/i;
      const entries: { path: string; file: File }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        entries.push({ path, file });
      }
      const keyEntries = entries.filter((e) => KEY_FILES.test(e.path.split('/').pop() || ''));
      const otherEntries = entries.filter((e) => !KEY_FILES.test(e.path.split('/').pop() || ''));

      let total = 0;
      const parts: string[] = [];

      for (const { path, file } of keyEntries) {
        if (total >= MAX_TOTAL_CHARS) break;
        try {
          const text = await file.text();
          const slice = text.length + total > MAX_TOTAL_CHARS ? text.slice(0, MAX_TOTAL_CHARS - total) : text;
          total += slice.length;
          parts.push(`--- ${path} ---\n${slice}`);
        } catch (_) {}
      }

      const maxList = 200;
      const otherPaths = otherEntries.slice(0, maxList).map((e) => e.path);
      if (otherEntries.length > maxList) {
        otherPaths.push(`... and ${otherEntries.length - maxList} more files`);
      }
      if (otherPaths.length > 0) {
        parts.push(`--- Project structure (${otherEntries.length} files) ---\n${otherPaths.join('\n')}`);
      }

      const folderName = entries[0]?.path.split('/')[0] || 'Folder';
      const title = `Project: ${folderName}`.slice(0, 64);
      const content = parts.join('\n\n');

      await createProjectFromText(title, content || `Project folder: ${folderName} (${entries.length} files)`, {
        source: 'file',
        fileName: folderName,
      });
      toastStore.success(`Opened project from folder: ${folderName} (${entries.length} files)`);
    } catch (err) {
      console.error('Folder import failed', err);
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

    await createProjectFromText(found.title, found.content, {
      source: found.source,
      fileName: found.fileName,
    });
    toastStore.success(`Opened recent project: ${found.title}`);
  }

  function sanitizeFileName(raw: string) {
    return raw.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
  }

  function exportCurrentProjectSnapshot() {
    const sessionId = sessionStore.activeSessionId;
    const activeSession = sessionStore.sessions.find((s) => s.id === sessionId);

    if (!activeSession) {
      toastStore.error('No active project session to export');
      return;
    }

    const snapshot = {
      format: 'koryphaios.project.snapshot.v1',
      exportedAt: new Date().toISOString(),
      project: {
        id: activeSession.id,
        title: activeSession.title,
        updatedAt: activeSession.updatedAt,
      },
      feed: wsStore.feed
        .filter((entry) => entry.metadata?.sessionId === sessionId || !entry.metadata?.sessionId)
        .map((entry) => ({
          type: entry.type,
          agent: entry.agentName,
          text: entry.text ?? '',
          timestamp: entry.timestamp,
          model: entry.metadata?.model ?? null,
        })),
    };

    const payload = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const safeTitle = sanitizeFileName(activeSession.title.toLowerCase());
    const datePart = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${safeTitle}-${datePart}.kory.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    toastStore.success('Project snapshot exported');
  }

  function insertPromptTemplate(templateId: PromptTemplate['id']) {
    const template = promptTemplates.find((t) => t.id === templateId);
    if (!template || !inputRef) {
      toastStore.error('Prompt template unavailable');
      return;
    }

    const current = inputRef.value.trim();
    inputRef.value = current ? `${current}\n\n${template.content}` : template.content;
    inputRef.dispatchEvent(new Event('input', { bubbles: true }));
    inputRef.focus();
    inputRef.setSelectionRange(inputRef.value.length, inputRef.value.length);
    toastStore.success(`${template.label.replace('Insert ', '')} added`);
  }

  async function handleMenuAction(action: string) {
    openMenu = null;

    switch (action) {
      case 'new_project':
        await createProjectFromText(
          `New Project ${new Date().toLocaleDateString()}`,
          buildNewProjectTemplate(),
          { source: 'new' }
        );
        break;
      case 'open_project_file':
        projectFileInput?.click();
        break;
      case 'open_project_folder':
        projectFolderInput?.click();
        break;
      case 'save_snapshot':
        exportCurrentProjectSnapshot();
        break;
      case 'new_session':
        await sessionStore.createSession();
        inputRef?.focus();
        break;
      case 'focus_input':
        inputRef?.focus();
        break;
      case 'clear_feed':
        wsStore.clearFeed();
        toastStore.success('Current feed cleared');
        break;
      case 'toggle_agents':
        showAgents = !showAgents;
        break;
      case 'toggle_git':
        showGit = !showGit;
        break;
      case 'toggle_theme':
        showThemeQuickMenu = true;
        break;
      case 'toggle_yolo':
        setYoloMode(!wsStore.isYoloMode);
        break;
      case 'session_compact':
        requestSessionCompact();
        break;
      case 'toggle_sidebar':
        showSidebar = !showSidebar;
        break;
      case 'toggle_zen_mode':
        if (!zenMode) {
          showSidebarBeforeZen = showSidebar;
          showAgentsBeforeZen = showAgents;
          showGitBeforeZen = showGit;
          showSidebar = false;
          showAgents = false;
          showGit = false;
          zenMode = true;
        } else {
          zenMode = false;
          showSidebar = showSidebarBeforeZen;
          showAgents = showAgentsBeforeZen;
          showGit = showGitBeforeZen;
        }
        break;
      case 'open_settings':
        showSettings = true;
        break;
      case 'template_prd':
        insertPromptTemplate('prd');
        break;
      case 'template_bugfix':
        insertPromptTemplate('bugfix');
        break;
      case 'template_refactor':
        insertPromptTemplate('refactor');
        break;
      case 'template_ship':
        insertPromptTemplate('ship');
        break;
    }
  }

  function handleSend(message: string, model?: string, reasoningLevel?: string) {
    if (!sessionStore.activeSessionId || !message.trim()) return;
    wsStore.sendMessage(sessionStore.activeSessionId, message, model, reasoningLevel);
  }

  let activeAgents = $derived([...wsStore.agents.values()].filter(a => 
    a.sessionId === sessionStore.activeSessionId && a.status !== 'done' && a.status !== 'idle'
  ));
  let connectedProviders = $derived(wsStore.providers.filter(p => p.authenticated).length);
  let connectionDot = $derived(
    wsStore.status === 'connected' ? 'bg-emerald-500' :
    wsStore.status === 'connecting' ? 'bg-amber-500 animate-pulse' :
    'bg-red-500'
  );
</script>

<svelte:head>
  <title>{appStore.projectName ? `${appStore.projectName} — Koryphaios` : 'Koryphaios — AI Agent Orchestrator'}</title>
</svelte:head>

<div class="flex h-screen overflow-hidden" style="background: var(--color-surface-0);">
  <!-- Sidebar -->
  {#if showSidebar}
    <div class="w-60 min-w-[200px] max-w-[320px] shrink-0 border-r flex flex-col" style="border-color: var(--color-border); background: var(--color-surface-1);">
      <!-- Logo + project -->
      <div class="flex items-center justify-between px-4 h-12 border-b shrink-0" style="border-color: var(--color-border);">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-7 h-7 rounded-lg bg-gradient-to-br from-yellow-400 to-amber-600 flex items-center justify-center text-xs font-bold shrink-0" style="color: var(--color-surface-0);">K</div>
          <div class="flex flex-col justify-center min-w-0">
            <h1 class="text-sm font-semibold leading-tight" style="color: var(--color-text-primary);">Koryphaios</h1>
            <p class="text-[10px] leading-tight mt-0.5" style="color: var(--color-text-muted);">v0.1.0</p>
            {#if appStore.projectName}
              <p class="text-[10px] leading-tight truncate mt-0.5" style="color: var(--color-text-muted);" title={appStore.projectName}>{appStore.projectName}</p>
            {/if}
          </div>
        </div>
        <button
          class="p-1.5 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => showSidebar = false}
          title="Hide sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <div class="flex-1 overflow-hidden">
        <SessionSidebar 
          currentSessionId={sessionStore.activeSessionId} 
        />
      </div>
      <!-- Sidebar footer -->
      <div class="px-3 h-10 border-t flex items-center justify-between shrink-0" style="border-color: var(--color-border);">
        <div class="flex items-center gap-2">
          <div class="w-2 h-2 rounded-full {connectionDot}"></div>
          <span class="text-[10px] capitalize leading-none" style="color: var(--color-text-muted);">{wsStore.status}</span>
        </div>
        <div class="flex items-center gap-1">
          {#if connectedProviders > 0}
            <span class="text-[10px] px-1.5 py-0.5 rounded leading-none" style="background: var(--color-surface-3); color: var(--color-text-muted);">
              {connectedProviders} providers
            </span>
          {/if}
        </div>
      </div>
    </div>
  {:else if !zenMode}
    <div class="w-10 shrink-0 border-r flex flex-col items-center" style="border-color: var(--color-border); background: var(--color-surface-1);">
      <div class="h-12 w-full border-b flex items-center justify-center" style="border-color: var(--color-border);">
        <button
          class="p-1.5 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => showSidebar = true}
          title="Show sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  {/if}

  <!-- Main Content -->
  <div class="flex-1 flex min-w-0">
    <div class="flex-1 flex flex-col min-w-0 relative">
    <!-- Top bar -->
    {#if !zenMode}
      <header class="flex items-center justify-between px-4 h-12 border-b shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-1" data-top-menu>
            <div class="relative" data-top-menu>
              <button
                class="px-2 py-1 text-xs rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-secondary);"
                onclick={() => toggleMenu('file')}
              >
                File
              </button>
              {#if openMenu === 'file'}
                <div class="absolute left-0 top-8 z-30 min-w-[260px] rounded-lg border p-1" style="background: var(--color-surface-2); border-color: var(--color-border);">
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('new_project')}>New Project</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('open_project_file')}>Open Project From File...</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('open_project_folder')}>Open Project From Folder...</button>
                  <div class="h-px my-1" style="background: var(--color-border);"></div>
                  <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider" style="color: var(--color-text-muted);">Recent projects</div>
                  {#if recentProjects.length > 0}
                    {#each recentProjects.slice(0, 6) as project (project.id)}
                      <button class="w-full flex items-center justify-between gap-2 text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => openRecentProject(project.id)}>
                        <span class="truncate">{project.title}</span>
                        <span class="shrink-0 text-[10px]" style="color: var(--color-text-muted);">{formatRecentDate(project.updatedAt)}</span>
                      </button>
                    {/each}
                  {:else}
                    <div class="px-2.5 py-1.5 text-xs" style="color: var(--color-text-muted);">No recent projects yet</div>
                  {/if}
                  <div class="h-px my-1" style="background: var(--color-border);"></div>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('save_snapshot')}>Save Project As .kory.json</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('new_session')}>New Session</button>
                </div>
              {/if}
            </div>

            <div class="relative" data-top-menu>
              <button
                class="px-2 py-1 text-xs rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-secondary);"
                onclick={() => toggleMenu('edit')}
              >
                Edit
              </button>
              {#if openMenu === 'edit'}
                <div class="absolute left-0 top-8 z-30 min-w-[220px] rounded-lg border p-1" style="background: var(--color-surface-2); border-color: var(--color-border);">
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('focus_input')}>Focus Prompt Input</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('clear_feed')}>Clear Current Feed</button>
                  <div class="h-px my-1" style="background: var(--color-border);"></div>
                  {#each promptTemplates as template (template.id)}
                    <button
                      class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]"
                      style="color: var(--color-text-primary);"
                      onclick={() => handleMenuAction(`template_${template.id}`)}
                    >
                      {template.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="relative" data-top-menu>
              <button
                class="px-2 py-1 text-xs rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-secondary);"
                onclick={() => toggleMenu('view')}
              >
                View
              </button>
              {#if openMenu === 'view'}
                <div class="absolute left-0 top-8 z-30 min-w-[200px] rounded-lg border p-1" style="background: var(--color-surface-2); border-color: var(--color-border);">
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('toggle_sidebar')}>{showSidebar ? 'Hide' : 'Show'} Sidebar</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('toggle_zen_mode')}>{zenMode ? 'Disable' : 'Enable'} Zen Mode</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('toggle_agents')}>{showAgents ? 'Hide' : 'Show'} Active Agents</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('toggle_theme')}>Switch Theme...</button>
                  <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => handleMenuAction('open_settings')}>Open Settings</button>
                </div>
              {/if}
            </div>
          </div>

          {#if appStore.projectName}
            <span class="flex items-center gap-2 min-w-0 max-w-[240px]">
              <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);" aria-hidden="true">|</span>
              <span
                class="truncate text-xs font-medium"
                style="color: var(--color-text-secondary);"
                title={appStore.projectName}
              >
                {appStore.projectName}
              </span>
            </span>
          {/if}

          {#if wsStore.koryPhase}
            <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style="background: var(--color-surface-2);">
              <div class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></div>
              <span class="text-xs leading-none" style="color: var(--color-text-secondary);">
                Kory: {wsStore.koryPhase}
              </span>
            </div>
          {/if}

          {#if wsStore.isYoloMode}
            <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
              <Zap size={12} fill="currentColor" />
              <span class="text-[10px] font-bold tracking-wider uppercase">YOLO mode</span>
            </div>
          {/if}
        </div>

        <div class="flex items-center gap-2">
          <button
            class="px-2 py-1 text-[10px] rounded-md transition-colors hover:bg-[var(--color-surface-3)] uppercase tracking-wider"
            style="color: var(--color-text-muted);"
            onclick={() => showSidebar = !showSidebar}
            title={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
          >
            {showSidebar ? 'Hide Sidebar' : 'Show Sidebar'}
          </button>
          <button
            class="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: {showGit ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
            onclick={() => showGit = !showGit}
            title={showGit ? 'Hide Source Control' : 'Show Source Control'}
          >
            <GitBranch size={14} />
            <span class="text-[10px] font-medium uppercase tracking-wider">{showGit ? 'Hide Git' : 'Show Git'}</span>
          </button>
          <button
            class="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-muted);"
            onclick={() => showCommandPalette = true}
            title="Command Palette ({getModKeyName()}K)"
          >
            <Search size={14} />
            <span class="text-[10px] font-medium uppercase tracking-wider">Commands</span>
            <kbd class="text-[9px] px-1 py-0.5 rounded bg-[var(--color-surface-3)] border border-[var(--color-border)] opacity-60">{getModKeyName()}K</kbd>
          </button>

          {#if activeAgents.length > 0}
            <button
              class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
              style="background: var(--color-surface-2);"
              onclick={() => showAgents = !showAgents}
            >
              <Activity size={12} class="text-emerald-400" />
              <span class="text-xs leading-none" style="color: var(--color-text-secondary);">{activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}</span>
              <ChevronDown size={12} class="transition-transform {showAgents ? 'rotate-180' : ''}" style="color: var(--color-text-muted);" />
            </button>
          {/if}
          <button
            class="p-2 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] flex items-center justify-center"
            style="color: var(--color-text-muted);"
            onclick={() => showSettings = true}
            title="Settings ({getModKeyName()},)"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>
    {:else}
      <button
        class="absolute top-1 right-4 z-20 px-2.5 py-1 rounded-md text-xs border transition-all duration-200 hover:bg-[var(--color-surface-3)] hover:border-[var(--color-border-bright)] hover:scale-105 active:scale-95"
        style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary);"
        onclick={() => handleMenuAction('toggle_zen_mode')}
      >
        Exit Zen
      </button>
    {/if}

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

    <!-- Agent cards (collapsible) -->
    {#if !zenMode && showAgents && activeAgents.length > 0}
      <div class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        {#each activeAgents as agent (agent.identity.id)}
          <WorkerCard {agent} />
        {/each}
      </div>
    {/if}

    <!-- File Edit Preview (Cursor-style streaming) -->
    <FileEditPreview />

    <!-- Chat / Feed area -->
    <div class="flex-1 overflow-hidden flex flex-col">
      {#if gitStore.state.activeDiff}
        <DiffEditor />
      {:else}
        <ManagerFeed />
      {/if}
    </div>

    <!-- Context window usage -->
    {#if wsStore.contextUsage.isReliable}
      <div class="shrink-0 px-4 py-1.5 flex items-center gap-3" style="border-top: 1px solid var(--color-border); background: var(--color-surface-1);">
        <span class="text-[10px] shrink-0" style="color: var(--color-text-muted);">
          Context
        </span>
        <div class="flex-1 h-1.5 rounded-full overflow-hidden" style="background: var(--color-surface-3);">
          <div
            class="h-full rounded-full transition-all duration-500"
            style="width: {wsStore.contextUsage.percent}%; background: {
              wsStore.contextUsage.percent > 85 ? '#ef4444' :
              wsStore.contextUsage.percent > 65 ? '#f59e0b' : 
              'var(--color-accent)'
            };"
          ></div>
        </div>
        {#if wsStore.contextUsage.max > 0}
          <span class="text-[10px] shrink-0 tabular-nums" style="color: var(--color-text-muted);">
            {wsStore.contextUsage.used >= 1000 ? `${(wsStore.contextUsage.used / 1000).toFixed(1)}k` : wsStore.contextUsage.used} / {(wsStore.contextUsage.max / 1000).toFixed(0)}k
          </span>
        {/if}
      </div>
    {/if}

    <!-- Command Input -->
    <div class="shrink-0 border-t" style="border-color: var(--color-border); background: var(--color-surface-1);">
      <CommandInput
        bind:inputRef
        onSend={handleSend}
      />
    </div>
  </div>

  {#if !zenMode && showGit}
      <aside class="w-80 max-w-[40vw] min-w-[260px] border-l shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <SourceControlPanel />
      </aside>
    {/if}
  </div>
</div>

<PermissionDialog />
<QuestionDialog />
<ChangesSummary />

{#if showThemeQuickMenu}
  <div
    class="fixed inset-0 z-[95] flex items-start justify-center pt-[12vh] px-4 backdrop-blur-sm"
    style="background: rgba(0,0,0,0.45);"
    onmousedown={() => showThemeQuickMenu = false}
    role="presentation"
  >
    <div
      class="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
      onmousedown={e => e.stopPropagation()}
      role="presentation"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color: var(--color-border);">
        <div class="flex items-center gap-2">
          <SunMoon size={15} style="color: var(--color-text-secondary);" />
          <div class="text-sm font-medium" style="color: var(--color-text-primary);">Switch Theme</div>
        </div>
        <button
          class="p-1 rounded transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={() => showThemeQuickMenu = false}
          aria-label="Close theme picker"
        >
          <X size={14} />
        </button>
      </div>

      <div class="p-3">
        <div class="text-[10px] uppercase tracking-wider mb-2" style="color: var(--color-text-muted);">Theme Preset</div>
        <div class="grid grid-cols-2 gap-1.5">
          {#each theme.presets as preset}
            <button
              class="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs transition-all border
                     {theme.preset === preset.id
                       ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text-primary)]'
                       : 'border-transparent bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]'}"
              onclick={() => {
                theme.setPreset(preset.id);
              }}
            >
              <span>{preset.label}</span>
              {#if theme.preset === preset.id}
                <Check size={12} style="color: var(--color-accent);" />
              {/if}
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

<SettingsDrawer open={showSettings} onClose={() => showSettings = false} />
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />
