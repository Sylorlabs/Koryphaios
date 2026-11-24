<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import ChevronLeft from 'lucide-svelte/icons/chevron-left';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import Plus from 'lucide-svelte/icons/plus';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';
  import VoiceWaveform from '$lib/components/VoiceWaveform.svelte';
  import VoiceConductorHud from '$lib/components/VoiceConductorHud.svelte';
  import AudioLines from 'lucide-svelte/icons/audio-lines';
  import { voiceRecorder } from '$lib/stores/voice-recorder.svelte';
  import type { RecentProject } from '$lib/utils/projectManager';
  import { hydrateDesktopUiSettings } from '$lib/stores/desktop-ui-settings-sync';

  let {
    showSidebar = true,
    zenMode = false,
    modalOpen = false,
    showNotes = false,
    activeSessionId = null,
    connectionDot = 'bg-[var(--color-error)]',
    connectionStatusLabel = 'Realtime offline',
    connectedProviders = 0,
    recentProjects = [],
    onSidebarAction,
    onHideSidebar,
    onShowSidebar,
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
    /** Hide and inert the workbench while a viewport-level modal owns the UI. */
    modalOpen?: boolean;
    showNotes?: boolean;
    activeSessionId?: string | null | undefined;
    connectionDot?: string;
    connectionStatusLabel?: string;
    connectedProviders?: number;
    recentProjects?: RecentProject[];
    onSidebarAction?: (action: string) => void | Promise<void>;
    onHideSidebar?: () => void;
    onShowSidebar?: () => void;
    startDragging?: (e: MouseEvent) => void;
    menubar?: Snippet;
    fileInputs?: Snippet;
    agentRailSlot?: Snippet;
    feed?: Snippet;
    contextBar?: Snippet;
    backgroundShells?: Snippet;
    composer?: Snippet;
  } = $props();

  // Let the shell respond to the space it actually receives. A parent pane,
  // split view, or resized native window can be narrower than window.innerWidth.
  let shellElement: HTMLDivElement | undefined = $state();
  let shellWidth = $state(1280);
  let isNarrow = $derived(shellWidth < 700);
  let isCompact = $derived(shellWidth >= 700 && shellWidth < 1080);
  let compactSidebarExpanded = $state(false);
  let NotesPanelComponent = $state<Component | null>(null);
  let notesPanelLoading = $state(false);
  let notesPanelLoadError = $state<string | null>(null);
  let mobileClosed = $state(true); // on phones the sidebar starts closed (as an overlay)
  onMount(() => {
    void hydrateDesktopUiSettings();
    const measureShell = () => {
      const width = shellElement?.getBoundingClientRect().width ?? window.innerWidth;
      const narrow = width < 700;
      const compact = width >= 700 && width < 1080;
      if (narrow && !isNarrow) mobileClosed = true; // collapse when entering narrow
      if (!compact || !isCompact) compactSidebarExpanded = false;
      shellWidth = width;
    };
    measureShell();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureShell);
    if (shellElement) observer?.observe(shellElement);
    window.addEventListener('resize', measureShell);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureShell);
    };
  });
  let desktopSidebar = $derived(
    showSidebar && !isNarrow && (!isCompact || compactSidebarExpanded),
  );
  let mobileSidebar = $derived(isNarrow && !mobileClosed);
  function hideSidebar() {
    if (isNarrow) mobileClosed = true;
    else if (isCompact) compactSidebarExpanded = false;
    else onHideSidebar?.();
  }
  function revealSidebar() {
    if (isNarrow) mobileClosed = false;
    else if (isCompact) {
      compactSidebarExpanded = true;
      onShowSidebar?.();
    } else onShowSidebar?.();
  }

  /** Elapsed recording time as m:ss, matching the composer's own readout. */
  function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
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
  bind:this={shellElement}
  class="app-shell flex h-screen min-h-0 min-w-0 overflow-hidden"
  style="background: var(--color-surface-0); visibility: {modalOpen ? 'hidden' : 'visible'};"
  aria-hidden={modalOpen}
  inert={modalOpen}
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
                class="rounded px-1 py-px text-[10px] font-bold uppercase tracking-wider"
                style="background: color-mix(in srgb, var(--color-accent) 18%, transparent); color: var(--color-accent);"
                title="Koryphaios is in beta. Expect rapid changes">Beta</span
              >
            </h1>
            <p
              class="leading-tight"
              style="font-size: var(--text-xs); color: var(--color-text-muted);"
            >
              Workspace
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
        <SessionSidebar
          currentSessionId={activeSessionId ?? undefined}
          {recentProjects}
          onAction={onSidebarAction}
        />
      </div>

      <div
        class="px-4 py-3 border-t flex items-center justify-between gap-2 shrink-0"
        style="border-color: var(--color-border); background: var(--color-surface-2);"
      >
        <div class="flex items-center gap-2 min-w-0">
          <div
            class="rounded-full {connectionDot} shrink-0"
            style="width: var(--size-2); height: var(--size-2);"
          ></div>
          <span
            class="truncate leading-none"
            style="font-size: var(--text-xs); color: var(--color-text-muted);"
            title={connectionStatusLabel}
          >
            {connectionStatusLabel}
          </span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          {#if connectedProviders > 0}
            <span
              class="px-1.5 py-0.5 rounded leading-none whitespace-nowrap"
              style="font-size: var(--text-xs); background: var(--color-surface-3); color: var(--color-text-muted);"
            >
              {connectedProviders} providers
            </span>
          {/if}
        </div>
      </div>
    </nav>
  {/if}
  <!-- Desktop sidebar: persistent mount, width transition avoids remount jank.
       min-h-0 lets the inner overflow-y-auto session tree actually shrink on
       short windows instead of inheriting the viewport height and pushing
       the status bar past the bottom edge. -->
  <nav
    class="desktop-sidebar shrink-0 border-r overflow-hidden min-h-0"
    data-testid="session-sidebar"
    style="
      display: {isNarrow ? 'none' : 'flex'};
      width: {isCompact && !compactSidebarExpanded
        ? 'var(--sidebar-width-collapsed)'
        : desktopSidebar
          ? 'var(--expanded-sidebar-width)'
          : zenMode
            ? '0px'
            : 'var(--sidebar-width-collapsed)'};
      border-color: var(--color-border);
      background: var(--color-surface-1);
    "
    aria-hidden={!desktopSidebar && zenMode}
    aria-label="Session navigation"
    inert={!desktopSidebar && zenMode}
  >
    <div
      class="desktop-sidebar-content flex flex-col min-h-0"
      style="opacity: {desktopSidebar ? 1 : 0}; pointer-events: {desktopSidebar ? 'auto' : 'none'};"
      aria-hidden={!desktopSidebar}
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
              class="rounded px-1 py-px text-[10px] font-bold uppercase tracking-wider"
              style="background: color-mix(in srgb, var(--color-accent) 18%, transparent); color: var(--color-accent);"
              title="Koryphaios is in beta. Expect rapid changes">Beta</span
            >
          </h1>
          <p
            class="leading-tight"
            style="font-size: var(--text-xs); color: var(--color-text-muted);"
          >
            Workspace
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
      <SessionSidebar
        currentSessionId={activeSessionId ?? undefined}
        {recentProjects}
        onAction={onSidebarAction}
      />
    </div>

    <div
      class="px-4 py-3 border-t flex items-center justify-between gap-2 shrink-0"
      style="border-color: var(--color-border); background: var(--color-surface-2);"
    >
      <div class="flex items-center gap-2 min-w-0">
        <div
          class="rounded-full {connectionDot} shrink-0"
          style="width: var(--size-2); height: var(--size-2);"
        ></div>
        <span
          class="truncate leading-none"
          style="font-size: var(--text-xs); color: var(--color-text-muted);"
          title={connectionStatusLabel}
        >
          {connectionStatusLabel}
        </span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        {#if connectedProviders > 0}
          <span
            class="px-1.5 py-0.5 rounded leading-none whitespace-nowrap"
            style="font-size: var(--text-xs); background: var(--color-surface-3); color: var(--color-text-muted);"
          >
            {connectedProviders} providers
          </span>
        {/if}
      </div>
    </div>
    </div>
    <div
      class="desktop-sidebar-rail flex min-h-0 flex-col items-center"
      style="opacity: {!desktopSidebar && !zenMode ? 1 : 0}; pointer-events: {!desktopSidebar && !zenMode ? 'auto' : 'none'};"
      aria-hidden={desktopSidebar || zenMode}
      inert={desktopSidebar || zenMode}
      data-testid="collapsed-sidebar-rail"
      data-compact={isCompact}
    >
      <div
        class="w-full border-b flex items-center justify-center"
        style="height: var(--header-height); border-color: var(--color-border);"
      >
        <button
          type="button"
          class="rail-button"
          onclick={revealSidebar}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <button
        type="button"
        class="rail-button mt-2.5"
        style="color: var(--color-accent);"
        onclick={() => onSidebarAction?.('new_session')}
        title="New chat"
        aria-label="New chat"
      >
        <Plus size={18} />
      </button>
      <div class="mt-auto flex w-full justify-center border-t py-3" style="border-color: var(--color-border);" title={connectionStatusLabel}>
        <span class="h-2 w-2 rounded-full {connectionDot}" role="img" aria-label={connectionStatusLabel}></span>
      </div>
    </div>
  </nav>

  <div class="flex-1 flex min-h-0 min-w-0">
    <div class="relative flex flex-1 min-h-0 min-w-0 flex-col">
      {@render menubar?.()}

      {@render fileInputs?.()}

      {#if !zenMode && !showNotes}
        {@render agentRailSlot?.()}
      {/if}

      {#if showNotes}
        <div
          class="flex flex-1 min-h-0 min-w-0 flex-col"
          style="background: var(--color-surface-1);"
        >
          <div class="flex-1 min-h-0">
            <!-- Contain a Notes Network failure to this region. An exception
                 thrown inside an `$effect` escapes Svelte's reactive flush
                 unless a boundary catches it, which would otherwise freeze the
                 entire window — including the titlebar Notes toggle. -->
            <svelte:boundary>
              {#if NotesPanelComponent}
                <NotesPanelComponent />
              {:else if notesPanelLoadError}
                <div
                  class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                >
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

              {#snippet failed(error, reset)}
                <div
                  class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
                  role="alert"
                >
                  <p class="text-sm" style="color: var(--color-text-primary);">
                    The Notes Network hit an unexpected error
                  </p>
                  <p
                    class="text-xs"
                    style="color: var(--color-text-muted); overflow-wrap: anywhere;"
                  >
                    {error instanceof Error ? error.message : String(error)}
                  </p>
                  <button
                    type="button"
                    class="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
                    style="border-color: var(--color-border); color: var(--color-text-primary);"
                    onclick={reset}>Try again</button
                  >
                </div>
              {/snippet}
            </svelte:boundary>
          </div>
        </div>
      {/if}

      {#if !showNotes}
        <section
          class="chat-feed flex flex-1 min-h-0 flex-col overflow-hidden"
          aria-label="Chat feed"
          data-testid="chat-feed"
        >
          {@render feed?.()}
        </section>

        <!-- Live agent file-edit preview. Anchored just above the context bar, next
           to the composer: edits belong with the turn that is producing them, and
           at the top it pushed the feed down and stole reading room. Height is
           capped and scrolls so a long edit list can never displace the composer. -->
        <div class="shrink-0 max-h-[38vh] overflow-y-auto">
          <FileEditPreview />
        </div>

        <!-- Live voice capture, in flow directly above the context bar. It takes
           real space instead of overlaying it: an absolutely positioned bubble
           covered the Context row and the capture was unreadable while it ran.
           Collapsed to zero height when idle so the composer does not move. -->
        <div
          class="shrink-0 overflow-hidden px-4"
          style="background: var(--color-surface-1); transition: padding var(--duration-normal); {voiceRecorder.active
            ? 'padding-top: var(--space-sm); padding-bottom: var(--space-sm); border-top: 1px solid var(--color-border);'
            : 'padding-top: 0; padding-bottom: 0;'}"
          data-testid="voice-waveform-strip"
          data-state={voiceRecorder.state.phase}
          data-mode={voiceRecorder.state.mode}
          aria-hidden={!voiceRecorder.active}
        >
          {#if voiceRecorder.active}
            <div class="flex items-center gap-3">
              {#if voiceRecorder.state.mode === 'conductor'}
                <!-- A conductor capture is a command, not dictation: its own
                     icon, colour and label so the two cannot be confused. -->
                <AudioLines
                  size={14}
                  class="shrink-0"
                  style="color: var(--color-info);"
                  aria-hidden="true"
                />
              {/if}
              <span
                class="shrink-0 font-mono text-[11px] tabular-nums"
                style="color: var(--color-text-muted);"
                >{formatElapsed(voiceRecorder.state.elapsedMs)}</span
              >
              <VoiceWaveform
                analyser={voiceRecorder.state.analyser}
                active={voiceRecorder.state.phase === 'recording'}
                class="min-w-0 flex-1"
              />
              <span
                class="shrink-0 text-[11px]"
                data-testid="voice-capture-label"
                style="color: {voiceRecorder.state.phase !== 'recording'
                  ? 'var(--color-text-muted)'
                  : voiceRecorder.state.mode === 'conductor'
                    ? 'var(--color-info)'
                    : 'var(--color-error)'};"
                >{voiceRecorder.state.mode === 'conductor'
                  ? voiceRecorder.state.phase === 'recording'
                    ? 'Listening for a command'
                    : 'Understanding command'
                  : voiceRecorder.state.phase === 'recording'
                    ? 'Recording'
                    : 'Transcribing'}</span
              >
            </div>
            {#if voiceRecorder.state.partialText}
              <!-- What the transcriber has heard so far, so dictation is visible
                   while it is still being spoken. -->
              <p
                class="mt-1 line-clamp-2 text-[11px]"
                style="color: var(--color-text-secondary);"
                data-testid="voice-live-transcript"
              >
                {voiceRecorder.state.partialText}
              </p>
            {/if}
            <span class="sr-only" aria-live="polite">
              {voiceRecorder.state.partialText ||
                (voiceRecorder.state.mode === 'conductor'
                  ? voiceRecorder.state.phase === 'recording'
                    ? 'Listening for a voice command'
                    : 'Understanding the voice command'
                  : voiceRecorder.state.phase === 'recording'
                    ? 'Recording a voice prompt'
                    : 'Transcribing the recording')}
            </span>
          {/if}
        </div>

        <VoiceConductorHud />

        {@render contextBar?.()}

        {@render backgroundShells?.()}

        <div class="shrink-0" style="background: var(--color-surface-1);">
          {@render composer?.()}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .app-shell {
    container: app-shell / inline-size;
  }

  .desktop-sidebar {
    --expanded-sidebar-width: max(var(--sidebar-min-width), min(var(--sidebar-width), var(--sidebar-max-width)));
    position: relative;
    transition: width 320ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .desktop-sidebar-content {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--expanded-sidebar-width);
    transition: opacity 160ms ease;
  }

  .desktop-sidebar-rail {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--sidebar-width-collapsed);
    transition: opacity 200ms ease;
  }

  .rail-button {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--size-8);
    height: var(--size-8);
    border-radius: var(--radius-lg);
    color: var(--color-text-secondary);
    transition: background 160ms ease;
  }

  .rail-button:hover {
    background: var(--color-surface-3);
  }

  @container app-shell (max-width: 1079px) {
    .desktop-sidebar {
      --expanded-sidebar-width: min(260px, max(var(--sidebar-min-width), calc(100cqi - var(--sidebar-width-collapsed) - 32px)));
    }
  }

  @container app-shell (max-width: 699px) {
    .desktop-sidebar {
      display: none !important;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .desktop-sidebar,
    .desktop-sidebar-content,
    .desktop-sidebar-rail {
      transition: none;
    }
  }

  /* Bound every transcript scroller (including the welcome view) below menus.
     Viewport message overlays portal to body rather than escaping this layer. */
  .chat-feed {
    position: relative;
    z-index: 0;
    isolation: isolate;
    contain: paint;
  }
</style>
