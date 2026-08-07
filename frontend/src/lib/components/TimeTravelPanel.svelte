<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ArrowRight,
    Bot,
    Check,
    Clock3,
    GitCompareArrows,
    LoaderCircle,
    RotateCcw,
    ShieldCheck,
    X,
  } from 'lucide-svelte';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { runStateStore } from '$lib/stores/run-state.svelte';

  type TimelineEntry = {
    hash: string;
    description: string;
    timestamp: number;
    model?: string;
    cost?: number;
    recoverable: boolean;
    messageId?: string;
    checkpointType?: string;
  };

  type TimeTravelState = {
    currentHash: string;
    timeline: TimelineEntry[];
    canUndo: boolean;
    canRedo: boolean;
    stats: { totalStates: number; totalCost: number; modelsUsed: string[] };
  };

  let { open = $bindable(false) }: { open: boolean } = $props();

  let timelineState = $state<TimeTravelState | null>(null);
  let loading = $state(false);
  let loadedSessionId = $state('');
  let panelEl = $state<HTMLElement | null>(null);
  const activeSessionId = $derived(sessionStore.activeSessionId);
  const sessionBusy = $derived(
    activeSessionId ? runStateStore.isBusy(activeSessionId) : false,
  );

  $effect(() => {
    if (!open) return;
    if (!activeSessionId) {
      timelineState = null;
      loadedSessionId = '';
      return;
    }
    if (loadedSessionId !== activeSessionId) void loadTimeline(activeSessionId);
  });

  $effect(() => {
    if (!open || !panelEl) return;
    panelEl.querySelector<HTMLElement>('button')?.focus();
  });

  onMount(() => {
    const handleApplied = () => {
      if (open && activeSessionId) void loadTimeline(activeSessionId);
    };
    window.addEventListener('kory:rewind-applied', handleApplied);
    return () => window.removeEventListener('kory:rewind-applied', handleApplied);
  });

  async function loadTimeline(sessionId: string) {
    loading = true;
    try {
      const response = await apiFetch(apiUrl(`/api/sessions/${sessionId}/timetravel`));
      const body = await parseJsonResponse<{ ok?: boolean; data?: TimeTravelState; error?: string }>(response);
      if (!body.ok || !body.data) throw new Error(body.error ?? 'Time Travel is unavailable');
      if (sessionStore.activeSessionId !== sessionId) return;
      timelineState = body.data;
      loadedSessionId = sessionId;
    } catch (error) {
      timelineState = null;
      loadedSessionId = sessionId;
      toastStore.error(error instanceof Error ? error.message : 'Could not load Time Travel');
    } finally {
      if (sessionStore.activeSessionId === sessionId) loading = false;
    }
  }

  function checkpointSource(type?: string) {
    if (type === 'auto_save') return { label: 'Worker', icon: Bot };
    if (type === 'recovery_backup') return { label: 'Safety backup', icon: ShieldCheck };
    return { label: 'Manager', icon: GitCompareArrows };
  }

  function checkpointLabel(type?: string) {
    if (type === 'auto_save') return 'Worker autosave';
    if (type === 'recovery_backup') return 'Recovery backup';
    if (type === 'user_manual') return 'Manual checkpoint';
    return 'Completed turn';
  }

  function formatTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(timestamp);
  }

  function close() {
    if (!wsStore.rewindPreviewLoadingHash) {
      open = false;
      loadedSessionId = '';
    }
  }

  async function preview(entry: TimelineEntry) {
    if (!entry.recoverable || entry.hash === timelineState?.currentHash) return;
    await wsStore.rewind(entry.hash);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !panelEl) return;
    const focusable = Array.from(
      panelEl.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    role="presentation"
    onmousedown={(event) => { if (event.target === event.currentTarget) close(); }}
  >
    <div
      bind:this={panelEl}
      class="flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="time-travel-title"
      onkeydown={handleKeydown}
    >
      <header class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4">
        <div class="mt-0.5 rounded-lg bg-amber-500/15 p-2 text-amber-400"><RotateCcw size={17} /></div>
        <div class="min-w-0 flex-1">
          <h2 id="time-travel-title" class="text-sm font-semibold text-[var(--color-text-primary)]">Time Travel</h2>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">Inspect this session's recorded states. Nothing changes until you review and confirm a rewind.</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1 font-mono text-[9px] text-[var(--color-text-muted)] sm:block">ESC ESC</span>
          <button type="button" class="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]" aria-label="Close Time Travel" onclick={close}><X size={15} /></button>
        </div>
      </header>

      {#if timelineState}
        <div class="grid grid-cols-3 gap-px border-b border-[var(--color-border)] bg-[var(--color-border)]">
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Recorded states</p>
            <p class="mt-1 font-mono text-sm text-[var(--color-text-primary)]">{timelineState.stats.totalStates}</p>
          </div>
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Recorded cost</p>
            <p class="mt-1 font-mono text-sm text-[var(--color-text-primary)]">${timelineState.stats.totalCost.toFixed(4)}</p>
          </div>
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Navigation</p>
            <p class="mt-1 text-xs text-[var(--color-text-primary)]">{timelineState.canUndo ? 'Earlier states ready' : timelineState.canRedo ? 'Newer states ready' : 'At recorded edge'}</p>
          </div>
        </div>
      {/if}

      <div class="min-h-52 flex-1 overflow-y-auto p-3">
        {#if loading}
          <div class="flex min-h-52 items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]"><LoaderCircle size={16} class="animate-spin" /> Loading recorded states…</div>
        {:else if !activeSessionId}
          <div class="flex min-h-52 flex-col items-center justify-center text-center">
            <Clock3 size={24} class="text-[var(--color-text-muted)]" />
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">No active session</p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">Open a session before using Time Travel.</p>
          </div>
        {:else if !timelineState || timelineState.timeline.length === 0}
          <div class="flex min-h-52 flex-col items-center justify-center text-center">
            <Clock3 size={24} class="text-[var(--color-text-muted)]" />
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">No recorded states yet</p>
            <p class="mt-1 max-w-sm text-xs leading-relaxed text-[var(--color-text-muted)]">Koryphaios records eligible completed turns and worker changes here as this session progresses.</p>
          </div>
        {:else}
          <ol class="space-y-2" aria-label="Session checkpoints">
            {#each timelineState.timeline as entry (entry.hash)}
              {@const isCurrent = entry.hash === timelineState.currentHash}
              {@const source = checkpointSource(entry.checkpointType)}
              {@const SourceIcon = source.icon}
              <li>
                <button
                  type="button"
                  class="group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors {isCurrent ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-amber-400/40 hover:bg-[var(--color-surface-3)]'}"
                  disabled={!entry.recoverable || isCurrent || sessionBusy || !!wsStore.rewindPreviewLoadingHash}
                  onclick={() => void preview(entry)}
                  aria-label={isCurrent ? `${entry.description}, current state` : `Preview rewind to ${entry.description}`}
                >
                  <span class="mt-0.5 rounded-lg bg-[var(--color-surface-3)] p-2 text-[var(--color-text-muted)] group-hover:text-amber-400">
                    {#if isCurrent}<Check size={14} class="text-emerald-400" />{:else}<SourceIcon size={14} />{/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="truncate text-xs font-medium text-[var(--color-text-primary)]">{entry.description}</span>
                      {#if isCurrent}<span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-400">Current</span>{/if}
                    </span>
                    <span class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                      <span>{formatTimestamp(entry.timestamp)}</span><span>{source.label}</span><span>{checkpointLabel(entry.checkpointType)}</span>
                      {#if entry.model}<span class="font-mono">{entry.model}</span>{/if}
                      {#if entry.cost !== undefined}<span class="font-mono">${entry.cost.toFixed(4)}</span>{/if}
                    </span>
                  </span>
                  {#if wsStore.rewindPreviewLoadingHash === entry.hash}
                    <LoaderCircle size={15} class="mt-2 animate-spin text-amber-400" />
                  {:else if !isCurrent}
                    <ArrowRight size={15} class="mt-2 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-amber-400" />
                  {/if}
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <footer class="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-3">
        <p class="text-[10px] text-[var(--color-text-muted)]">{sessionBusy ? 'Stop the active run before selecting a state.' : 'Select a state to inspect its files and evidence before rewinding.'}</p>
        <button type="button" class="btn btn-secondary shrink-0" onclick={close}>Keep current state</button>
      </footer>
    </div>
  </div>
{/if}
