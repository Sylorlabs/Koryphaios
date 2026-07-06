<script lang="ts">
  // Thinking timer — deliberately dumb. The displayed duration IS the
  // server-computed value (first-delta → latest-delta timestamps): it only
  // moves when reasoning tokens actually arrive, is monotonic by construction,
  // and freezes the instant the provider signals reasoning is over
  // (finalized). No client stopwatch, no stall heuristics, no jumping.
  import { slide } from 'svelte/transition';

  interface Props {
    text: string;
    /** Server-computed elapsed ms (latest delta ts − first delta ts). */
    durationMs?: number;
    agentName: string;
    /** Provider said reasoning is over — the number is final. */
    finalized?: boolean;
    /** Reasoning-token estimate for providers that redact the thinking text
     *  (Claude Code headless) but report progress. */
    estimatedTokens?: number;
    /** Start with the reasoning panel open (user setting). */
    defaultExpanded?: boolean;
  }

  let { text, durationMs, agentName: _agentName, finalized = false, estimatedTokens, defaultExpanded = false }: Props = $props();
  // svelte-ignore state_referenced_locally
  let expanded = $state(defaultExpanded);
  let panelEl = $state<HTMLDivElement>();

  // Monotonic guard: even if a stale prop update arrives, never display a
  // smaller number than the user has already seen.
  let peakMs = $state(0);
  $effect(() => {
    if ((durationMs ?? 0) > peakMs) peakMs = durationMs ?? 0;
  });
  let displayMs = $derived(Math.max(peakMs, durationMs ?? 0));

  // Live = provider hasn't finalized yet. Safety valve: if no new duration
  // arrives for 15s the run died mid-thought — stop shimmering.
  let staleAt = $state(0);
  $effect(() => {
    void durationMs;
    if (finalized) return;
    staleAt = 0;
    const t = setTimeout(() => (staleAt = Date.now()), 15_000);
    return () => clearTimeout(t);
  });
  let isLive = $derived(!finalized && staleAt === 0);

  // Reasoning tokens: provider estimate when reported, else ~4 chars/token
  // from the streamed text. Monotonic via the same peak guard upstream.
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
    <p class="thinking-full-text">{text || (estimatedTokens ? `Anthropic keeps this model's raw reasoning on their servers (Claude Code only receives token counts) — ~${estimatedTokens} tokens of internal reasoning. Models with open reasoning (e.g. Haiku 4.5, Cursor, Antigravity, most API providers) show their full text here.` : '…')}</p>
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
