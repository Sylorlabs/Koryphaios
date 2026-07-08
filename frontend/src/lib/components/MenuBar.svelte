<script lang="ts">
  import {
    Settings,
    Activity,
    ChevronDown,
    GitBranch,
    Download,
    Zap,
    Search,
    Minus,
    Square,
    X,
    StickyNote,
    Flag,
  } from 'lucide-svelte';
  import CheckForUpdatesButton from './CheckForUpdatesButton.svelte';
  import { getModKeyName } from '$lib/utils/platform';
  import { formatRecentDate, promptTemplates } from '$lib/utils/projectManager';
  import type { RecentProject } from '$lib/utils/projectManager';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { invoke } from '@tauri-apps/api/core';
  import { projectStore, projectDisplayName } from '$lib/stores/project.svelte';
  import { updater } from '$lib/stores/updater.svelte';
  import FeedbackDialog from './FeedbackDialog.svelte';
  import { isDemoMode } from '$lib/demo.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    showSidebar: boolean;
    showGit: boolean;
    showAgents: boolean;
    showNotes?: boolean;
    zenMode: boolean;
    projectName: string | null | undefined;
    isYoloMode: boolean;
    activeAgents: Array<{ identity: { id: string } }>;
    recentProjects: RecentProject[];
    onAction: (action: string) => void;
  }

  let {
    showSidebar,
    showGit,
    showAgents,
    showNotes = false,
    zenMode,
    projectName,
    isYoloMode,
    activeAgents,
    recentProjects,
    onAction,
  }: Props = $props();

  let openMenu = $state<'file' | 'edit' | 'view' | null>(null);
  let isMaximized = $state(false);
  let inTauri = $state(false);
  let feedbackOpen = $state(false);

  async function minimizeWindow() {
    if (!browser || !inTauri) return;
    try {
      await invoke('minimize_window_cmd');
    } catch (e) {
      console.error('Failed to minimize window:', e);
    }
  }

  async function toggleMaximize() {
    if (!browser || !inTauri) return;
    try {
      await invoke('toggle_maximize');
      // Update maximized state
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      isMaximized = await getCurrentWindow().isMaximized();
    } catch (e) {
      console.error('Failed to toggle maximize:', e);
    }
  }

  async function closeWindow() {
    if (!browser || !inTauri) return;
    try {
      await invoke('close_window_cmd');
    } catch (e) {
      console.error('Failed to close window:', e);
    }
  }

  onMount(() => {
    // Tauri v2 detection
    inTauri =
      typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

    if (inTauri) {
      // Get initial maximized state
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => {
          getCurrentWindow()
            .isMaximized()
            .then((v: boolean) => {
              isMaximized = v;
            });
        })
        .catch(() => {});
    }

    function handleWindowClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-top-menu]')) return;
      openMenu = null;
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape' && openMenu) {
        openMenu = null;
      }
    }

    window.addEventListener('click', handleWindowClick);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('keydown', handleEscape);
    };
  });

  async function startDragging(e: MouseEvent) {
    if (!inTauri) return;

    // Check if we clicked an interactive element (buttons, etc)
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

  function toggleMenu(menu: 'file' | 'edit' | 'view') {
    openMenu = openMenu === menu ? null : menu;
  }

  function action(name: string) {
    openMenu = null;
    onAction(name);
  }

  function sendFeedback() {
    if (isDemoMode) {
      toastStore.warning('Feedback delivery is available in the real Koryphaios app.');
      return;
    }
    feedbackOpen = true;
  }
</script>

{#if !zenMode}
  <header
    class="titlebar flex items-center justify-between gap-3 px-3 border-b shrink-0 select-none"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
    data-tauri-drag-region
    onmousedown={startDragging}
    role="presentation"
  >
    <!-- Left: App menus -->
    <div class="flex items-center gap-2 min-w-0">
      <div class="flex items-center gap-1" data-top-menu>
        <div class="relative" data-top-menu>
          <button
            type="button"
            class="px-2.5 py-1.5 text-sm rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={() => toggleMenu('file')}
            data-tauri-drag-region="false"
          >
            File
          </button>
          {#if openMenu === 'file'}
            <div
              class="absolute left-0 top-10 z-30 min-w-[260px] border p-1.5 shadow-2xl"
              style="background: var(--color-surface-2); border-color: var(--color-border); border-radius: 0.5rem;"
            >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('new_project')}>New Project</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('open_project_folder')}>Open Project...</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('open_workspace')}>Open Workspace...</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-secondary);"
                onclick={() => action('open_project_file')}>Import Project File...</button
              >
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              <div
                class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider"
                style="color: var(--color-text-muted);"
              >
                Recent projects
              </div>
              {#if recentProjects.length > 0}
                {#each recentProjects.slice(0, 6) as project (project.id)}
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-2 text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                    style="color: var(--color-text-primary);"
                    onclick={() => action(`open_recent:${project.id}`)}
                    title={project.path || project.fileName || project.title}
                  >
                    <span class="truncate">{project.title}</span>
                    <span
                      class="shrink-0 text-[10px] truncate max-w-[120px]"
                      style="color: var(--color-text-muted);"
                      >{project.path ||
                        project.fileName ||
                        formatRecentDate(project.updatedAt)}</span
                    >
                  </button>
                {/each}
              {:else}
                <div class="px-2.5 py-1.5 text-xs" style="color: var(--color-text-muted);">
                  No recent projects yet
                </div>
              {/if}
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('new_session')}>New Session</button
              >
            </div>
          {/if}
        </div>

        <div class="relative" data-top-menu>
          <button
            type="button"
            class="px-2.5 py-1.5 text-sm rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={() => toggleMenu('edit')}
            data-tauri-drag-region="false"
          >
            Edit
          </button>
          {#if openMenu === 'edit'}
            <div
              class="absolute left-0 top-10 z-30 min-w-[220px] border p-1.5 shadow-2xl"
              style="background: var(--color-surface-2); border-color: var(--color-border); border-radius: 0.5rem;"
            >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('focus_input')}>Focus Prompt Input</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('clear_feed')}>Clear Current Feed</button
              >
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              {#each promptTemplates as template (template.id)}
                <button
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-primary);"
                  onclick={() => action(`template_${template.id}`)}
                >
                  {template.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="relative" data-top-menu>
          <button
            type="button"
            class="px-2.5 py-1.5 text-sm rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={() => toggleMenu('view')}
            data-tauri-drag-region="false"
          >
            View
          </button>
          {#if openMenu === 'view'}
            <div
              class="absolute left-0 top-10 z-30 min-w-[220px] border p-1.5 shadow-2xl"
              style="background: var(--color-surface-2); border-color: var(--color-border); border-radius: 0.5rem;"
            >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('toggle_sidebar')}
                >{showSidebar ? 'Hide' : 'Show'} Sidebar</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('toggle_zen_mode')}
                >{zenMode ? 'Disable' : 'Enable'} Zen Mode</button
              >
              {#if modeStore.showAgentDetails}
                <button
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-primary);"
                  onclick={() => action('toggle_agents')}
                  >{showAgents ? 'Hide' : 'Show'} Active Agents</button
                >
              {/if}
              {#if modeStore.showGitPanel}
                <button
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                  style="color: var(--color-text-primary);"
                  onclick={() => action('toggle_git')}
                  >{showGit ? 'Hide' : 'Show'} Source Control</button
                >
              {/if}
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('toggle_theme')}>Switch Theme...</button
              >
              <button
                type="button"
                class="w-full text-left px-2.5 py-1.5 text-xs hover:bg-[var(--color-surface-3)]"
                style="color: var(--color-text-primary);"
                onclick={() => action('open_settings')}>Open Settings</button
              >
              {#if inTauri}
                <div class="h-px my-1" style="background: var(--color-border);"></div>
                <CheckForUpdatesButton variant="menu-item" />
              {/if}
            </div>
          {/if}
        </div>
      </div>

      {#if isYoloMode}
        <span class="flex items-center gap-1.5 px-1 py-2 text-red-400">
          <Zap size={12} fill="currentColor" />
          <span class="text-xs font-semibold">YOLO</span>
        </span>
      {/if}
    </div>

    <div class="flex-1 flex items-center justify-center h-full" data-tauri-drag-region>
      <!-- Fixed to the viewport center so the project name stays in the top
           middle regardless of sidebar/panel state. -->
      {#if projectStore.currentPath}
        <div
          class="max-w-[360px] truncate px-3 text-xs font-medium pointer-events-none"
          style="position: fixed; left: 50vw; transform: translateX(-50%); color: var(--color-text-secondary);"
          title={projectStore.currentPath}
        >
          {projectStore.displayName}
        </div>
      {:else if projectStore.workspaceRoot}
        <div
          class="max-w-[360px] truncate px-3 text-xs font-medium pointer-events-none"
          style="position: fixed; left: 50vw; transform: translateX(-50%); color: var(--color-text-secondary);"
          title={projectStore.workspaceRoot}
        >
          {projectDisplayName(projectStore.workspaceRoot)} (workspace)
        </div>
      {:else}
        <span
          class="text-xs pointer-events-none"
          style="position: fixed; left: 50vw; transform: translateX(-50%); color: var(--color-text-muted);"
          >No project selected</span
        >
      {/if}
    </div>

    <!-- Right: Controls -->
    <div class="flex items-center gap-1.5">
      {#if updater.updateAvailable}
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-2 transition-colors bg-[var(--color-accent)]/12 hover:bg-[var(--color-accent)]/20"
          style="color: var(--color-accent); border-radius: var(--radius-lg);"
          onclick={() => updater.openDialog()}
          data-tauri-drag-region="false"
          title="Update available — v{updater.updateInfo?.version ?? ''}"
        >
          <Download size={14} />
          <span class="text-xs font-semibold"
            >Update{updater.updateInfo?.version ? ` v${updater.updateInfo.version}` : ''}</span
          >
        </button>
      {/if}
      {#if modeStore.showGitPanel}
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
          style="color: {showGit ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
          onclick={() => action('toggle_git')}
          data-tauri-drag-region="false"
        >
          <GitBranch size={14} />
          <span class="text-xs font-medium">{showGit ? 'Git open' : 'Git'}</span>
        </button>
      {/if}
      <button
        type="button"
        class="group flex items-center gap-1.5 rounded-lg px-3 py-2 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)]"
        data-tauri-drag-region="false"
        title="Send feedback to micah.cooley@sylorlabs.com"
        onclick={sendFeedback}
      >
        <Flag size={14} class="transition-colors group-hover:text-red-400" />
        <span class="text-xs font-medium">Feedback</span>
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
        style="color: {showNotes ? 'var(--color-accent)' : 'var(--color-text-secondary)'};"
        onclick={() => action('toggle_notes')}
        data-tauri-drag-region="false"
        title="Notes (Ctrl+Shift+N)"
      >
        <StickyNote size={14} />
        <span class="text-xs font-medium">{showNotes ? 'Notes open' : 'Notes'}</span>
      </button>
      <button
        type="button"
        class="flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
        style="color: var(--color-text-secondary);"
        onclick={() => action('toggle_palette')}
        data-tauri-drag-region="false"
        title="Command Palette ({getModKeyName()}K)"
      >
        <Search size={14} />
        <span class="text-xs font-medium">Commands</span>
        <kbd class="kbd opacity-80">{getModKeyName()}K</kbd>
      </button>

      {#if activeAgents.length > 0}
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors hover:bg-[var(--color-surface-2)]"
          style="background: transparent;"
          onclick={() => action('toggle_agents')}
          data-tauri-drag-region="false"
        >
          <Activity size={12} class="text-emerald-400" />
          <span class="text-xs font-medium leading-none" style="color: var(--color-text-secondary);"
            >{activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}</span
          >
          <ChevronDown
            size={12}
            class="transition-transform {showAgents ? 'rotate-180' : ''}"
            style="color: var(--color-text-muted);"
          />
        </button>
      {/if}
      <button
        type="button"
        class="p-2.5 rounded-lg transition-colors hover:bg-[var(--color-surface-2)] flex items-center justify-center"
        style="color: var(--color-text-secondary);"
        onclick={() => action('open_settings')}
        title="Settings ({getModKeyName()},)"
        aria-label="Open settings"
        data-tauri-drag-region="false"
      >
        <Settings size={18} />
      </button>

      {#if inTauri}
        <!-- Window controls separator -->
        <div class="w-px h-5 mx-1 shrink-0" style="background: var(--color-border);"></div>
        <!-- Minimize -->
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={minimizeWindow}
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus size={14} />
        </button>
        <!-- Maximize / Restore -->
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={toggleMaximize}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        >
          <Square size={13} />
        </button>
        <!-- Close -->
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-red-500/80 hover:text-white"
          style="color: var(--color-text-muted);"
          onclick={closeWindow}
          title="Close"
          aria-label="Close window"
        >
          <X size={14} />
        </button>
      {/if}
    </div>
  </header>
{:else}
  <!-- Drag region for Zen Mode -->
  <div
    class="absolute top-0 left-0 right-0 h-4 z-10"
    data-tauri-drag-region
    onpointerdown={startDragging}
    role="presentation"
    style="-webkit-app-region: drag;"
  ></div>

  <button
    type="button"
    class="absolute top-1.5 right-4 z-20 px-3.5 py-1.5 text-xs border rounded-full transition-all duration-200 hover:bg-[var(--color-surface-3)] hover:border-[var(--color-border-bright)] hover:scale-105 active:scale-95 shadow-lg"
    style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary); -webkit-app-region: no-drag;"
    onclick={() => action('toggle_zen_mode')}
  >
    Exit Zen
  </button>
{/if}

<FeedbackDialog open={feedbackOpen} onClose={() => (feedbackOpen = false)} />

<style>
  /* Enable window dragging */
  .titlebar {
    height: var(--header-height);
  }

  /* Ensure buttons and interactive elements are clickable */
  .titlebar button,
  .titlebar [data-top-menu] {
    cursor: pointer;
  }
</style>
