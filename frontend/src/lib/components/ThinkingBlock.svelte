<script lang="ts">
  import { ChevronDown, Lightbulb, Clock } from 'lucide-svelte';
  import { slide } from 'svelte/transition';

  interface Props {
    text: string;
    durationMs?: number;
    agentName: string;
  }

  let { text, durationMs, agentName }: Props = $props();
  let expanded = $state(false);

  // Derive a summary from the first line or first 100 chars
  let summary = $derived.by(() => {
    if (!text) return 'Thinking...';
    const firstLine = text.split('\n')[0].trim();
    if (firstLine.length > 100) return firstLine.slice(0, 97) + '...';
    return firstLine || 'Processing...';
  });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
</script>

<div class="thinking-block group mb-2 overflow-hidden border border-blue-500/20 rounded-xl bg-blue-500/5 transition-all hover:bg-blue-500/10">
  <button
    class="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
    onclick={() => expanded = !expanded}
  >
    <div class="flex items-center justify-center w-6 h-6 rounded-full bg-blue-500/20 text-blue-400">
      <Lightbulb size={14} class={text ? 'animate-pulse' : ''} />
    </div>

    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 mb-0.5">
        <span class="text-[10px] font-bold uppercase tracking-wider text-blue-400/80">{agentName} is thinking</span>
        {#if durationMs !== undefined}
          <div class="flex items-center gap-1 text-[10px] text-blue-400/60 font-medium">
            <Clock size={10} />
            {formatDuration(durationMs)}
          </div>
        {/if}
      </div>
      <p class="text-sm text-blue-200/70 truncate font-medium">{summary}</p>
    </div>

    <div class="shrink-0 text-blue-400/40 transition-transform duration-300 {expanded ? 'rotate-180' : ''}">
      <ChevronDown size={16} />
    </div>
  </button>

  {#if expanded}
    <div transition:slide={{ duration: 250 }}>
      <div class="px-4 pb-4 pt-1 border-t border-blue-500/10">
        <div class="text-xs leading-relaxed text-blue-100/60 font-mono whitespace-pre-wrap selection:bg-blue-500/30">
          {text}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .thinking-block {
    max-width: 90%;
  }
</style>
