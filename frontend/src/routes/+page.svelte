<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import AgentThreadFeed from '$lib/components/AgentThreadFeed.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import ChangesSummary from '$lib/components/ChangesSummary.svelte';
  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import MenuBar from '$lib/components/MenuBar.svelte';
  import ThemePickerModal from '$lib/components/ThemePickerModal.svelte';
  import AppShell from '$lib/components/shell/AppShell.svelte';
  import AgentRail from '$lib/components/shell/AgentRail.svelte';
  import { useAgentRail } from '$lib/components/shell/useAgentRail.svelte';
  import { useSessionSync } from '$lib/hooks/useSessionSync.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { FolderOpen, FolderPlus, Clock } from 'lucide-svelte';
  import { invoke } from '@tauri-apps/api/core';
  import {
    type RecentProject,
    parseRecentProjects,
    addRecentProject,
    buildNewProjectTemplate,
    createProjectSession,
    readProjectFile,
    readProjectFolder,
    exportCurrentProjectSnapshot,
    insertPromptTemplate,
  } from '$lib/utils/projectManager';
  import { getModelConfigurationWarning } from '$lib/utils/model-config';

  let showSettings = $state(false);
  let showAgents = $state(false);
  let showSidebar = $state(true);
  let showGit = $state(false);
  let showNotes = $state(false);
  let showSidebarBeforeZen = $state(true);
  let showAgentsBeforeZen = $state(false);
  let showGitBeforeZen = $state(false);
  let showCommandPalette = $state(false);
  let showThemeQuickMenu = $state(false);
  let zenMode = $state(false);
  let inputRef = $state<HTMLTextAreaElement>();
  let projectFileInput = $state<HTMLInputElement>();
  let projectFolderInput = $state<HTMLInputElement>();
  let recentProjects = $state<RecentProject[]>([]);
  let composerDraft = $state('');
  let currentProjectContent = $state('');
  let composerProjectFiles = $state<string[]>([]);
  let contextBarHover = $state(false);

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

  useSessionSync({
    onActiveSessionChange: () => {
      agentRail.selectedAgentId = '';
    },
  });

  const composerSlashCommands = [
    { command: 'new', label: 'New Session', description: 'Create a fresh session.' },
    { command: 'resume', label: 'Resume Previous Chat', description: 'Resume the most recent earlier chat for this project.' },
    { command: 'compact', label: 'Compact Session', description: 'Summarize and compact the current session.' },
    { command: 'yolo', label: 'Toggle YOLO', description: 'Toggle YOLO mode on or off.' },
    { command: 'beginner', label: 'Beginner Mode', description: 'Switch to beginner UI mode.' },
    { command: 'advanced', label: 'Advanced Mode', description: 'Switch to advanced UI mode.' },
    { command: 'clear', label: 'Clear Feed', description: 'Clear the current visible feed.' },
    { command: 'settings', label: 'Open Settings', description: 'Open the settings drawer.' },
    { command: 'theme', label: 'Theme Picker', description: 'Open theme selection.' },
    { command: 'sidebar', label: 'Toggle Sidebar', description: 'Show or hide the sidebar.' },
    { command: 'zen', label: 'Toggle Zen', description: 'Enter or exit zen mode.' },
  ];

  const LAYOUT_PREFS_KEY = 'koryphaios-layout-prefs';

  onMount(() => {
    const cleanupTheme = theme.init();
    appStore.initialize(authStore, sessionStore).then(() => {
      if (authStore.isAuthenticated) {
        modeStore.fetchMode();
        wsStore.connect();
      }
      if (projectStore.currentPath) {
        void refreshComposerFileMentions();
      }
    });
    recentProjects = parseRecentProjects();
    loadLayoutPrefs();

    window.addEventListener('keydown', handleGlobalKeydown);

    const handleOpenNote = async (e: Event) => {
      const title = (e as CustomEvent<{ title: string }>).detail?.title;
      if (!title) return;
      showNotes = true;
      await notesStore.openNoteByTitle(title);
    };
    window.addEventListener('open-note', handleOpenNote);

    const handleOpenNotesGraph = () => {
      showNotes = true;
    };
    window.addEventListener('open-notes-graph', handleOpenNotesGraph);

    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('open-note', handleOpenNote);
      window.removeEventListener('open-notes-graph', handleOpenNotesGraph);
    };
  });

  async function startDragging(e: MouseEvent) {
    if (typeof window === 'undefined' || !('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) return;

    const interactive = (e.target as HTMLElement | null)?.closest('button, a, input, [role="button"]');
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

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      showNotes = !showNotes;
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
      `🎯 SESSION COMPACTION — CONTEXT PRESERVATION PROTOCOL

Create a hyper-dense, information-rich summary that preserves ALL critical context while eliminating redundancy. This summary will replace the full conversation history, so completeness is paramount.

## 📄 SESSION MEMORY FILE

This session has a persistent memory file at:
\`.koryphaios/sessions/${sessionId}/memory.md\`

**CRITICAL: You MUST update this memory file during compaction.**

### Memory File Purpose
- Survives compactions (unlike chat history which gets replaced)
- Stores long-term context: project goals, key decisions, gotchas, references
- Acts as a "source of truth" that persists across the entire session lifecycle
- Automatically deleted when the session is deleted

### How to Update the Memory File
Use the \`write_file\` tool to update the memory file with structured information:
- Path: \`.koryphaios/sessions/${sessionId}/memory.md\`
- Content: Organized markdown with sections for project context, learnings, decisions, gotchas

---

## OUTPUT FORMAT (Strictly follow this structure)

### 📋 PROJECT BRIEF
One sentence: What we're building and why it matters.

### 🏗️ ARCHITECTURE & KEY DECISIONS
- Decision: [What was decided]
  - Rationale: [Why]
  - Impact: [What it affects]
  - Status: [Implemented/Pending/Abandoned]
[Repeat for each significant decision]

### 📁 FILES & CODE STATE
| File | Status | Key Implementation Details |
|------|--------|---------------------------|
| [path] | [modified/created/deleted] | [Critical: functions, classes, APIs, config values] |

### ✅ COMPLETED WORK
- [Specific achievement with technical details]
- [Include verification steps if applicable]

### 🚧 ACTIVE WORK (In Progress)
- [What's being worked on right now]
- [Current blockers or dependencies]
- [Next immediate step]

### ⚠️ OPEN ISSUES & TECH DEBT
- [Issue]: [Severity: Critical/High/Medium/Low] — [One-line description] — [Proposed fix or investigation path]

### 🎯 NEXT ACTIONS (Priority Ordered)
1. [ ] [Specific, actionable task] — [Estimated effort] — [Success criteria]
2. [ ] [Next task...]

### 🔗 CRITICAL CONTEXT TO PRESERVE
- [Any non-obvious context, gotchas, or tribal knowledge that would be lost]
- [Environment-specific details, API keys, config flags]
- [Links to external resources, docs, or references]

### 📊 CONFIDENCE & RISK
- Overall confidence: [High/Medium/Low]
- Biggest risk: [What could derail this]
- Mitigation: [How we're addressing it]

---
RULES:
- NO fluff, filler, or conversational language
- EVERY sentence must contain actionable information
- Preserve SPECIFIC values: file paths, function names, config keys, error messages
- Flag UNCERTAINTY explicitly: "UNCERTAIN: [what needs verification]"
- Include CODE SNIPPETS only if critical and brief (< 5 lines)
- **MANDATORY: Update the memory file with key learnings and decisions**
- **MANDATORY: Reference the memory file path in your response so the user knows it exists**`
    );
    toastStore.info('Session compaction in progress...');
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
    } catch {
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
        if (
          candidate &&
          !candidate.startsWith('...') &&
          !candidate.startsWith('---')
        ) {
          unique.add(candidate);
        }
      }
    }

    return Array.from(unique).slice(0, 500);
  }

  async function handleSlashCommand(command: string): Promise<boolean> {
    const parts = command.trim().slice(1).split(/\s+/).filter(Boolean);
    const root = parts[0]?.toLowerCase();

    if (!root) return false;

    if (root === 'help') {
      toastStore.info('Commands: /new, /resume, /compact, /yolo, /beginner, /advanced, /clear, /settings, /theme, /sidebar, /zen');
      return true;
    }

    if (root === 'new') {
      await sessionStore.createSession();
      inputRef?.focus();
      return true;
    }

    if (root === 'resume') {
      const candidates = projectStore.currentPath ? sessionStore.sessionsForProject(projectStore.currentPath) : sessionStore.sessions;
      const previous = [...candidates]
        .filter((session) => session.id !== sessionStore.activeSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (previous) sessionStore.activeSessionId = previous.id;
      else toastStore.info('No previous chat is available for this project');
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

    if (root === 'beginner') {
      await modeStore.setMode('beginner');
      return true;
    }

    if (root === 'advanced') {
      await modeStore.setMode('advanced');
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

    toastStore.error(`Unknown command: /${root}. Use /help`);
    return true;
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

  async function readFolderFromTauri(folderPath: string): Promise<{ title: string; text: string; folderName: string; fileCount: number; path: string } | null> {
    try {
      const result = await invoke<{ folder_name: string; files: Array<{ path: string; content?: string }> }>('read_folder_contents', {
        folderPath
      });

      const MAX_TOTAL_CHARS = 16000;
      let total = 0;
      const parts: string[] = [];

      for (const file of result.files) {
        if (total >= MAX_TOTAL_CHARS) break;
        if (file.content) {
          const slice = file.content.length + total > MAX_TOTAL_CHARS
            ? file.content.slice(0, MAX_TOTAL_CHARS - total)
            : file.content;
          total += slice.length;
          parts.push(`--- ${file.path} ---\n${slice}`);
        }
      }

      const fileList = result.files.map(f => f.path).join('\n');
      if (fileList && total < MAX_TOTAL_CHARS) {
        const remaining = MAX_TOTAL_CHARS - total;
        const listSlice = fileList.length > remaining ? fileList.slice(0, remaining) + '\n... (truncated)' : fileList;
        parts.push(`\n--- File List ---\n${listSlice}`);
      }

      const text = parts.join('\n\n');
      const title = `Project: ${result.folder_name}`.slice(0, 64);

      return {
        title,
        text,
        folderName: result.folder_name,
        fileCount: result.files.length,
        path: folderPath
      };
    } catch (error) {
      console.error('Failed to read folder:', error);
      return null;
    }
  }

  /** Opening a project always creates a fresh chat. History is explicit via
   * /resume or the sidebar and is never reopened as a folder-open side effect. */
  async function openProjectAtPath(
    path: string,
    fresh: { title: string; text: string; fileName?: string },
  ) {
    projectStore.setProject(path);
    await sessionStore.fetchSessions();
    await createProjectFromText(fresh.title, fresh.text, {
      source: 'file', fileName: fresh.fileName, path,
    });
    toastStore.success(`Opened ${projectDisplayName(path)} — new chat`);
  }

  async function createProjectFromText(
    title: string,
    text: string,
    options?: { source?: RecentProject['source']; fileName?: string; path?: string }
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
      await createProjectFromText(result.title, result.text, { source: 'file', fileName: result.fileName });
      if (result.truncated) {
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
      const result = await readProjectFolder(files);
      if (!result) {
        toastStore.error('Failed to open project from folder');
        return;
      }
      await createProjectFromText(result.title, result.text, { source: 'file', fileName: result.folderName, path: result.folderName });
      toastStore.success(`Opened project from folder: ${result.folderName} (${result.fileCount} files)`);
    } catch {
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

  async function handleMenuAction(action: string) {
    switch (action) {
      case 'new_project': {
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

        if (!inTauri) {
          await createProjectFromText(
            `New Project ${new Date().toLocaleDateString()}`,
            buildNewProjectTemplate(),
            { source: 'new' }
          );
          break;
        }

        try {
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break;

          const projectName = prompt('Enter project name:', 'New Project');
          if (!projectName || !projectName.trim()) break;

          const projectPath = await invoke<string>('create_project_folder', {
            parentPath: selectedPath,
            projectName: projectName.trim()
          });

          toastStore.success(`Created project folder: ${projectPath}`);

          // Brand-new folder → scope future chats to it and start fresh.
          projectStore.setProject(projectPath);
          await createProjectFromText(
            projectName.trim(),
            buildNewProjectTemplate(),
            { source: 'new', path: projectPath }
          );
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
        if (!inTauri) { toastStore.error('Workspace folders require the desktop app'); break; }
        try {
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break;
          const projects = await invoke<string[]>('list_workspace_projects', { folderPath: selectedPath });
          projectStore.setWorkspace(selectedPath, projects);
          sessionStore.activeSessionId = '';
          toastStore.success(`Opened workspace ${projectDisplayName(selectedPath)} with ${projects.length} project folders`);
        } catch (error) { toastStore.error(String(error)); }
        break;
      }
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
      case 'toggle_notes':
        showNotes = !showNotes;
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
          await sessionStore.createSession();
        }
        break;
    }
  }

  function handleSend(message: string, model?: string, reasoningLevel?: string, attachments?: Array<{type: string, data: string, name: string}>) {
    if (!projectStore.currentPath) {
      toastStore.error('Open a project first to chat with an agent');
      return;
    }
    const configurationWarning = getModelConfigurationWarning(wsStore.providers, model);
    if (configurationWarning) {
      toastStore.error(configurationWarning);
      showSettings = true;
      return;
    }
    if (!sessionStore.activeSessionId || (!message.trim() && !(attachments && attachments.length > 0))) return;
    if (agentRail.selectedAgentId) {
      wsStore.sendAgentMessage(sessionStore.activeSessionId, agentRail.selectedAgentId, message);
      return;
    }
    wsStore.sendMessage(sessionStore.activeSessionId, message, model, reasoningLevel, attachments);
  }

  function handleStop() {
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    if (agentRail.selectedAgentId) {
      wsStore.markAgentStopped(agentRail.selectedAgentId);
      apiFetch(apiUrl(`/api/agent/${agentRail.selectedAgentId}/cancel`), { method: 'POST' }).catch(() => {});
      return;
    }
    wsStore.markSessionAgentsStopped(sid);
    wsStore.clearAnalyzing();
    apiFetch(apiUrl(`/api/sessions/${sid}/cancel`), { method: 'POST' })
      .catch(() => {});
  }

  let activeAgents = $derived([...wsStore.agents.values()].filter(a =>
    a.sessionId === sessionStore.activeSessionId && a.status !== 'done' && a.status !== 'idle'
  ));
  let composerFileMentions = $derived(
    composerProjectFiles.length > 0
      ? composerProjectFiles
      : extractProjectFiles(currentProjectContent),
  );
  let connectedProviders = $derived(wsStore.providers.filter(p => p.authenticated).length);
  let connectionDot = $derived(
    wsStore.status === 'connected' ? 'bg-emerald-500' :
    wsStore.status === 'connecting' ? 'bg-amber-500 animate-pulse' :
    'bg-red-500'
  );
  let connectionStatusLabel = $derived(
    wsStore.status === 'connected' ? 'Realtime connected' :
    wsStore.status === 'connecting' ? 'Realtime connecting' :
    wsStore.status === 'error' ? 'Realtime connection error' :
    'Realtime offline'
  );
</script>

<svelte:head>
  <title>{projectStore.currentPath ? `${projectStore.displayName} — Koryphaios` : 'Koryphaios — AI Agent Orchestrator'}</title>
</svelte:head>

<AppShell
  {showSidebar}
  {zenMode}
  {showGit}
  {showNotes}
  activeSessionId={sessionStore.activeSessionId}
  {connectionDot}
  {connectionStatusLabel}
  {connectedProviders}
  onHideSidebar={() => showSidebar = false}
  onShowSidebar={() => showSidebar = true}
  onCloseNotes={() => showNotes = false}
  {startDragging}
>
  {#snippet menubar()}
    <MenuBar
      {showSidebar}
      {showGit}
      {showAgents}
      {showNotes}
      {zenMode}
      projectName={projectStore.displayName}
      isYoloMode={wsStore.isYoloMode}
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
    <AgentRail rail={agentRail} visible={showAgents} />
  {/snippet}

  {#snippet feed()}
    {#if !projectStore.currentPath}
      <div class="flex-1 flex flex-col items-center justify-center px-8 py-10" style="background: var(--color-surface-1);">
        <div class="max-w-xl w-full text-center rounded-[24px] border px-8 py-10" style="background: linear-gradient(180deg, rgba(213, 178, 97, 0.1), rgba(213, 178, 97, 0.03)); border-color: rgba(213, 178, 97, 0.22);">
          <div class="mb-8">
            <img src="/logo-64.png" alt="Koryphaios" class="mx-auto rounded-2xl opacity-90" style="width: 72px; height: 72px;" />
          </div>

          <h2 class="text-2xl font-semibold mb-3" style="color: var(--color-text-primary);">Open a project to start working</h2>
          <p class="text-sm mb-8 max-w-md mx-auto leading-relaxed" style="color: var(--color-text-secondary);">Koryphaios works best when it can inspect a real codebase, explain the current state, and then make targeted changes.</p>

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
              <div class="mb-3 px-1 text-xs font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">Choose a project for this chat</div>
              <div class="flex flex-wrap gap-2">
                {#each projectStore.openProjects as path (path)}
                  <button type="button" class="rounded-xl border px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--color-surface-2)]" style="border-color: var(--color-border); color: var(--color-text-primary);" onclick={() => handleMenuAction(`select_project:${encodeURIComponent(path)}`)} title={path}>
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
                <span class="text-xs font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">Recent projects</span>
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
                    <span class="shrink-0 text-xs truncate max-w-[150px]" style="color: var(--color-text-muted);">
                      {project.path ? project.path.split('/').pop() || project.path.split('\\').pop() : project.fileName || ''}
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
    <!-- Context occupancy is informational (not cost tracking) — visible in every mode. -->
    {#if wsStore.contextUsage.isReliable}
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
          <div class="flex-1 rounded-full overflow-hidden flex" style="height: 6px; background: var(--color-surface-3);">
            {#if contextSegments}
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
                style="width: {wsStore.contextUsage.percent}%; transition-duration: var(--duration-slower); background: {
                  wsStore.contextUsage.percent > 85 ? '#ef4444' :
                  wsStore.contextUsage.percent > 65 ? '#f59e0b' :
                  'var(--color-accent)'
                };"
              ></div>
            {/if}
          </div>
          {#if wsStore.contextUsage.max > 0}
            <span
              class="shrink-0 tabular-nums"
              style="font-size: var(--text-xs); color: {wsStore.contextUsage.percent > 85 ? '#ef4444' : 'var(--color-text-muted)'};"
            >
              {formatTokenCount(wsStore.contextUsage.used)} / {formatTokenCount(wsStore.contextUsage.max)}
            </span>
          {/if}
        </div>
        {#if contextSegments && contextBarHover}
          <div class="flex items-center gap-4 flex-wrap" style="padding-top: var(--space-2);">
            {#each contextSegments as seg (seg.key)}
              <span class="flex items-center gap-1.5" style="font-size: var(--text-xs); color: var(--color-text-muted);">
                <span class="rounded-full inline-block" style="width: 8px; height: 8px; background: {seg.color};"></span>
                {seg.label}
                <span class="tabular-nums">~{formatTokenCount(seg.tokens)}</span>
              </span>
            {/each}
            <span style="font-size: var(--text-xs); color: var(--color-text-muted); opacity: 0.7;">
              Free {formatTokenCount(Math.max(0, wsStore.contextUsage.max - wsStore.contextUsage.used))}
            </span>
          </div>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#snippet composer()}
    <CommandInput
      bind:inputRef
      bind:value={composerDraft}
      onSend={handleSend}
      onExecuteCommand={handleSlashCommand}
      isRunning={agentRail.selectedAgent ? agentRail.selectedAgentIsRunning : wsStore.isSessionBusy(sessionStore.activeSessionId)}
      onStop={handleStop}
      onOpenSettings={() => showSettings = true}
      slashCommands={composerSlashCommands}
      fileMentions={composerFileMentions}
      onRefreshFileMentions={refreshComposerFileMentions}
      disabled={!projectStore.currentPath}
      disabledMessage="Open a project to start chatting with agents"
      placeholder={agentRail.inputPlaceholder}
    />
  {/snippet}
</AppShell>

<PermissionDialog />
<QuestionDialog />
<ChangesSummary />
<ThemePickerModal open={showThemeQuickMenu} onClose={() => showThemeQuickMenu = false} />

<SettingsDrawer open={showSettings} onClose={() => showSettings = false} />
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />
