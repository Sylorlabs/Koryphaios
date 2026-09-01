<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import ChevronLeft from 'lucide-svelte/icons/chevron-left';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';

  let {
    showSidebar = true,
    zenMode = false,
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

  // On phone-width screens the fixed session sidebar leaves no room for the main
  // content, so collapse it to the thin rail automatically (users still reach it
  // via the rail's "show" button). Desktop behaviour is unchanged.
  let isNarrow = $state(false);
  let NotesPanelComponent = $state<Component | null>(null);
  let notesPanelLoading = $state(false);
  let notesPanelLoadError = $state<string | null>(null);
  let mobileClosed = $state(true); // on phones the sidebar starts closed (as an overlay)
  function updateNarrow() {
    const narrow = typeof window !== 'undefined' && window.innerWidth < 700;
    if (narrow && !isNarrow) mobileClosed = true; // collapse when entering narrow
    isNarrow = narrow;
  }
  onMount(() => {
    updateNarrow();
    window.addEventListener('resize', updateNarrow);
    return () => window.removeEventListener('resize', updateNarrow);
  });
  let desktopSidebar = $derived(showSidebar && !isNarrow);
  let mobileSidebar = $derived(isNarrow && !mobileClosed);
  function hideSidebar() {
    if (isNarrow) mobileClosed = true;
    else onHideSidebar?.();
  }
  function revealSidebar() {
    if (isNarrow) mobileClosed = false;
    else onShowSidebar?.();
  }

  async function loadNotesPanel(): Promise<void> {
    if (NotesPanelComponent || notesPanelLoading) return;
    notesPanelLoading = true;
    notesPanelLoadError = null;
    try {
      NotesPanelComponent = (await import('$lib/components/NotesPanel.svelte')).default;
    } catch (error) {
      notesPanelLoadError = error instanceof Error ? error.message : 'Notes failed to load';
    } finally {
      notesPanelLoading = false;
    }
  }

  $effect(() => {
    if (showNotes) void loadNotesPanel();
  });
</script>

<div
  class="flex h-screen min-h-0 min-w-0 overflow-hidden"
  style="background: var(--color-surface-0);"
>
  {#if mobileSidebar}
    <button
      type="button"
      class="fixed inset-0 z-40 bg-black/50"
      aria-label="Close sidebar"
      onclick={() => (mobileClosed = true)}
    ></button>
    <nav
      class="fixed inset-y-0 left-0 z-50 shadow-2xl border-r flex min-h-0 flex-col"
      data-testid="session-sidebar"
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
            <h1
              class="flex items-center gap-1.5 text-sm font-semibold leading-tight"
              style="color: var(--color-text-primary);"
            >
              Koryphaios
              <span
                class="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wider"
                style="background: color-mix(in srgb, var(--color-accent) 18%, transparent); color: var(--color-accent);"
                title="Koryphaios is in beta — expect rapid changes">Beta</span
              >
            </h1>
            <p
              class="leading-tight"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
            >
              Agent workspace
            </p>
          </div>
        </div>
        <button
          type="button"
          class="sidebar-header-button rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="padding: var(--space-2); color: var(--color-text-muted);"
          onclick={hideSidebar}
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-hidden">
        <SessionSidebar currentSessionId={activeSessionId ?? undefined} />
      </div>

      <div
        class="px-4 py-3 border-t flex items-center justify-between shrink-0"
        style="border-color: var(--color-border); background: var(--color-surface-2);"
      >
        <div class="flex items-center gap-2">
          <div
            class="rounded-full {connectionDot}"
            style="width: var(--size-2); height: var(--size-2);"
          ></div>
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
  {/if}
  <!-- Desktop sidebar: persistent mount, width transition avoids remount jank -->
  <nav
    class="hidden md:flex shrink-0 border-r flex-col overflow-hidden transition-[width,opacity] duration-150 ease-out will-change-[width]"
    data-testid="session-sidebar"
    style="
      width: {desktopSidebar ? 'var(--sidebar-width)' : '0px'};
      min-width: {desktopSidebar ? 'var(--sidebar-min-width)' : '0px'};
      max-width: {desktopSidebar ? 'var(--sidebar-max-width)' : '0px'};
      opacity: {desktopSidebar ? '1' : '0'};
      border-color: var(--color-border);
      background: var(--color-surface-1);
      pointer-events: {desktopSidebar ? 'auto' : 'none'};
    "
    aria-hidden={!desktopSidebar}
    aria-label="Session navigation"
    inert={!desktopSidebar}
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
          <h1
            class="flex items-center gap-1.5 text-sm font-semibold leading-tight"
            style="color: var(--color-text-primary);"
          >
            Koryphaios
            <span
              class="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wider"
              style="background: color-mix(in srgb, var(--color-accent) 18%, transparent); color: var(--color-accent);"
              title="Koryphaios is in beta — expect rapid changes">Beta</span
            >
          </h1>
          <p
            class="leading-tight"
            style="font-size: var(--text-xs); color: var(--color-text-muted);"
          >
            Agent workspace
          </p>
        </div>
      </div>
      <button
        type="button"
        class="sidebar-header-button rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
        style="padding: var(--space-2); color: var(--color-text-muted);"
        onclick={hideSidebar}
        title="Hide sidebar"
        aria-label="Hide sidebar"
      >
        <ChevronLeft size={14} />
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-hidden">
      <SessionSidebar currentSessionId={activeSessionId ?? undefined} />
    </div>

    <div
      class="px-4 py-3 border-t flex items-center justify-between shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-2);"
    >
      <div class="flex items-center gap-2">
        <div
          class="rounded-full {connectionDot}"
          style="width: var(--size-2); height: var(--size-2);"
        ></div>
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
  {#if !desktopSidebar && !isNarrow && !zenMode}
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
          onclick={revealSidebar}
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
              <span class="text-sm font-semibold" style="color: var(--color-text-primary);"
                >Note Network</span
              >
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
            {#if NotesPanelComponent}
              <NotesPanelComponent />
            {:else if notesPanelLoadError}
              <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p class="text-sm" style="color: var(--color-error);">{notesPanelLoadError}</p>
                <button
                  type="button"
                  class="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                  style="border-color: var(--color-border); color: var(--color-text-primary);"
                  onclick={() => void loadNotesPanel()}>Retry loading Notes</button
                >
              </div>
            {:else}
              <div
                class="flex h-full items-center justify-center gap-2 text-xs"
                style="color: var(--color-text-muted);"
                role="status"
              >
                <StickyNote size={14} /> Loading Notes…
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <section
        class="flex flex-1 min-h-0 flex-col overflow-hidden"
        aria-label="Chat feed"
        data-testid="chat-feed"
      >
        {@render feed?.()}
      </section>

      {@render contextBar?.()}

      {@render backgroundShells?.()}

      <div class="shrink-0" style="background: var(--color-surface-1);">
        {@render composer?.()}
      </div>
    </div>
  </div>
</div>
