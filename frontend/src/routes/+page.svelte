<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import AgentThreadFeed from '$lib/components/AgentThreadFeed.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import SourceControlPanel from '$lib/components/SourceControlPanel.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import ChangesSummary from '$lib/components/ChangesSummary.svelte';
  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import MenuBar from '$lib/components/MenuBar.svelte';
  import ThemePickerModal from '$lib/components/ThemePickerModal.svelte';

  import NoGitWarning from '$lib/components/NoGitWarning.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { ChevronLeft, ChevronRight, FolderOpen, FolderPlus, Clock } from 'lucide-svelte';
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
  let selectedAgentId = $state<string>('');
  let composerDraft = $state('');
  let currentProjectContent = $state('');

  const composerSlashCommands = [
    { command: 'new', label: 'New Session', description: 'Create a fresh session.' },
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
    });
    recentProjects = parseRecentProjects();
    loadLayoutPrefs();

    window.addEventListener('keydown', handleGlobalKeydown);
    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
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

  let lastSubscribedSessionId = $state<string>('');

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (!activeId) {
      if (lastSubscribedSessionId !== '') {
        wsStore.clearFeed();
        lastSubscribedSessionId = '';
      }
      return;
    }

    if (activeId !== lastSubscribedSessionId) {
      lastSubscribedSessionId = activeId;
      
      // Subscribe to the WS session if connected
      if (wsStore.status === 'connected') {
        wsStore.subscribeToSession(activeId);
      }
      
      // Load history
      void (async () => {
        const messages = await sessionStore.fetchMessages(activeId);
        wsStore.loadSessionMessages(activeId, messages);
      })();
    } else if (wsStore.status === 'connected' && activeId === lastSubscribedSessionId) {
      // Re-subscribe if we just connected and we haven't subscribed yet
      // But wait, the subscribeToSession call on reconnect is actually handled in websocket.svelte.ts:
      // "if (activeSid) subscribeToSession(activeSid);" inside ws.onopen
      // So we don't strictly need it here for reconnects, but let's be safe:
      wsStore.subscribeToSession(activeId);
    }
  });

  let lastLoadedAgentThreadsSessionId = $state('');

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (activeId && activeId !== lastLoadedAgentThreadsSessionId) {
      lastLoadedAgentThreadsSessionId = activeId;
      selectedAgentId = '';
      void wsStore.loadAgentThreads(activeId);
    }
  });

  let lastLoadedAgentThreadKey = $state('');

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    const selectedId = selectedAgentId;
    if (!activeId || !selectedId) return;
    const key = `${activeId}:${selectedId}`;
    if (key === lastLoadedAgentThreadKey) return;
    lastLoadedAgentThreadKey = key;
    void wsStore.loadAgentThreadMessages(activeId, selectedId);
  });

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
      toastStore.info('Commands: /new, /compact, /yolo, /beginner, /advanced, /clear, /settings, /theme, /sidebar, /zen');
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

  // Read folder contents using Tauri (for desktop app)
  async function readFolderFromTauri(folderPath: string): Promise<{ title: string; text: string; folderName: string; fileCount: number; path: string } | null> {
    try {
      const result = await invoke<{ folder_name: string; files: Array<{ path: string; content?: string }> }>('read_folder_contents', {
        folderPath
      });
      
      const MAX_TOTAL_CHARS = 16000;
      let total = 0;
      const parts: string[] = [];
      
      // First, add files with content (key files like README, package.json, etc.)
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
      
      // Then, add the file list
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

    await createProjectFromText(found.title, found.content, {
      source: found.source,
      fileName: found.fileName,
    });
    toastStore.success(`Opened recent project: ${found.title}`);
  }

  async function handleMenuAction(action: string) {
    switch (action) {
      case 'new_project': {
        // Check if we're in Tauri desktop app (Tauri v2 uses __TAURI_INTERNALS__)
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        
        if (!inTauri) {
          // Fallback for web: create project without folder selection
          await createProjectFromText(
            `New Project ${new Date().toLocaleDateString()}`,
            buildNewProjectTemplate(),
            { source: 'new' }
          );
          break;
        }
        
        try {
          // Step 1: Open folder dialog to select parent directory
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break; // User cancelled
          
          // Step 2: Prompt for project name
          const projectName = prompt('Enter project name:', 'New Project');
          if (!projectName || !projectName.trim()) break; // User cancelled or empty
          
          // Step 3: Create the project folder
          const projectPath = await invoke<string>('create_project_folder', {
            parentPath: selectedPath,
            projectName: projectName.trim()
          });
          
          // Step 4: Open the newly created folder as project
          toastStore.success(`Created project folder: ${projectPath}`);
          
          // Create a new project session with the folder info
          await createProjectFromText(
            projectName.trim(),
            buildNewProjectTemplate(),
            { source: 'new' }
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
        // Check if we're in Tauri desktop app (Tauri v2 uses __TAURI_INTERNALS__)
        const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
        
        if (!inTauri) {
          // Fallback for web: use the file input
          projectFolderInput?.click();
          break;
        }
        
        try {
          // Use Tauri folder dialog for native folder selection
          const selectedPath = await invoke<string | null>('select_folder_dialog');
          if (!selectedPath) break; // User cancelled
          
          // Create a mock FileList from the selected folder path
          // We'll need to read the folder contents via Tauri
          const result = await readFolderFromTauri(selectedPath);
          if (!result) {
            toastStore.error('Failed to open folder');
            break;
          }
          
          await createProjectFromText(result.title, result.text, { source: 'file', fileName: result.folderName, path: selectedPath });
          toastStore.success(`Opened project from folder: ${result.folderName} (${result.fileCount} files)`);
        } catch (error) {
          toastStore.error(String(error));
        }
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
        }
        break;
    }
  }

  function handleSend(message: string, model?: string, reasoningLevel?: string, attachments?: Array<{type: string, data: string, name: string}>) {
    if (!appStore.projectName) {
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
    if (selectedAgentId) {
      // NOTE: currently agent thread send might not support attachments, but we'll pass them if wsStore updates
      wsStore.sendAgentMessage(sessionStore.activeSessionId, selectedAgentId, message);
      return;
    }
    wsStore.sendMessage(sessionStore.activeSessionId, message, model, reasoningLevel, attachments);
  }

  function handleStop() {
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    if (selectedAgentId) {
      wsStore.markAgentStopped(selectedAgentId);
      apiFetch(apiUrl(`/api/agent/${selectedAgentId}/cancel`), { method: 'POST' }).catch(() => {});
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
  let sessionAgentChats = $derived(
    [...wsStore.agents.values()]
      .filter((a) =>
        a.sessionId === sessionStore.activeSessionId &&
        a.identity.id !== 'kory-manager' &&
        (a.identity.role === 'critic' || a.identity.role === 'coder')
      )
      .sort((a, b) => {
        const activeWeight = (status: typeof a.status) =>
          status !== 'done' && status !== 'idle' ? 1 : 0;
        return activeWeight(b.status) - activeWeight(a.status);
      })
  );
  let selectedAgent = $derived(
    selectedAgentId ? wsStore.agents.get(selectedAgentId) ?? null : null
  );
  let selectedAgentFeed = $derived.by(() => {
    const _version = wsStore.agentThreadVersion;
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId || !selectedAgentId) return [];
    return wsStore.getAgentThreadFeed(sessionId, selectedAgentId);
  });
  let selectedAgentIsRunning = $derived(
    !!selectedAgent && selectedAgent.status !== 'done' && selectedAgent.status !== 'idle'
  );
  let inputPlaceholder = $derived(
    selectedAgent
      ? `What's the move for ${selectedAgent.identity.name}?`
      : "What's the move?"
  );
  let composerFileMentions = $derived(extractProjectFiles(currentProjectContent));
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

  $effect(() => {
    if (!selectedAgentId) return;
    const activeId = sessionStore.activeSessionId;
    const exists = sessionAgentChats.some((agent) => agent.identity.id === selectedAgentId);
    if (!activeId || !exists) {
      selectedAgentId = '';
    }
  });
</script>

<svelte:head>
  <title>{appStore.projectName ? `${appStore.projectName} — Koryphaios` : 'Koryphaios — AI Agent Orchestrator'}</title>
</svelte:head>

<div class="flex h-screen min-h-0 min-w-0 overflow-hidden" style="background: var(--color-surface-0);">
  <!-- Sidebar -->
  {#if showSidebar}
    <nav 
      class="shrink-0 border-r flex min-h-0 flex-col" 
      style="
        width: var(--sidebar-width); 
        min-width: var(--sidebar-min-width); 
        max-width: var(--sidebar-max-width); 
        border-color: var(--color-border); 
        background: var(--color-surface-1);
      " 
      aria-label="Session navigation"
    >
      <!-- Logo + project -->
      <div 
        class="sidebar-header flex items-center justify-between px-4 border-b shrink-0" 
        style="height: var(--header-height); border-color: var(--color-border);"
        data-tauri-drag-region
        onmousedown={startDragging}
        role="presentation"
      >
        <div class="flex items-center gap-3 min-w-0 pointer-events-none">
          <img src="/logo-64.png" alt="Koryphaios" class="rounded-lg shrink-0" style="width: var(--size-8); height: var(--size-8);" />
          <div class="flex flex-col justify-center min-w-0">
            <h1 class="text-sm font-semibold leading-tight" style="color: var(--color-text-primary);">Koryphaios</h1>
            <p class="leading-tight" style="font-size: var(--text-xs); color: var(--color-text-muted);">Agent workspace</p>
          </div>
        </div>
        <button
          type="button"
          class="sidebar-header-button rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="padding: var(--space-2); color: var(--color-text-muted);"
          onclick={() => showSidebar = false}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <!-- No Git Warning (Beginner Mode) -->
      <NoGitWarning />
      
      <div class="flex-1 min-h-0 overflow-hidden">
        <SessionSidebar 
          currentSessionId={sessionStore.activeSessionId} 
        />
      </div>
      
      <!-- Sidebar footer -->
      <div 
        class="px-4 py-3 border-t flex items-center justify-between shrink-0" 
        style="border-color: var(--color-border); background: var(--color-surface-2);"
      >
        <div class="flex items-center gap-2">
          <div class="rounded-full {connectionDot}" style="width: var(--size-2); height: var(--size-2);"></div>
          <span class="leading-none" style="font-size: var(--text-xs); color: var(--color-text-muted);" title={connectionStatusLabel}>{connectionStatusLabel}</span>
        </div>
        <div class="flex items-center gap-1">
          {#if connectedProviders > 0}
            <span 
              class="px-1.5 py-0.5 rounded leading-none" 
              style="font-size: var(--text-xs); background: var(--color-surface-3); color: var(--color-text-muted);"
            >
              {connectedProviders} providers
            </span>
          {/if}
        </div>
      </div>
    </nav>
  {:else if !zenMode}
    <div 
      class="shrink-0 border-r flex min-h-0 flex-col items-center" 
      style="width: var(--sidebar-width-collapsed); border-color: var(--color-border); background: var(--color-surface-1);"
    >
      <div 
        class="w-full border-b flex items-center justify-center" 
        style="height: var(--header-height); border-color: var(--color-border);"
      >
        <button
          type="button"
          class="rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="padding: var(--space-2); color: var(--color-text-muted);"
          onclick={() => showSidebar = true}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  {/if}

  <!-- Main Content -->
  <div class="flex-1 flex min-h-0 min-w-0">
    <div class="relative flex flex-1 min-h-0 min-w-0 flex-col">
    <!-- Top bar -->
    <MenuBar
      {showSidebar}
      {showGit}
      {showAgents}
      {zenMode}
      projectName={appStore.projectName}
      koryPhase={wsStore.koryPhase}
      isYoloMode={wsStore.isYoloMode}
      {activeAgents}
      {recentProjects}
      onAction={handleMenuAction}
    />

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

    <!-- Agent cards (collapsible) - only in advanced mode -->
    {#if !zenMode && showAgents && modeStore.showAgentDetails && sessionAgentChats.length > 0}
      <div class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0 items-stretch" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <button
          type="button"
          class="shrink-0 rounded-xl border px-4 py-2 text-left transition-colors"
          style="min-width: 160px; background: {selectedAgentId ? 'var(--color-surface-2)' : 'rgba(213, 178, 97, 0.12)'}; border-color: {selectedAgentId ? 'var(--color-border)' : 'rgba(213, 178, 97, 0.35)'}; color: var(--color-text-primary);"
          onclick={() => selectedAgentId = ''}
        >
          <div class="text-xs font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">Main chat</div>
          <div class="mt-2 text-sm font-semibold">Manager feed</div>
          <div class="mt-1 text-xs" style="color: var(--color-text-secondary);">Talk to Kory and review the full session.</div>
        </button>
        {#each sessionAgentChats as agent (agent.identity.id)}
          <WorkerCard
            {agent}
            selected={selectedAgentId === agent.identity.id}
            onSelect={() => {
              selectedAgentId = agent.identity.id;
              if (sessionStore.activeSessionId) {
                void wsStore.loadAgentThreadMessages(sessionStore.activeSessionId, agent.identity.id);
              }
            }}
          />
        {/each}
      </div>
    {:else if !zenMode && showAgents && modeStore.showAgentDetails}
      <div class="px-4 py-2 border-b flex items-center justify-center shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <span class="text-xs opacity-40" style="color: var(--color-text-muted);">No worker or critic chats yet</span>
      </div>
    {/if}

    <!-- File Edit Preview (Cursor-style streaming) -->
    <FileEditPreview />

    <!-- Chat / Feed area -->
	    <section class="flex flex-1 min-h-0 flex-col overflow-hidden" role="main" aria-label="Chat feed">
	      {#if !appStore.projectName}
	        <!-- Empty state: No project selected -->
	        <div class="flex-1 flex flex-col items-center justify-center px-8 py-10" style="background: var(--color-surface-1);">
	          <div class="max-w-xl w-full text-center rounded-[24px] border px-8 py-10" style="background: linear-gradient(180deg, rgba(213, 178, 97, 0.1), rgba(213, 178, 97, 0.03)); border-color: rgba(213, 178, 97, 0.22);">
	            <!-- Logo -->
	            <div class="mb-8">
	              <img src="/logo-64.png" alt="Koryphaios" class="mx-auto rounded-2xl opacity-90" style="width: 72px; height: 72px;" />
	            </div>
	            
	            <h2 class="text-2xl font-semibold mb-3" style="color: var(--color-text-primary);">Open a project to start working</h2>
	            <p class="text-sm mb-8 max-w-md mx-auto leading-relaxed" style="color: var(--color-text-secondary);">Koryphaios works best when it can inspect a real codebase, explain the current state, and then make targeted changes.</p>
	            
	            <!-- Action buttons -->
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
	                class="flex items-center justify-center gap-3 px-2 py-3 rounded-xl text-sm font-semibold transition-colors hover:bg-[var(--color-surface-2)]"
	                style="color: var(--color-text-primary);"
	                onclick={() => handleMenuAction('new_project')}
	              >
	                <FolderPlus size={18} />
                <span>New Project</span>
              </button>
            </div>
            
            <!-- Recent projects -->
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
      {:else if selectedAgent}
        <AgentThreadFeed
          agent={selectedAgent}
          feed={selectedAgentFeed}
          isStreaming={selectedAgentIsRunning}
        />
      {:else}
        <ManagerFeed onUseSuggestion={loadSuggestionIntoComposer} />
      {/if}
    </section>

    <!-- Context window usage - only in advanced mode -->
    {#if wsStore.contextUsage.isReliable && modeStore.showCostTracking}
      <div 
        class="shrink-0 px-4 flex items-center gap-3" 
        style="padding-top: var(--space-2); padding-bottom: var(--space-2); border-top: 1px solid var(--color-border); background: var(--color-surface-1);"
      >
        <span class="shrink-0" style="font-size: var(--text-xs); color: var(--color-text-muted);">
          Context
        </span>
        <div class="flex-1 rounded-full overflow-hidden" style="height: 6px; background: var(--color-surface-3);">
          <div
            class="h-full rounded-full transition-all"
            style="width: {wsStore.contextUsage.percent}%; transition-duration: var(--duration-slower); background: {
              wsStore.contextUsage.percent > 85 ? '#ef4444' :
              wsStore.contextUsage.percent > 65 ? '#f59e0b' : 
              'var(--color-accent)'
            };"
          ></div>
        </div>
        {#if wsStore.contextUsage.max > 0}
          <span class="shrink-0 tabular-nums" style="font-size: var(--text-xs); color: var(--color-text-muted);">
            {wsStore.contextUsage.used >= 1000 ? `${(wsStore.contextUsage.used / 1000).toFixed(1)}k` : wsStore.contextUsage.used} / {(wsStore.contextUsage.max / 1000).toFixed(1)}k
          </span>
        {/if}
      </div>
    {/if}

    <!-- Command Input -->
	    <div class="shrink-0" style="background: var(--color-surface-1);">
	      <CommandInput
	        bind:inputRef
          bind:value={composerDraft}
	        onSend={handleSend}
          onExecuteCommand={handleSlashCommand}
	        isRunning={selectedAgent ? selectedAgentIsRunning : (wsStore.managerStatus !== 'idle' && wsStore.managerStatus !== 'done')}
	        onStop={handleStop}
	        onOpenSettings={() => showSettings = true}
          slashCommands={composerSlashCommands}
          fileMentions={composerFileMentions}
	        disabled={!appStore.projectName}
	        disabledMessage="Open a project to start chatting with agents"
          placeholder={inputPlaceholder}
	      />
    </div>
  </div>

  {#if !zenMode && showGit && modeStore.showGitPanel}
      <aside 
        class="border-l shrink-0 min-h-0" 
        style="
          width: var(--git-panel-width); 
          max-width: var(--git-panel-max-width); 
          min-width: var(--git-panel-min-width); 
          border-color: var(--color-border); 
          background: var(--color-surface-1);
        "
      >
        <SourceControlPanel />
      </aside>
    {/if}
  </div>
</div>

<PermissionDialog />
<QuestionDialog />
<ChangesSummary />
<ThemePickerModal open={showThemeQuickMenu} onClose={() => showThemeQuickMenu = false} />

<SettingsDrawer open={showSettings} onClose={() => showSettings = false} />
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />

<style>
  .sidebar-header {
    /* Relying on JS onmousedown={startDragging} */
  }

  .sidebar-header-button {
    /* Normal button behavior */
  }
</style>
