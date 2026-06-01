<script lang="ts">
  import { slide } from 'svelte/transition';

  interface Props {
    text: string;
    durationMs?: number;
    agentName: string;
  }

  let { text, durationMs: _durationMs, agentName: _agentName }: Props = $props();
  let expanded = $state(false);

  // Extract the first sentence (up to .!? followed by space/capital, or first 120 chars)
  let firstSentence = $derived.by(() => {
    if (!text) return 'Thinking…';
    const match = text.match(/^(.+?[.!?])(?=\s+[A-Z]|\s*$)/);
    if (match && match[1].length > 10) return match[1];
    // Fallback: first line
    const firstLine = text.split('\n')[0].trim();
    if (firstLine && firstLine.length <= 140) return firstLine;
    return firstLine ? firstLine.slice(0, 137) + '…' : 'Thinking…';
  });

  let hasMore = $derived(firstSentence !== text.trim());
</script>

<!-- Collapsed: just a whispered line -->
<button
  class="thinking-whisper group"
  onclick={() => expanded = !expanded}
  aria-expanded={expanded}
>
  <span class="summary-text">{firstSentence}</span>
  {#if hasMore}
    <span class="expand-cue {expanded ? 'rotated' : ''}" aria-hidden="true">▸</span>
  {/if}
</button>

<!-- Expanded: clean prose panel -->
{#if expanded && hasMore}
  <div class="thinking-expanded" transition:slide={{ duration: 180 }}>
    <p class="thinking-full-text">{text}</p>
  </div>
{/if}

<style>
  .thinking-whisper {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    cursor: pointer;
    border: none;
    background: none;
    padding: 2px 0;
    text-align: left;
    max-width: 90%;
    opacity: 0.65;
    transition: opacity var(--duration-normal) var(--ease-in-out);
  }

  .thinking-whisper:hover {
    opacity: 1;
  }

  .summary-text {
    font-style: italic;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
  }

  .expand-cue {
    display: inline-block;
    font-size: 9px;
    color: var(--color-text-muted);
    opacity: 0.4;
    transition: transform var(--duration-normal) var(--ease-in-out);
    flex-shrink: 0;
    margin-top: 2px;
  }

  .expand-cue.rotated {
    transform: rotate(90deg);
  }

  .thinking-expanded {
    padding: var(--space-md) var(--space-lg);
    border-left: 2px solid var(--color-border);
    margin: var(--space-sm) 0 var(--space-sm) 0;
    max-width: 90%;
  }

  .thinking-full-text {
    font-size: var(--text-sm);
    line-height: var(--leading-relaxed);
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    margin: 0;
    max-height: 18rem;
    overflow-y: auto;
  }
</style>
