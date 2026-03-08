<script lang="ts">
  import {
    Settings,
    Activity,
    ChevronDown,
    GitBranch,
    Zap,
    Search,
    Minus,
    Square,
    X,
  } from 'lucide-svelte';
  import { getModKeyName } from '$lib/utils/platform';
  import { formatRecentDate, promptTemplates } from '$lib/utils/projectManager';
  import type { RecentProject } from '$lib/utils/projectManager';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';

  interface Props {
    showSidebar: boolean;
    showGit: boolean;
    showAgents: boolean;
    zenMode: boolean;
    projectName: string | null | undefined;
    koryPhase: string | null;
    isYoloMode: boolean;
    activeAgents: Array<{ identity: { id: string } }>;
    recentProjects: RecentProject[];
    onAction: (action: string) => void;
  }

  let {
    showSidebar,
    showGit,
    showAgents,
    zenMode,
    projectName,
    koryPhase,
    isYoloMode,
    activeAgents,
    recentProjects,
    onAction,
  }: Props = $props();

  let openMenu = $state<'file' | 'edit' | 'view' | null>(null);
  let isMaximized = $state(false);
  let inTauri = $state(false);

  function getTauriWindow() {
    if (!browser) return null;
    const win = window as any;
    return win.__TAURI__?.window ?? null;
  }

  async function minimizeWindow() {
    const tw = getTauriWindow();
    if (!tw) return;
    const current = tw.getCurrentWindow?.() ?? tw.appWindow;
    await current?.minimize?.();
  }

  async function toggleMaximize() {
    const tw = getTauriWindow();
    if (!tw) return;
    const current = tw.getCurrentWindow?.() ?? tw.appWindow;
    await current?.toggleMaximize?.();
    isMaximized = await current?.isMaximized?.() ?? false;
  }

  async function closeWindow() {
    const tw = getTauriWindow();
    if (!tw) return;
    const current = tw.getCurrentWindow?.() ?? tw.appWindow;
    await current?.close?.();
  }

  onMount(() => {
    const win = window as any;
    inTauri = typeof win.__TAURI__ !== 'undefined';

    if (inTauri) {
      const tw = getTauriWindow();
      const current = tw?.getCurrentWindow?.() ?? tw?.appWindow;
      current?.isMaximized?.().then((v: boolean) => { isMaximized = v; });
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

  function toggleMenu(menu: 'file' | 'edit' | 'view') {
    openMenu = openMenu === menu ? null : menu;
  }

  function action(name: string) {
    openMenu = null;
    onAction(name);
  }
</script>

{#if !zenMode}
  <header
    class="flex items-center justify-between px-2 h-11 border-b shrink-0 select-none"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
    data-tauri-drag-region
  >
    <!-- Left: App logo + menus -->
    <div class="flex items-center gap-1">
      <!-- App logo -->
      <div class="flex items-center justify-center w-8 h-8 rounded-lg mr-1 shrink-0">
        <img src="/logo-64.png" alt="Koryphaios" width="28" height="28" class="rounded-md" />
      </div>

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
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('new_project')}>New Project</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('open_project_file')}>Open Project From File...</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('open_project_folder')}>Open Project From Folder...</button>
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              <div class="px-2.5 py-1.5 text-[10px] uppercase tracking-wider" style="color: var(--color-text-muted);">Recent projects</div>
              {#if recentProjects.length > 0}
                {#each recentProjects.slice(0, 6) as project (project.id)}
                  <button class="w-full flex items-center justify-between gap-2 text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action(`open_recent:${project.id}`)}>
                    <span class="truncate">{project.title}</span>
                    <span class="shrink-0 text-[10px]" style="color: var(--color-text-muted);">{formatRecentDate(project.updatedAt)}</span>
                  </button>
                {/each}
              {:else}
                <div class="px-2.5 py-1.5 text-xs" style="color: var(--color-text-muted);">No recent projects yet</div>
              {/if}
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('save_snapshot')}>Save Project As .kory.json</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('new_session')}>New Session</button>
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
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('focus_input')}>Focus Prompt Input</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('clear_feed')}>Clear Current Feed</button>
              <div class="h-px my-1" style="background: var(--color-border);"></div>
              {#each promptTemplates as template (template.id)}
                <button
                  class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]"
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
            class="px-2 py-1 text-xs rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-text-secondary);"
            onclick={() => toggleMenu('view')}
          >
            View
          </button>
          {#if openMenu === 'view'}
            <div class="absolute left-0 top-8 z-30 min-w-[200px] rounded-lg border p-1" style="background: var(--color-surface-2); border-color: var(--color-border);">
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('toggle_sidebar')}>{showSidebar ? 'Hide' : 'Show'} Sidebar</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('toggle_zen_mode')}>{zenMode ? 'Disable' : 'Enable'} Zen Mode</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('toggle_agents')}>{showAgents ? 'Hide' : 'Show'} Active Agents</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('toggle_theme')}>Switch Theme...</button>
              <button class="w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-[var(--color-surface-3)]" style="color: var(--color-text-primary);" onclick={() => action('open_settings')}>Open Settings</button>
            </div>
          {/if}
        </div>
      </div>

      {#if koryPhase}
        <span class="flex items-center gap-2 min-w-0 max-w-[200px]">
          <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);" aria-hidden="true">|</span>
          <div class="flex items-center gap-2 px-2.5 py-1 rounded-lg" style="background: var(--color-surface-2);">
            <div class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></div>
            <span class="text-xs leading-none" style="color: var(--color-text-secondary);">
              Kory: {koryPhase}
            </span>
          </div>
        </span>
      {/if}

      {#if isYoloMode}
        <span class="flex items-center gap-2 min-w-0">
          <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);" aria-hidden="true">|</span>
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
            <Zap size={12} fill="currentColor" />
            <span class="text-[10px] font-bold tracking-wider uppercase">YOLO mode</span>
          </div>
        </span>
      {/if}
    </div>

    <!-- Center: Project name (VS Code style) -->
    <div class="flex-1 flex items-center justify-center">
      {#if projectName}
        <div class="flex items-center gap-2 px-3 py-1 rounded-md" style="background: var(--color-surface-2);">
          <span class="text-sm font-medium" style="color: var(--color-text-primary);" title={projectName}>
            {projectName}
          </span>
        </div>
      {:else}
        <span class="text-sm" style="color: var(--color-text-muted);">Koryphaios</span>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <button
        class="px-2 py-1 text-[10px] rounded-md transition-colors hover:bg-[var(--color-surface-3)] uppercase tracking-wider"
        style="color: var(--color-text-muted);"
        onclick={() => action('toggle_sidebar')}
        title={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
      >
        {showSidebar ? 'Hide Sidebar' : 'Show Sidebar'}
      </button>
      {#if modeStore.showGitPanel}
        <button
          class="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: {showGit ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
          onclick={() => action('toggle_git')}
          title={showGit ? 'Hide Source Control' : 'Show Source Control'}
        >
          <GitBranch size={14} />
          <span class="text-[10px] font-medium uppercase tracking-wider">{showGit ? 'Hide Git' : 'Show Git'}</span>
        </button>
      {/if}
      <button
        class="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
        style="color: var(--color-text-muted);"
        onclick={() => action('toggle_palette')}
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
          onclick={() => action('toggle_agents')}
        >
          <Activity size={12} class="text-emerald-400" />
          <span class="text-xs leading-none" style="color: var(--color-text-secondary);">{activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}</span>
          <ChevronDown size={12} class="transition-transform {showAgents ? 'rotate-180' : ''}" style="color: var(--color-text-muted);" />
        </button>
      {/if}
      <button
        class="p-2 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] flex items-center justify-center"
        style="color: var(--color-text-muted);"
        onclick={() => action('open_settings')}
        title="Settings ({getModKeyName()},)"
        aria-label="Open settings"
      >
        <Settings size={18} />
      </button>

      {#if inTauri}
        <!-- Window controls separator -->
        <div class="w-px h-5 mx-1 shrink-0" style="background: var(--color-border);"></div>
        <!-- Minimize -->
        <button
          class="flex items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={minimizeWindow}
          title="Minimize"
          aria-label="Minimize window"
        >
          <Minus size={14} />
        </button>
        <!-- Maximize / Restore -->
        <button
          class="flex items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={toggleMaximize}
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        >
          <Square size={13} />
        </button>
        <!-- Close -->
        <button
          class="flex items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-red-500/80 hover:text-white"
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
  <button
    class="absolute top-1 right-4 z-20 px-2.5 py-1 rounded-md text-xs border transition-all duration-200 hover:bg-[var(--color-surface-3)] hover:border-[var(--color-border-bright)] hover:scale-105 active:scale-95"
    style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary);"
    onclick={() => action('toggle_zen_mode')}
  >
    Exit Zen
  </button>
{/if}
