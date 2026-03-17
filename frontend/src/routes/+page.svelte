<script lang="ts">
  import { onMount } from 'svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { theme } from '$lib/stores/theme.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { shortcutStore } from '$lib/stores/shortcuts.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { apiUrl } from '$lib/utils/api-url';
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
  
  // Layout components
  import { Sidebar, CommandBar, MainContent } from '$lib/components/layout';
  
  // Dialog components
  import PermissionDialog from '$lib/components/PermissionDialog.svelte';
  import QuestionDialog from '$lib/components/QuestionDialog.svelte';
  import ChangesSummary from '$lib/components/ChangesSummary.svelte';
  import ThemePickerModal from '$lib/components/ThemePickerModal.svelte';
  import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ToastContainer from '$lib/components/ToastContainer.svelte';
  import SourceControlPanel from '$lib/components/SourceControlPanel.svelte';
  import InitOverlay from '$lib/components/InitOverlay.svelte';

  // Layout state
  let showSettings = $state(false);
  let showAgents = $state(false);
  let showSidebar = $state(true);
  let showGit = $state(false);
  let zenMode = $state(false);
  let showCommandPalette = $state(false);
  let showThemeQuickMenu = $state(false);
  let inputRef = $state<HTMLTextAreaElement>();
  let recentProjects = $state<RecentProject[]>([]);

  // Zen mode state preservation
  let layoutBeforeZen = $state({ sidebar: true, agents: false, git: false });

  const LAYOUT_PREFS_KEY = 'koryphaios-layout-prefs';

  onMount(() => {
    const cleanupTheme = theme.init();
    appStore.initialize(authStore, sessionStore).then(() => {
      wsStore.connect();
    });
    recentProjects = parseRecentProjects();
    loadLayoutPrefs();
    modeStore.fetchMode();

    window.addEventListener('keydown', handleGlobalKeydown);
    
    // Listen for DevTools toggle from backend
    const handleToggleDevtools = () => {
      // Try to open DevTools - this might not work in release builds
      // but we can try to emit the keyboard shortcut
      const event = new KeyboardEvent('keydown', { key: 'F12', code: 'F12' });
      window.dispatchEvent(event);
    };
    window.addEventListener('toggle-devtools' as any, handleToggleDevtools);
    
    return () => {
      cleanupTheme?.();
      wsStore.disconnect();
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('toggle-devtools' as any, handleToggleDevtools);
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
      toggleZenMode();
      return;
    }

    if (shortcutStore.matches('toggle_yolo', e)) {
      e.preventDefault();
      setYoloMode(!wsStore.isYoloMode);
      return;
    }

    if (shortcutStore.matches('toggle_devtools', e)) {
      e.preventDefault();
      toggleDevtools();
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
      // Ignore malformed local prefs
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

  function toggleZenMode() {
    if (!zenMode) {
      layoutBeforeZen = { sidebar: showSidebar, agents: showAgents, git: showGit };
      showSidebar = false;
      showAgents = false;
      showGit = false;
      zenMode = true;
    } else {
      zenMode = false;
      showSidebar = layoutBeforeZen.sidebar;
      showAgents = layoutBeforeZen.agents;
      showGit = layoutBeforeZen.git;
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

  async function toggleDevtools() {
    try {
      const win = window as any;
      if (win.__TAURI__?.core?.invoke) {
        await win.__TAURI__.core.invoke('toggle_devtools');
      }
    } catch {
      // DevTools not available
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

  async function handleMenuAction(action: string) {
    switch (action) {
      case 'new_project': {
        const sessionId = await createProjectSession(
          `New Project ${new Date().toLocaleDateString()}`,
          buildNewProjectTemplate()
        );
        if (sessionId) {
          recentProjects = addRecentProject(recentProjects, {
            title: `New Project ${new Date().toLocaleDateString()}`,
            content: buildNewProjectTemplate(),
            source: 'new',
          });
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
      case 'toggle_sidebar':
        showSidebar = !showSidebar;
        break;
      case 'toggle_zen_mode':
        toggleZenMode();
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
          // Handle recent project
          const id = action.slice('open_recent:'.length);
          const found = recentProjects.find((p) => p.id === id);
          if (found) {
            await createProjectSession(found.title, found.content);
            toastStore.success(`Opened recent project: ${found.title}`);
          }
        }
        break;
    }
  }

  // File input handlers
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
      const sessionId = await createProjectSession(result.title, result.text);
      if (sessionId) {
        recentProjects = addRecentProject(recentProjects, {
          title: result.title,
          content: result.text,
          source: 'file',
          fileName: result.fileName,
        });
      }
      if (result.truncated) {
        toastStore.warning('Large file imported; content was truncated');
      } else {
        toastStore.success(`Imported ${file.name}`);
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
      const sessionId = await createProjectSession(result.title, result.text);
      if (sessionId) {
        recentProjects = addRecentProject(recentProjects, {
          title: result.title,
          content: result.text,
          source: 'file',
          fileName: result.folderName,
        });
        toastStore.success(`Opened project: ${result.folderName} (${result.fileCount} files)`);
      }
    } catch {
      toastStore.error('Failed to open project from folder');
    } finally {
      input.value = '';
    }
  }
</script>

<svelte:head>
  <title>{appStore.projectName ? `${appStore.projectName} — Koryphaios` : 'Koryphaios — AI Agent Orchestrator'}</title>
</svelte:head>

<div class="flex h-screen overflow-hidden" style="background: var(--color-surface-0);">
  <!-- Sidebar -->
  <Sidebar 
    {showSidebar} 
    {zenMode}
    onToggle={() => showSidebar = !showSidebar}
  />

  <!-- Main Content Area -->
  <div class="flex-1 flex min-w-0">
    <div class="flex-1 flex flex-col min-w-0 relative">
      <!-- Command Bar -->
      <CommandBar
        {showSidebar}
        {showGit}
        {showAgents}
        {zenMode}
        projectName={appStore.projectName}
        {recentProjects}
        onAction={handleMenuAction}
      />

      <!-- Hidden file inputs -->
      <input
        type="file"
        class="hidden"
        accept=".txt,.md,.json,.yaml,.yml,.toml,.csv"
        onchange={handleProjectFileSelected}
      />
      <input
        type="file"
        class="hidden"
        webkitdirectory
        multiple
        onchange={handleProjectFolderSelected}
      />

      <!-- Main Content (Feed, Agents, Input) -->
      <MainContent
        {showAgents}
        {zenMode}
        bind:inputRef
        onSend={handleSend}
        onStop={handleStop}
      />
    </div>

    <!-- Git Panel -->
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

<!-- Global Modals -->
<PermissionDialog />
<QuestionDialog />
<ChangesSummary />
<ThemePickerModal open={showThemeQuickMenu} onClose={() => showThemeQuickMenu = false} />
<SettingsDrawer open={showSettings} onClose={() => showSettings = false} />
<CommandPalette bind:open={showCommandPalette} onAction={handleMenuAction} />
<ToastContainer />
<InitOverlay />
