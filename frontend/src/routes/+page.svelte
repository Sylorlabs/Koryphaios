<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
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
  import ModeToggle from '$lib/components/ModeToggle.svelte';
  import NoGitWarning from '$lib/components/NoGitWarning.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
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

  const LAYOUT_PREFS_KEY = 'koryphaios-layout-prefs';

  onMount(() => {
    const cleanupTheme = theme.init();
    appStore.initialize(authStore, sessionStore).then(() => {
      wsStore.connect();
    });
    recentProjects = parseRecentProjects();
    loadLayoutPrefs();
    
    // Fetch current mode from backend
    modeStore.fetchMode();

    window.addEventListener('keydown', handleGlobalKeydown);
    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
    };
  });

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (activeId && wsStore.status === 'connected') {
      wsStore.subscribeToSession(activeId);
    }
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

  async function createProjectFromText(
    title: string,
    text: string,
    options?: { source?: RecentProject['source']; fileName?: string }
  ) {
    const sessionId = await createProjectSession(title, text);
    if (!sessionId) return;

    recentProjects = addRecentProject(recentProjects, {
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
      await createProjectFromText(result.title, result.text, { source: 'file', fileName: result.folderName });
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

  function handleSend(message: string, model?: string, reasoningLevel?: string) {
    if (!sessionStore.activeSessionId || !message.trim()) return;
    wsStore.sendMessage(sessionStore.activeSessionId, message, model, reasoningLevel);
  }

  function handleStop() {
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    wsStore.markSessionAgentsStopped(sid);
    wsStore.clearAnalyzing();
    fetch(apiUrl(`/api/sessions/${sid}/cancel`), { method: 'POST', credentials: 'include' })
      .catch(() => {});
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
    <nav 
      class="shrink-0 border-r flex flex-col" 
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
        class="flex items-center justify-between px-4 border-b shrink-0" 
        style="height: var(--header-height); border-color: var(--color-border);"
      >
        <div class="flex items-center gap-3 min-w-0">
          <img src="/logo-64.png" alt="Koryphaios" class="rounded-md shrink-0" style="width: var(--size-7); height: var(--size-7);" />
          <div class="flex flex-col justify-center min-w-0">
            <h1 class="text-sm font-semibold leading-tight" style="color: var(--color-text-primary);">Koryphaios</h1>
            <p class="leading-tight" style="font-size: var(--text-xs); color: var(--color-text-muted);">v0.1.0</p>
          </div>
        </div>
        <button
          class="rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
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
      
      <div class="flex-1 overflow-hidden">
        <SessionSidebar 
          currentSessionId={sessionStore.activeSessionId} 
        />
      </div>
      
      <!-- Mode Toggle & Sidebar footer -->
      <div 
        class="px-3 py-2 border-t flex flex-col gap-2 shrink-0" 
        style="border-color: var(--color-border);"
      >
        <!-- Mode Toggle -->
        <div class="flex justify-center">
          <ModeToggle variant="switch" />
        </div>
        
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="rounded-full {connectionDot}" style="width: var(--size-2); height: var(--size-2);"></div>
            <span class="capitalize leading-none" style="font-size: var(--text-xs); color: var(--color-text-muted);">{wsStore.status}</span>
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
      </div>
    </nav>
  {:else if !zenMode}
    <div 
      class="shrink-0 border-r flex flex-col items-center" 
      style="width: var(--sidebar-width-collapsed); border-color: var(--color-border); background: var(--color-surface-1);"
    >
      <div 
        class="w-full border-b flex items-center justify-center" 
        style="height: var(--header-height); border-color: var(--color-border);"
      >
        <button
          class="rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
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
  <div class="flex-1 flex min-w-0">
    <div class="flex-1 flex flex-col min-w-0 relative">
    <!-- Top bar -->
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
    {#if !zenMode && showAgents && modeStore.showAgentDetails && activeAgents.length > 0}
      <div class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        {#each activeAgents as agent (agent.identity.id + agent.status)}
          <WorkerCard {agent} />
        {/each}
      </div>
    {:else if !zenMode && showAgents && modeStore.showAgentDetails}
      <div class="px-4 py-2 border-b flex items-center justify-center shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
        <span class="text-xs opacity-40" style="color: var(--color-text-muted);">No agents running</span>
      </div>
    {/if}

    <!-- File Edit Preview (Cursor-style streaming) -->
    <FileEditPreview />

    <!-- Chat / Feed area -->
    <section class="flex-1 overflow-hidden flex flex-col" role="main" aria-label="Chat feed">
      {#if gitStore.state.activeDiff}
        <DiffEditor />
      {:else}
        <ManagerFeed />
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
    <div class="shrink-0 border-t" style="border-color: var(--color-border); background: var(--color-surface-1);">
      <CommandInput
        bind:inputRef
        onSend={handleSend}
        isRunning={wsStore.managerStatus !== 'idle' && wsStore.managerStatus !== 'done'}
        onStop={handleStop}
      />
    </div>
  </div>

  {#if !zenMode && showGit && modeStore.showGitPanel}
      <aside 
        class="border-l shrink-0" 
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

