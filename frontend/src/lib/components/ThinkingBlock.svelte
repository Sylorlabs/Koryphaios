<script lang="ts">
// The duration is measured from the server timestamp when the agent entered
// thinking until its next action. This includes providers that buffer all
// reasoning into one event, while avoiding an inaccurate client stopwatch.
  import { slide } from 'svelte/transition';
  import { untrack } from 'svelte';
  import { requestExpandAnchor } from '$lib/utils/expand-anchor';
  import { formatCompactTokens } from '$lib/utils/cache-break-impact';

  interface Props {
    text: string;
    /** Server-computed elapsed ms (thinking state start → next action). */
    durationMs?: number;
    /** Server timestamp at which the agent entered the thinking state. */
    thinkingStartedAt?: number;
    agentName: string;
    /** Provider said reasoning is over — the number is final. */
    finalized?: boolean;
    /** Tokens used for this reasoning block, shown next to the timer. */
    thinkingTokens?: number;
    /** Start with the reasoning panel open (user setting). */
    defaultExpanded?: boolean;
  }

  let { text, durationMs, thinkingStartedAt, agentName: _agentName, finalized = false, defaultExpanded = false, thinkingTokens }: Props = $props();

  // Providers often terminate thoughts with several newlines. With pre-wrap,
  // those become empty line boxes even after the thought has finished.
  const reasoningText = $derived(text.trim());
  // svelte-ignore state_referenced_locally
  let expanded = $state(defaultExpanded);
  let panelEl = $state<HTMLDivElement>();
  const panelId = $props.id();

  // Monotonic guard: even if a stale prop update arrives, never display a
  // smaller number than the user has already seen.
  let peakMs = $state(0);
  $effect(() => {
    if ((durationMs ?? 0) > peakMs) peakMs = durationMs ?? 0;
  });

  // Live = provider hasn't finalized yet. Safety valve: if no new duration
  // arrives for 15s the run died mid-thought — stop shimmering AND stop the
  // stopwatch. Previously only the shimmer stopped while `now` kept ticking
  // against a never-finalized start, producing impossible values like "3000m".
  let staleAt = $state(0);
  $effect(() => {
    void durationMs;
    if (finalized) return;
    staleAt = 0;
    const t = setTimeout(() => (staleAt = Date.now()), 15_000);
    return () => clearTimeout(t);
  });
  let isLive = $derived(!finalized && staleAt === 0);

  // Snapshot of the stopwatch taken the moment the block goes stale, so the
  // display freezes at the last live value instead of collapsing to 0.0s
  // when no server duration ever arrived.
  //
  // Prefer the last server-reported duration: it is the honest elapsed time
  // as of the provider's final event, whereas extrapolating to the moment the
  // watchdog fired would bill the reader for however long we sat waiting for a
  // terminal event that never arrived. Only fall back to the live tick when
  // the server never sent a duration at all (a provider that buffers its whole
  // reasoning into one event), where the extrapolated value is the only number
  // the reader has ever seen.
  let frozenMs = $state(0);
  $effect(() => {
    if (staleAt !== 0 && !finalized && thinkingStartedAt) {
      const serverMs = durationMs ?? 0;
      const extrapolated = serverMs > 0 ? 0 : clampLiveTick(untrack(() => now) - thinkingStartedAt);
      const settled = Math.max(serverMs, extrapolated);
      if (settled > frozenMs) frozenMs = settled;
    }
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!isLive || !thinkingStartedAt) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(timer);
  });
  // Keep the live counter moving even when a provider buffers its reasoning
  // into a single event. The final server event replaces this with the exact
  // timestamp-to-timestamp duration when the next action arrives.
  // The live tick is bounded: it only runs while the block is live (server
  // updates within the last 15s) and is clamped so a corrupt or ancient
  // start timestamp can never render an absurd duration.
  let displayMs = $derived(
    Math.max(peakMs, durationMs ?? 0, frozenMs, isLive && thinkingStartedAt ? clampLiveTick(now - thinkingStartedAt) : 0),
  );

  /** Last-resort bound for the client-side live tick. Normal live ticks never
   *  approach this (the stale freeze stops them ~15s after the last server
   *  update); it only bites when the start timestamp is corrupt or ancient. */
  const MAX_LIVE_TICK_MS = 15 * 60 * 1000;

  function clampLiveTick(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) return 0;
    return Math.min(ms, MAX_LIVE_TICK_MS);
  }

  function formatDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const remS = Math.round(s % 60);
    if (m < 60) return `${m}m ${remS}s`;
    const h = Math.floor(m / 60);
    const remM = Math.round(m % 60);
    if (h < 24) return `${h}h ${remM}m`;
    const d = Math.floor(h / 24);
    const remH = Math.round(h % 24);
    return `${d}d ${remH}h`;
  }

  function toggle(event: MouseEvent) {
    // Opening the panel grows this row, which would push every message below
    // it down and out of view. Ask the transcript to absorb that growth into
    // its scroll offset so the messages below keep their place.
    requestExpandAnchor(event.currentTarget);
    expanded = !expanded;
  }

  // Auto-follow the reasoning stream when peeking live.
  $effect(() => {
    void text.length;
    if (expanded && isLive && panelEl) {
      panelEl.scrollTop = panelEl.scrollHeight;
    }
  });
</script>

<!-- Collapsed: reasoning fully hidden — just the stopwatch line -->
<button
  type="button"
  class="thinking-row group"
  onclick={toggle}
  aria-expanded={expanded}
  aria-controls={expanded ? panelId : undefined}
  title={expanded ? 'Hide reasoning' : 'Show reasoning'}
>
  {#if isLive}
    <span class="label shimmer">Thinking…</span>
  {:else}
    <span class="label done">Thought for</span>
  {/if}
  <span class="stopwatch tabular-nums" class:live={isLive}>{formatDuration(displayMs)}</span>
  {#if thinkingTokens && thinkingTokens > 0}
    <span class="thinking-tokens tabular-nums">{formatCompactTokens(thinkingTokens)} tokens</span>
  {/if}
  <span class="expand-cue {expanded ? 'rotated' : ''}" aria-hidden="true">▸</span>
</button>

<!-- Expanded: full reasoning (streams live while thinking) -->
{#if expanded}
  <!-- Scrollable reasoning must be reachable with the keyboard. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    id={panelId}
    class="thinking-expanded"
    role="region"
    aria-label="Reasoning"
    tabindex="0"
    bind:this={panelEl}
    transition:slide={{ duration: 180 }}
  >
    <p class="thinking-full-text">{reasoningText || 'Reasoning not provided.'}</p>
    {#if isLive}
      <span class="live-caret" aria-hidden="true"></span>
    {/if}
  </div>
{/if}

<style>
  .thinking-row {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    cursor: pointer;
    border: none;
    background: none;
    min-height: 28px;
    padding: 2px 0;
    text-align: left;
  }

  .thinking-row:focus-visible,
  .thinking-expanded:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 3px;
  }

  .label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .label.done {
    font-style: normal;
  }

  /* Claude-style soft left-to-right shimmer while reasoning streams */
  .label.shimmer {
    background: linear-gradient(
      90deg,
      var(--color-text-muted) 30%,
      var(--color-text-primary) 50%,
      var(--color-text-muted) 70%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: think-shimmer 1.8s linear infinite;
  }

  @keyframes think-shimmer {
    0% {
      background-position: 180% 0;
    }
    100% {
      background-position: -80% 0;
    }
  }

  .stopwatch {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .stopwatch.live {
    color: var(--color-text-secondary);
  }

  .thinking-tokens {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .expand-cue {
    display: inline-block;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    transition: transform var(--duration-normal) var(--ease-in-out);
    flex-shrink: 0;
  }

  .expand-cue.rotated {
    transform: rotate(90deg);
  }

  .thinking-expanded {
    position: relative;
    padding: var(--space-xs) 0 var(--space-xs) var(--space-md);
    border-left: 1px solid var(--color-border);
    margin: var(--space-xs) 0;
    max-width: 100%;
    max-height: 18rem;
    overflow-y: auto;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
  }

  .thinking-full-text {
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    margin: 0;
    display: inline;
  }

  .live-caret {
    display: inline-block;
    width: 6px;
    height: 12px;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--color-text-muted);
    animation: think-blink 1s steps(2, start) infinite;
  }

  @keyframes think-blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .label.shimmer {
      animation: none;
      -webkit-text-fill-color: currentColor;
      background: none;
    }
    .live-caret {
      animation: none;
    }
  }
</style>
