<script lang="ts">
  import { slide } from 'svelte/transition';

  interface Props {
    text: string;
    durationMs?: number;
    agentName: string;
    /** Reasoning-token estimate for providers that redact the thinking text
     *  (Claude Code headless) but report progress. */
    estimatedTokens?: number;
    /** Initial disclosure state. The user can still collapse each block. */
    defaultExpanded?: boolean;
    /** Called when the stopwatch freezes — lets the parent persist the
     *  client-observed duration so remounts can't regress the number. */
    onFreeze?: (ms: number) => void;
  }

  let { text, durationMs, agentName: _agentName, estimatedTokens, defaultExpanded = false, onFreeze }: Props = $props();
  // Disclosure state is intentionally captured at mount; changing the global
  // preference must not reopen/close a block the user already toggled.
  // svelte-ignore state_referenced_locally
  let expanded = $state(defaultExpanded);
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
  // Only genuine growth counts — Svelte store reassignments can re-trigger the
  // effect with the same text, which must not restart the stopwatch.
  // Deliberately captures the INITIAL length; growth is tracked in the effect.
  // svelte-ignore state_referenced_locally
  let lastSeenLength = text.length;

  $effect(() => {
    // Growth = new thinking text OR a rising token estimate (redacted streams
    // have empty text but live token counts).
    const len = Math.max(text.length, estimatedTokens ?? 0);
    if (len <= lastSeenLength) return;
    lastSeenLength = len;
    lastGrowthAt = performance.now();
    if (frozenMs !== null) {
      // Tokens resumed after a stall — re-anchor so elapsed continues from
      // where the stopwatch froze instead of jumping.
      anchor = performance.now() - frozenMs;
      frozenMs = null;
    }
  });

  // A server-computed duration arriving mid-flight means the block is done —
  // freeze immediately instead of waiting out the stall window.
  $effect(() => {
    if (durationMs && durationMs > 0 && frozenMs === null && performance.now() - lastGrowthAt >= STALL_MS) {
      frozenMs = durationMs;
    }
  });

  let isLive = $derived(frozenMs === null && now - lastGrowthAt < STALL_MS);

  $effect(() => {
    if (!isLive) return;
    const timer = setInterval(() => {
      now = performance.now();
      if (performance.now() - lastGrowthAt >= STALL_MS) {
        // Freeze at the moment tokens stopped, not at detection time, so the
        // number never visibly jumps when the stopwatch stops.
        frozenMs = Math.max(0, lastGrowthAt - anchor);
        onFreeze?.(frozenMs);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  });

  let displayMs = $derived.by(() => {
    // Live: count only up to the last token's arrival — NOT through the stall
    // window. Ticking during the stall made the display run ~1.5s past the
    // real duration and then visibly jump back on freeze.
    if (isLive) return Math.max(0, Math.min(now, lastGrowthAt) - anchor);
    // Frozen: never go backwards — larger of client-observed and server value.
    return Math.max(frozenMs ?? 0, durationMs ?? 0);
  });

  // Reasoning-token display: provider-reported estimate when available,
  // else derived from the streamed text (~4 chars/token). Always shown.
  let displayTokens = $derived(
    estimatedTokens && estimatedTokens > 0 ? estimatedTokens : Math.ceil(text.length / 4),
  );

  function formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

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
  {#if displayTokens > 0}
    <span class="stopwatch tabular-nums" title={text ? 'Estimated reasoning tokens' : 'Reasoning tokens (text kept private by the provider)'}>· ~{formatTokens(displayTokens)} tok</span>
  {/if}
  <span class="expand-cue {expanded ? 'rotated' : ''}" aria-hidden="true">▸</span>
</button>

<!-- Expanded: full reasoning (streams live while thinking) -->
{#if expanded}
  <div
    class="thinking-expanded"
    bind:this={panelEl}
    transition:slide={{ duration: 180 }}
  >
    <p class="thinking-full-text">{text || (estimatedTokens ? `Anthropic keeps this model's raw reasoning on their servers (Claude Code only receives token counts) — ~${estimatedTokens} tokens of internal reasoning. Models with open reasoning (e.g. Haiku 4.5, most API providers) show their full text here.` : '…')}</p>
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
