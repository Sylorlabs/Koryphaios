<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronLeft, ChevronRight, StickyNote } from 'lucide-svelte';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import NoGitWarning from '$lib/components/NoGitWarning.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';
  import NotesPanel from '$lib/components/NotesPanel.svelte';
  import SourceControlPanel from '$lib/components/SourceControlPanel.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';

  let {
    showSidebar = true,
    zenMode = false,
    showGit = false,
    showNotes = false,
    activeSessionId = null,
    connectionDot = 'bg-red-500',
    connectionStatusLabel = 'Realtime offline',
    connectedProviders = 0,
    onHideSidebar,
    onShowSidebar,
    onCloseNotes,
    startDragging,
    menubar,
    fileInputs,
    agentRailSlot,
    feed,
    contextBar,
    backgroundShells,
    composer,
  }: {
    showSidebar?: boolean;
    zenMode?: boolean;
    showGit?: boolean;
    showNotes?: boolean;
    activeSessionId?: string | null | undefined;
    connectionDot?: string;
    connectionStatusLabel?: string;
    connectedProviders?: number;
    onHideSidebar?: () => void;
    onShowSidebar?: () => void;
    onCloseNotes?: () => void;
    startDragging?: (e: MouseEvent) => void;
    menubar?: Snippet;
    fileInputs?: Snippet;
    agentRailSlot?: Snippet;
    feed?: Snippet;
    contextBar?: Snippet;
    backgroundShells?: Snippet;
    composer?: Snippet;
  } = $props();
</script>

<div class="flex h-screen min-h-0 min-w-0 overflow-hidden" style="background: var(--color-surface-0);">
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
      <div
        class="sidebar-header flex items-center justify-between px-4 border-b shrink-0"
        style="height: var(--header-height); border-color: var(--color-border);"
        data-tauri-drag-region
        onmousedown={startDragging}
        role="presentation"
      >
        <div class="flex items-center gap-3 min-w-0 pointer-events-none">
          <img
            src="/logo-64.png"
            alt="Koryphaios"
            class="rounded-lg shrink-0"
            style="width: var(--size-8); height: var(--size-8);"
          />
          <div class="flex flex-col justify-center min-w-0">
            <h1 class="text-sm font-semibold leading-tight" style="color: var(--color-text-primary);">
              Koryphaios
            </h1>
            <p class="leading-tight" style="font-size: var(--text-xs); color: var(--color-text-muted);">
              Agent workspace
            </p>
          </div>
        </div>
        <button
          type="button"
          class="sidebar-header-button rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="padding: var(--space-2); color: var(--color-text-muted);"
          onclick={onHideSidebar}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      <NoGitWarning />

      <div class="flex-1 min-h-0 overflow-hidden">
        <SessionSidebar currentSessionId={activeSessionId ?? undefined} />
      </div>

      <div
        class="px-4 py-3 border-t flex items-center justify-between shrink-0"
        style="border-color: var(--color-border); background: var(--color-surface-2);"
      >
        <div class="flex items-center gap-2">
          <div class="rounded-full {connectionDot}" style="width: var(--size-2); height: var(--size-2);"></div>
          <span
            class="leading-none"
            style="font-size: var(--text-xs); color: var(--color-text-muted);"
            title={connectionStatusLabel}
          >
            {connectionStatusLabel}
          </span>
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
          onclick={onShowSidebar}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  {/if}

  <div class="flex-1 flex min-h-0 min-w-0">
    <div class="relative flex flex-1 min-h-0 min-w-0 flex-col">
      {@render menubar?.()}

      {@render fileInputs?.()}

      {#if !zenMode}
        {@render agentRailSlot?.()}
      {/if}

      <FileEditPreview />

      {#if showNotes}
        <div
          class="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col"
          style="top: var(--header-height, 40px); background: var(--color-surface-1);"
        >
          <div
            class="flex items-center justify-between px-4 py-2 border-b shrink-0"
            style="border-color: var(--color-border); background: var(--color-surface-0);"
          >
            <div class="flex items-center gap-2">
              <StickyNote size={14} style="color: var(--color-accent);" />
              <span class="text-sm font-semibold" style="color: var(--color-text-primary);">Note Network</span>
            </div>
            <button
              type="button"
              class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)] text-xs"
              style="color: var(--color-text-muted);"
              onclick={onCloseNotes}
              aria-label="Close notes"
            >
              Back to chat
            </button>
          </div>
          <div class="flex-1 min-h-0">
            <NotesPanel />
          </div>
        </div>
      {/if}

      <section class="flex flex-1 min-h-0 flex-col overflow-hidden" role="main" aria-label="Chat feed">
        {@render feed?.()}
      </section>

      {@render contextBar?.()}

      {@render backgroundShells?.()}

      <div class="shrink-0" style="background: var(--color-surface-1);">
        {@render composer?.()}
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
