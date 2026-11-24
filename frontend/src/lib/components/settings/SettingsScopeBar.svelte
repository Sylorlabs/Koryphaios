<script lang="ts">
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Check from 'lucide-svelte/icons/check';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Layers from 'lucide-svelte/icons/layers';
  import MonitorSmartphone from 'lucide-svelte/icons/monitor-smartphone';
  import {
    currentProjectIdentity,
    projectDisplayName,
    projectIdentityFor,
    projectStore,
  } from '$lib/stores/project.svelte';
  import { deviceStore } from '$lib/stores/devices.svelte';
  import { selectProjectNavigation } from '$lib/utils/project-navigation';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    selectedEnvironment?: string;
    onEnvironmentChange?: (env: string) => void;
    /** Optional page-specific copy before the project context. */
    contextLabel?: string;
    compact?: boolean;
    /** Short scope type shown in the row; concrete names stay in the menu. */
    projectLabel?: 'Project' | 'Workspace';
    /** Label the selector with the concrete project folder instead of the scope. */
    showProjectName?: boolean;
    /**
     * `select` is for workspaces whose data can actually move between
     * projects. `current` is a non-interactive context marker for a page that
     * is already bound to the selected project, such as Agent behavior.
     */
    projectSelector?: 'select' | 'current';
  }

  let {
    selectedEnvironment = $bindable('all'),
    onEnvironmentChange,
    contextLabel,
    compact = false,
    projectLabel = 'Project',
    showProjectName = false,
    projectSelector = 'select',
  }: Props = $props();

  let openMenu = $state<'project' | 'environment' | null>(null);
  // Scope comes straight from the store so a snapshot or a selection made in
  // another view cannot leave this menu reporting a stale mode.
  const projectScopeMode = $derived(
    projectStore.currentPath && projectStore.scope === 'project' ? 'project' : 'all',
  );

  const availableProjects = $derived.by(() => {
    const map = new Map<string, { path: string; name: string }>();
    for (const p of projectStore.workspaceProjects) {
      map.set(p.path, { path: p.path, name: projectIdentityFor(p).name });
    }
    for (const path of projectStore.openProjects) {
      if (!map.has(path)) {
        map.set(path, {
          path,
          name:
            path === projectStore.currentPath
              ? (currentProjectIdentity()?.name ?? projectDisplayName(path))
              : projectDisplayName(path),
        });
      }
    }
    if (projectStore.currentPath && !map.has(projectStore.currentPath)) {
      map.set(projectStore.currentPath, {
        path: projectStore.currentPath,
        name: currentProjectIdentity()?.name ?? projectDisplayName(projectStore.currentPath),
      });
    }
    return [...map.values()];
  });

  const activeProjectLabel = $derived.by(() => {
    if (projectSelector === 'current') {
      return projectLabel;
    }
    // Notes always reads the current project's collection, so a concrete name
    // is the honest label even when the workspace scope is "all".
    if (showProjectName && projectStore.currentPath) {
      return currentProjectIdentity()?.name || projectLabel;
    }
    if (projectScopeMode === 'all' || !projectStore.currentPath) {
      return `All ${projectLabel.toLowerCase()}s`;
    }
    return projectLabel;
  });

  const environmentOptions = $derived.by(() => {
    const localName =
      deviceStore.status?.local?.name ||
      deviceStore.status?.osName ||
      'This computer';
    const peers = (deviceStore.status?.peers ?? []).map((peer) => ({
      id: peer.id,
      label: peer.name || peer.id,
      subtitle: peer.online ? 'Connected peer' : 'Linked device',
    }));
    return [
      { id: 'all', label: 'All environments', subtitle: 'Local workstation & linked devices' },
      { id: 'local', label: localName, subtitle: 'Local environment' },
      ...peers,
    ];
  });

  const activeEnvironmentLabel = $derived(
    environmentOptions.find((opt) => opt.id === selectedEnvironment)?.label ?? 'All environments',
  );

  async function selectProjectOption(path: string | null) {
    openMenu = null;
    if (path === null) {
      projectStore.setScope('all');
      return;
    }
    projectStore.setScope('project');
    if (path !== projectStore.currentPath) {
      try {
        const res = await selectProjectNavigation(path);
        if (!res.ok) {
          toastStore.error(res.error);
        }
      } catch (error) {
        toastStore.error(error instanceof Error ? error.message : 'Could not switch project');
      }
    }
  }

  function selectEnvironmentOption(id: string) {
    selectedEnvironment = id;
    openMenu = null;
    onEnvironmentChange?.(id);
  }

  function handleWindowClick(e: MouseEvent) {
    if (!openMenu) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest('[data-settings-scope-bar]')) {
      openMenu = null;
    }
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div
  data-settings-scope-bar
  class="relative flex flex-wrap items-center gap-x-1.5 gap-y-1 {compact
    ? 'text-xs'
    : 'text-[13px]'} text-[var(--color-text-muted)]"
>
  {#if contextLabel}<span>{contextLabel}</span>{/if}

  <!-- Project selector (only interactive when this page supports changing it). -->
  <div class="relative inline-flex">
    {#if projectSelector === 'current'}
      <span class="font-medium text-[var(--color-text-primary)]">{activeProjectLabel}</span>
    {:else}
      <button
        type="button"
        class="inline-flex min-w-0 max-w-[min(32ch,50vw)] items-center gap-1 border-b-2 border-dotted border-[var(--color-text-secondary)]/60 pb-0.5 font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 rounded-xs"
        aria-haspopup="listbox"
        aria-expanded={openMenu === 'project'}
        title={activeProjectLabel}
        onclick={(e) => {
          e.stopPropagation();
          openMenu = openMenu === 'project' ? null : 'project';
        }}
      >
        <span class="truncate">{activeProjectLabel}</span>
        <ChevronDown size={13} class="shrink-0 text-[var(--color-text-muted)]" />
      </button>
    {/if}

    {#if projectSelector === 'select' && openMenu === 'project'}
      <div
        role="listbox"
        aria-label="Settings project scope"
        class="absolute left-0 top-full z-50 mt-1.5 min-w-[220px] max-w-[300px] max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1 shadow-xl"
      >
        <button
          type="button"
          role="option"
          aria-selected={projectScopeMode === 'all' || !projectStore.currentPath}
          class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
          onclick={() => void selectProjectOption(null)}
        >
          <span class="flex items-center gap-2 min-w-0">
            <Layers size={13} class="shrink-0 text-[var(--color-text-muted)]" />
            <span class="truncate font-medium text-[var(--color-text-primary)]">All projects</span>
          </span>
          {#if projectScopeMode === 'all' || !projectStore.currentPath}
            <Check size={13} class="shrink-0 text-[var(--color-accent)]" />
          {/if}
        </button>

        {#if availableProjects.length > 0}
          <div class="my-1 border-t border-[var(--color-border)]/60"></div>
          <div class="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Workspace projects
          </div>
          {#each availableProjects as proj (proj.path)}
            {@const isSelected =
              projectScopeMode === 'project' && projectStore.currentPath === proj.path}
            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
              onclick={() => void selectProjectOption(proj.path)}
            >
              <span class="flex items-center gap-2 min-w-0">
                <FolderOpen size={13} class="shrink-0 text-[var(--color-text-muted)]" />
                <span class="truncate font-medium text-[var(--color-text-primary)]">{proj.name}</span>
              </span>
              {#if isSelected}
                <Check size={13} class="shrink-0 text-[var(--color-accent)]" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  {#if onEnvironmentChange}
    <span>across</span>

    <!-- Environment selector is opt-in because most settings are not
         environment-addressable. A bound value alone must not create a
         dead-looking control. -->
    <div class="relative inline-flex">
    <button
      type="button"
      class="inline-flex items-center gap-1 border-b-2 border-dotted border-[var(--color-text-secondary)]/60 pb-0.5 font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 rounded-xs"
      aria-haspopup="listbox"
      aria-expanded={openMenu === 'environment'}
      onclick={(e) => {
        e.stopPropagation();
        openMenu = openMenu === 'environment' ? null : 'environment';
      }}
    >
      <span>{activeEnvironmentLabel}</span>
      <ChevronDown size={13} class="text-[var(--color-text-muted)]" />
    </button>

    {#if openMenu === 'environment'}
      <div
        role="listbox"
        aria-label="Settings environment scope"
        class="absolute left-0 top-full z-50 mt-1.5 min-w-[230px] max-w-[300px] max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1 shadow-xl"
      >
        {#each environmentOptions as env (env.id)}
          {@const isSelected = selectedEnvironment === env.id}
          <button
            type="button"
            role="option"
            aria-selected={isSelected}
            class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
            onclick={() => selectEnvironmentOption(env.id)}
          >
            <span class="flex items-center gap-2 min-w-0">
              <MonitorSmartphone size={13} class="shrink-0 text-[var(--color-text-muted)]" />
              <span class="min-w-0">
                <span class="block truncate font-medium text-[var(--color-text-primary)]"
                  >{env.label}</span
                >
                <span class="block truncate text-[11px] text-[var(--color-text-muted)]"
                  >{env.subtitle}</span
                >
              </span>
            </span>
            {#if isSelected}
              <Check size={13} class="shrink-0 text-[var(--color-accent)]" />
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    </div>
  {/if}
</div>
