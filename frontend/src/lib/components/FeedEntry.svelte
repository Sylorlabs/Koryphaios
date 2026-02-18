<script lang="ts">
  import {
    MessageSquare,
    Send,
    ChevronRight,
    ChevronDown,
    Trash2
  } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import { marked } from 'marked';
  import hljs from 'highlight.js';
  import 'highlight.js/styles/atom-one-dark.css';
  import type { FeedEntryLocal, FeedEntryType } from '$lib/types';

  // Shared renderer configuration
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string, lang?: string }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const highlighted = hljs.highlight(text, { language }).value;
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  };
  marked.setOptions({ renderer });

  let {
    entry,
    isSelected,
    isExpanded,
    onSelect,
    onToggleGroup,
    onDelete
  } = $props<{
    entry: FeedEntryLocal;
    isSelected: boolean;
    isExpanded: boolean;
    onSelect: (e: MouseEvent) => void;
    onToggleGroup: () => void;
    onDelete: (e: MouseEvent) => void;
  }>();

  // Debounced markdown parsing for performance
  let debouncedText = $state('');
  let timer: ReturnType<typeof setTimeout>;

  $effect(() => {
    // If the text is short or not streaming (no cursor/status check available here easily, so we just check length diff),
    // we can update immediately. But for safety during streaming, we debounce.
    // If the text has changed:
    if (entry.text !== debouncedText) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        debouncedText = entry.text;
      }, 100); // 100ms debounce
    }
    return () => clearTimeout(timer);
  });

  // Derived parsed HTML from the DEBOUNCED text
  let parsedHtml = $derived.by(() => {
    if (!debouncedText) return '';
    try {
      return marked.parse(debouncedText, { async: false }) as string;
    } catch {
      return debouncedText;
    }
  });

  function getEntryColor(type: FeedEntryType): string {
    switch (type) {
      case 'user_message': return 'text-accent font-medium';
      case 'thought': return 'text-yellow-400';
      case 'content': return 'text-text-primary';
      case 'thinking': return 'text-blue-400/70';
      case 'tool_call': return 'text-accent';
      case 'tool_result': return 'text-green-400';
      case 'routing': return 'text-yellow-300';
      case 'error': return 'text-red-400';
      case 'system': return 'text-text-muted';
      case 'tool_group': return 'text-blue-400 font-medium italic';
      default: return 'text-text-secondary';
    }
  }

  function getStatusForType(type: FeedEntryType): import('@koryphaios/shared').AgentStatus {
    switch (type) {
      case 'user_message': return 'idle';
      case 'thought': return 'thinking';
      case 'content': return 'streaming';
      case 'thinking': return 'thinking';
      case 'tool_call': return 'tool_calling';
      case 'tool_result': return 'done';
      case 'routing': return 'verifying';
      case 'error': return 'error';
      case 'system': return 'idle';
      case 'tool_group': return 'reading';
      default: return 'idle';
    }
  }
</script>

<div
  class="flex flex-col group"
  in:fly={{ y: 20, duration: (Date.now() - entry.timestamp < 5000) ? 300 : 0 }}
  style="content-visibility: auto; contain-intrinsic-size: 80px;"
>
  <div
    class="flex items-start gap-3 py-2 text-sm leading-relaxed rounded px-3 -mx-2 transition-all cursor-default
           {entry.type === 'user_message' ? 'feed-user-message' : ''}
           {isSelected ? 'bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30' : 'hover:bg-surface-2/30'}"
    onclick={(e) => entry.type === 'tool_group' ? onToggleGroup() : onSelect(e)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') entry.type === 'tool_group' ? onToggleGroup() : onSelect(e as unknown as MouseEvent); }}
    role="row"
    tabindex="0"
  >
    <span class="text-xs text-text-muted shrink-0 w-16 leading-6 tabular-nums pt-0.5">
      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>

    {#if entry.type === 'user_message'}
      <div class="shrink-0 flex items-center justify-center w-5 h-6">
        <Send size={14} class="text-accent" />
      </div>
    {:else if entry.type === 'tool_group'}
      <div class="shrink-0 flex items-center justify-center w-5 h-6">
        {#if isExpanded}
          <ChevronDown size={14} class="text-blue-400" />
        {:else}
          <ChevronRight size={14} class="text-blue-400" />
        {/if}
      </div>
    {:else}
      <div
        class="shrink-0 flex items-center justify-center w-5 h-6 pt-1"
      >
        <AnimatedStatusIcon status={getStatusForType(entry.type)} size={14} isManager={entry.agentId === 'kory-manager'} />
      </div>
    {/if}

    <div class="flex-1 min-w-0 {entry.type === 'content' ? 'markdown-content' : ''}">
      <span class="text-xs font-semibold tracking-wide {entry.glowClass === 'glow-kory' ? 'text-yellow-400' : entry.type === 'user_message' ? 'text-accent' : 'text-text-secondary'}">
        {entry.agentName}
      </span>
      {#if entry.type === 'thinking'}
          <ThinkingBlock
            text={entry.text}
            durationMs={entry.durationMs}
            agentName={entry.agentName}
          />
      {:else if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought' || entry.type === 'tool_result'}
          <div class="{getEntryColor(entry.type)} break-words mt-1 markdown-content">
            {@html parsedHtml}
          </div>
      {:else}
          <div class="{getEntryColor(entry.type)} break-words mt-1">
            {entry.text}
          </div>
      {/if}
    </div>

    <button
      class="shrink-0 p-1.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity flex items-center justify-center"
      style="color: var(--color-text-muted);"
      onclick={(e) => { e.stopPropagation(); onDelete(e); }}
      title="Delete message"
    >
      <Trash2 size={14} />
    </button>
  </div>

  {#if entry.type === 'tool_group' && isExpanded}
    <div class="ml-20 border-l-2 border-[var(--color-border)] pl-4 py-2 space-y-2 my-1" transition:fly={{ y: -10, duration: 200 }}>
      {#each entry.entries || [] as subEntry (subEntry.id)}
        <div class="flex items-start gap-2 text-[12px] opacity-80 hover:opacity-100 transition-opacity">
          <span class="text-[var(--color-text-muted)] w-12 shrink-0">
            {new Date(subEntry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <div class="flex-1 min-w-0 font-mono">
            <span class={getEntryColor(subEntry.type)}>{subEntry.text}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>