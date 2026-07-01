<script lang="ts">
  import { slide } from 'svelte/transition';

  interface Props {
    text: string;
    durationMs?: number;
    agentName: string;
  }

  let { text, durationMs, agentName: _agentName }: Props = $props();
  let expanded = $state(false);
  let panelEl = $state<HTMLDivElement>();

  // ── Live detection + stopwatch ─────────────────────────────────────────────
  // The block is "live" while its text is still growing. When tokens stop
  // arriving for STALL_MS the stopwatch freezes (and resumes if more arrive).
  const STALL_MS = 1_500;
  const TICK_MS = 100;

  let now = $state(performance.now());
  // Start "not live": a block restored from history must not tick on mount.
  // Only text growth AFTER mount starts the stopwatch.
  let lastGrowthAt = $state(performance.now() - STALL_MS);
  // Anchor so the ticker continues from the server-computed duration when a
  // block is mounted mid-stream (e.g. after a session switch). Deliberately
  // captures the INITIAL durationMs — later updates flow through displayMs.
  // svelte-ignore state_referenced_locally
  let anchor = performance.now() - (durationMs ?? 0);
  let frozenMs = $state<number | null>(null);
  let sawMount = false;

  $effect(() => {
    void text.length;
    if (!sawMount) {
      // First run is the mount itself, not a streamed token.
      sawMount = true;
      return;
    }
    lastGrowthAt = performance.now();
    if (frozenMs !== null) {
      // Tokens resumed after a stall — re-anchor so elapsed continues from
      // where the stopwatch froze instead of jumping.
      anchor = performance.now() - frozenMs;
      frozenMs = null;
    }
  });

  let isLive = $derived(frozenMs === null && now - lastGrowthAt < STALL_MS);

  $effect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      now = performance.now();
      if (performance.now() - lastGrowthAt >= STALL_MS) {
        frozenMs = performance.now() - anchor - STALL_MS;
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  });

  let displayMs = $derived.by(() => {
    if (isLive) return Math.max(0, now - anchor);
    // Frozen: prefer the server-computed duration when it's sane, else the
    // client-side measurement.
    if (durationMs && durationMs > 0) return durationMs;
    return frozenMs ?? 0;
  });

  function formatDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${m}m ${rem}s`;
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
  class="thinking-row group"
  onclick={() => (expanded = !expanded)}
  aria-expanded={expanded}
  title={expanded ? 'Hide reasoning' : 'Show reasoning'}
>
  {#if isLive}
    <span class="label shimmer">Thinking…</span>
  {:else}
    <span class="label done">Thought for</span>
  {/if}
  <span class="stopwatch tabular-nums" class:live={isLive}>{formatDuration(displayMs)}</span>
  <span class="expand-cue {expanded ? 'rotated' : ''}" aria-hidden="true">▸</span>
</button>

<!-- Expanded: full reasoning (streams live while thinking) -->
{#if expanded}
  <div
    class="thinking-expanded"
    bind:this={panelEl}
    transition:slide={{ duration: 180 }}
  >
    <p class="thinking-full-text">{text || '…'}</p>
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
    padding: 2px 0;
    text-align: left;
    opacity: 0.75;
    transition: opacity var(--duration-normal) var(--ease-in-out);
  }

  .thinking-row:hover {
    opacity: 1;
  }

  .label {
    font-style: italic;
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

  .expand-cue {
    display: inline-block;
    font-size: 9px;
    color: var(--color-text-muted);
    opacity: 0.4;
    transition: transform var(--duration-normal) var(--ease-in-out);
    flex-shrink: 0;
  }

  .expand-cue.rotated {
    transform: rotate(90deg);
  }

  .thinking-expanded {
    position: relative;
    padding: var(--space-md) var(--space-lg);
    border-left: 2px solid var(--color-border);
    margin: var(--space-sm) 0;
    max-width: 90%;
    max-height: 18rem;
    overflow-y: auto;
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
