<script lang="ts">
  import {
    Settings,
    Activity,
    ChevronDown,
    GitBranch,
    Zap,
    Search,
  } from 'lucide-svelte';
  import { getModKeyName } from '$lib/utils/platform';
  import { formatRecentDate, promptTemplates } from '$lib/utils/projectManager';
  import type { RecentProject } from '$lib/utils/projectManager';
  import { onMount } from 'svelte';

  interface Props {
    showSidebar: boolean;
    showGit: boolean;
    showAgents: boolean;
    zenMode: boolean;
    projectName: string | null | undefined;
    koryPhase: string | null;
    isYoloMode: boolean;
    activeAgents: Array<{ identity: { id: string }; [key: string]: unknown }>;
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

  onMount(() => {
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

      {#if projectName}
        <span class="flex items-center gap-2 min-w-0 max-w-[240px]">
          <span class="shrink-0 text-[11px]" style="color: var(--color-text-muted);" aria-hidden="true">|</span>
          <span
            class="truncate text-xs font-medium"
            style="color: var(--color-text-secondary);"
            title={projectName}
          >
            {projectName}
          </span>
        </span>
      {/if}

      {#if koryPhase}
        <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style="background: var(--color-surface-2);">
          <div class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></div>
          <span class="text-xs leading-none" style="color: var(--color-text-secondary);">
            Kory: {koryPhase}
          </span>
        </div>
      {/if}

      {#if isYoloMode}
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
        onclick={() => action('toggle_sidebar')}
        title={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
      >
        {showSidebar ? 'Hide Sidebar' : 'Show Sidebar'}
      </button>
      <button
        class="flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
        style="color: {showGit ? 'var(--color-accent)' : 'var(--color-text-muted)'};"
        onclick={() => action('toggle_git')}
        title={showGit ? 'Hide Source Control' : 'Show Source Control'}
      >
        <GitBranch size={14} />
        <span class="text-[10px] font-medium uppercase tracking-wider">{showGit ? 'Hide Git' : 'Show Git'}</span>
      </button>
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
