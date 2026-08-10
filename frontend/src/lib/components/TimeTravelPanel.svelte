<script lang="ts">
  import { onMount } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import Bot from 'lucide-svelte/icons/bot';
  import Check from 'lucide-svelte/icons/check';
  import Clock3 from 'lucide-svelte/icons/clock-3';
  import GitCompareArrows from 'lucide-svelte/icons/git-compare-arrows';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import X from 'lucide-svelte/icons/x';
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
    sequence?: number;
    summary?: string;
    toolCallCount?: number;
    commandCount?: number;
    fileEditCount?: number;
    hasRichMetadata?: boolean;
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
  let loadError = $state('');
  let loadedSessionId = $state('');
  let panelEl = $state<HTMLElement | null>(null);
  const activeSessionId = $derived(sessionStore.activeSessionId);
  const sessionBusy = $derived(activeSessionId ? runStateStore.isBusy(activeSessionId) : false);

  $effect(() => {
    if (!open) return;
    if (!activeSessionId) {
      timelineState = null;
      loadError = '';
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
    loadError = '';
    timelineState = null;
    try {
      const response = await apiFetch(apiUrl(`/api/sessions/${sessionId}/timetravel`));
      const body = await parseJsonResponse<{
        ok?: boolean;
        data?: TimeTravelState;
        error?: string;
      }>(response);
      if (!body.ok || !body.data) throw new Error(body.error ?? 'Time Travel is unavailable');
      if (sessionStore.activeSessionId !== sessionId) return;
      timelineState = body.data;
      loadError = '';
      loadedSessionId = sessionId;
    } catch (error) {
      if (sessionStore.activeSessionId !== sessionId) return;
      const message = error instanceof Error ? error.message : 'Could not load Time Travel';
      timelineState = null;
      loadError = message;
      loadedSessionId = sessionId;
      toastStore.error(message);
    } finally {
      if (sessionStore.activeSessionId === sessionId) loading = false;
    }
  }

  function checkpointSource(type?: string) {
    if (type === 'auto_save') return { label: 'Worker', icon: Bot };
    if (type === 'recovery_backup') return { label: 'Safety backup', icon: ShieldCheck };
    if (type === 'goal_checkpoint') return { label: 'Goal timer', icon: Clock3 };
    if (type === 'agent_manual') return { label: 'Agent', icon: Bot };
    return { label: 'Manager', icon: GitCompareArrows };
  }

  function checkpointLabel(type?: string) {
    if (type === 'auto_save') return 'Worker autosave';
    if (type === 'recovery_backup') return 'Recovery backup';
    if (type === 'user_manual') return 'Manual checkpoint';
    if (type === 'goal_checkpoint') return 'Periodic goal checkpoint';
    if (type === 'agent_manual') return 'Agent checkpoint';
    return 'Completed turn';
  }

  /** The "relevant name" — prefer summary, fall back to description. */
  function entryTitle(entry: TimelineEntry): string {
    return entry.summary || entry.description;
  }

  /** Lightweight instrumentation badges for the collapsed view. */
  function instrumentationBadges(entry: TimelineEntry): string[] {
    const badges: string[] = [];
    if (entry.toolCallCount)
      badges.push(`${entry.toolCallCount} tool${entry.toolCallCount > 1 ? 's' : ''}`);
    if (entry.commandCount)
      badges.push(`${entry.commandCount} cmd${entry.commandCount > 1 ? 's' : ''}`);
    if (entry.fileEditCount)
      badges.push(`${entry.fileEditCount} file${entry.fileEditCount > 1 ? 's' : ''}`);
    return badges;
  }

  function formatTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
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
      panelEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
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
    onmousedown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
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
      <header
        class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4"
      >
        <div class="mt-0.5 rounded-lg bg-[var(--color-warning-bg)] p-2 text-[var(--color-warning)]">
          <RotateCcw size={17} />
        </div>
        <div class="min-w-0 flex-1">
          <h2 id="time-travel-title" class="text-sm font-semibold text-[var(--color-text-primary)]">
            Time Travel
          </h2>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
            Inspect this session's recorded states. Nothing changes until you review and confirm a
            rewind.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span
            class="hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1 font-mono text-[9px] text-[var(--color-text-muted)] sm:block"
            >ESC</span
          >
          <button
            type="button"
            class="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
            aria-label="Close Time Travel"
            onclick={close}><X size={15} /></button
          >
        </div>
      </header>

      {#if timelineState}
        <div
          class="grid grid-cols-3 gap-px border-b border-[var(--color-border)] bg-[var(--color-border)]"
        >
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Recorded states
            </p>
            <p class="mt-1 font-mono text-sm text-[var(--color-text-primary)]">
              {timelineState.stats.totalStates}
            </p>
          </div>
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Recorded cost
            </p>
            <p class="mt-1 font-mono text-sm text-[var(--color-text-primary)]">
              ${timelineState.stats.totalCost.toFixed(4)}
            </p>
          </div>
          <div class="bg-[var(--color-surface-1)] px-4 py-3">
            <p class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
              Navigation
            </p>
            <p class="mt-1 text-xs text-[var(--color-text-primary)]">
              {timelineState.canUndo
                ? 'Earlier states ready'
                : timelineState.canRedo
                  ? 'Newer states ready'
                  : 'At recorded edge'}
            </p>
          </div>
        </div>
      {/if}

      <div class="min-h-52 flex-1 overflow-y-auto p-3">
        {#if loading}
          <div
            class="flex min-h-52 items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle size={16} class="animate-spin" /> Loading recorded states…
          </div>
        {:else if !activeSessionId}
          <div class="flex min-h-52 flex-col items-center justify-center text-center">
            <Clock3 size={24} class="text-[var(--color-text-muted)]" />
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">
              No active session
            </p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Open a session before using Time Travel.
            </p>
          </div>
        {:else if loadError}
          <div
            class="flex min-h-52 flex-col items-center justify-center px-5 text-center"
            role="alert"
          >
            <span class="rounded-lg bg-[var(--color-error-bg)] p-2 text-[var(--color-error)]">
              <AlertTriangle size={22} />
            </span>
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">
              Recorded states could not be loaded
            </p>
            <p class="mt-1 max-w-md text-xs leading-relaxed text-[var(--color-text-muted)]">
              {loadError}
            </p>
            <button
              type="button"
              class="btn btn-secondary mt-4"
              onclick={() => activeSessionId && void loadTimeline(activeSessionId)}
            >
              Retry
            </button>
          </div>
        {:else if !timelineState || timelineState.timeline.length === 0}
          <div class="flex min-h-52 flex-col items-center justify-center text-center">
            <Clock3 size={24} class="text-[var(--color-text-muted)]" />
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">
              No recorded states yet
            </p>
            <p class="mt-1 max-w-sm text-xs leading-relaxed text-[var(--color-text-muted)]">
              Koryphaios records eligible completed turns and worker changes here as this session
              progresses.
            </p>
          </div>
        {:else}
          <ol class="space-y-2" aria-label="Session checkpoints">
            {#each timelineState.timeline as entry (entry.hash)}
              {@const isCurrent = entry.hash === timelineState.currentHash}
              {@const source = checkpointSource(entry.checkpointType)}
              {@const SourceIcon = source.icon}
              {@const title = entryTitle(entry)}
              {@const badges = instrumentationBadges(entry)}
              <li>
                <button
                  type="button"
                  class="group flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors {isCurrent
                    ? 'border-[var(--color-success)] bg-[var(--color-success-bg)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-warning)] hover:bg-[var(--color-surface-3)]'}"
                  disabled={!entry.recoverable ||
                    isCurrent ||
                    sessionBusy ||
                    !!wsStore.rewindPreviewLoadingHash}
                  onclick={() => void preview(entry)}
                  aria-label={isCurrent ? `${title}, current state` : `Preview rewind to ${title}`}
                >
                  <span
                    class="mt-0.5 rounded-lg bg-[var(--color-surface-3)] p-2 text-[var(--color-text-muted)] group-hover:text-[var(--color-warning)]"
                  >
                    {#if isCurrent}<Check
                        size={14}
                        class="text-[var(--color-success)]"
                      />{:else}<SourceIcon size={14} />{/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="truncate text-xs font-medium text-[var(--color-text-primary)]"
                        >{title}</span
                      >
                      {#if isCurrent}<span
                          class="rounded bg-[var(--color-success-bg)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-success)]"
                          >Current</span
                        >{/if}
                      {#if entry.hasRichMetadata}<span
                          class="rounded bg-[var(--color-surface-3)] px-1 py-0.5 text-[8px] font-medium text-[var(--color-text-muted)]"
                          title="Has expandable metadata">rich</span
                        >{/if}
                    </span>
                    <span
                      class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-muted)]"
                    >
                      <span>{formatTimestamp(entry.timestamp)}</span><span>{source.label}</span
                      ><span>{checkpointLabel(entry.checkpointType)}</span>
                      {#if entry.model}<span class="font-mono">{entry.model}</span>{/if}
                      {#if entry.cost !== undefined}<span class="font-mono"
                          >${entry.cost.toFixed(4)}</span
                        >{/if}
                    </span>
                    {#if badges.length > 0}
                      <span class="mt-1 flex flex-wrap gap-1">
                        {#each badges as badge}
                          <span
                            class="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--color-text-muted)]"
                            >{badge}</span
                          >
                        {/each}
                      </span>
                    {/if}
                  </span>
                  {#if wsStore.rewindPreviewLoadingHash === entry.hash}
                    <LoaderCircle size={15} class="mt-2 animate-spin text-[var(--color-warning)]" />
                  {:else if !isCurrent}
                    <ArrowRight
                      size={15}
                      class="mt-2 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--color-warning)]"
                    />
                  {/if}
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <footer
        class="flex items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-3"
      >
        <p class="text-[10px] text-[var(--color-text-muted)]">
          {loadError
            ? 'Retry after resolving the repository or backend error.'
            : sessionBusy
              ? 'Stop the active run before selecting a state.'
              : 'Select a state to inspect its files and evidence before rewinding.'}
        </p>
        <button type="button" class="btn btn-secondary shrink-0" onclick={close}
          >Keep current state</button
        >
      </footer>
    </div>
  </div>
{/if}
