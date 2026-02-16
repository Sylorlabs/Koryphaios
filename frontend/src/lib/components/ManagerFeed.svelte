<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { tick } from 'svelte';
  import { 
    MessageSquare, 
    Brain, 
    FileText, 
    Wrench, 
    Box, 
    ArrowRightLeft, 
    AlertCircle, 
    Zap,
    Send,
    Search,
    Filter,
    ArrowDown,
    Trash2,
    ChevronRight,
    ChevronDown
  } from 'lucide-svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import { marked } from 'marked';
  import hljs from 'highlight.js';
  import 'highlight.js/styles/atom-one-dark.css';

  // Configure marked with syntax highlighting
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string, lang?: string }) => {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const highlighted = hljs.highlight(text, { language }).value;
    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
  };
  
  marked.setOptions({ renderer });

  function renderMarkdown(text: string): string {
    try {
      if (!text) return '';
      return marked.parse(text, { async: false }) as string;
    } catch {
      return text;
    }
  }

  type FeedEntryType = "user_message" | "thought" | "content" | "thinking" | "tool_call" | "tool_result" | "routing" | "error" | "system" | "tool_group";

  interface FeedEntryLocal {
    id: string;
    timestamp: number;
    type: FeedEntryType;
    agentId: string;
    agentName: string;
    glowClass: string;
    text: string;
    durationMs?: number;
    thinkingStartedAt?: number;
    isCollapsed?: boolean;
    entries?: FeedEntryLocal[];
    metadata?: Record<string, unknown>;
  }

  let feedContainer = $state<HTMLDivElement>();
  let autoScroll = $state(true);
  let selectedEntries = $state<Set<string>>(new Set());
  let lastSelectedId = $state<string>('');
  let expandedGroups = $state<Set<string>>(new Set());

  let filteredFeed = $derived(wsStore.groupedFeed as unknown as FeedEntryLocal[]);

  $effect(() => {
    const len = filteredFeed.length;
    if (autoScroll && feedContainer) {
      tick().then(() => {
        if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;
      });
    }
  });

  function handleScroll() {
    if (!feedContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = feedContainer;
    autoScroll = scrollHeight - scrollTop - clientHeight < 100;
  }

  function toggleGroup(id: string) {
    if (expandedGroups.has(id)) {
      expandedGroups.delete(id);
    } else {
      expandedGroups.add(id);
    }
    expandedGroups = new Set(expandedGroups);
  }

  function handleEntryClick(entry: FeedEntryLocal, e: MouseEvent) {
    if (e.shiftKey) {
      // Range select
      e.preventDefault();
      const next = new Set(selectedEntries);
      if (lastSelectedId) {
        const ids = filteredFeed.map(f => f.id);
        const startIdx = ids.indexOf(lastSelectedId);
        const endIdx = ids.indexOf(entry.id);
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
        }
      } else {
        next.add(entry.id);
      }
      selectedEntries = next;
      lastSelectedId = entry.id;
    } else if (e.ctrlKey) {
      // Toggle individual selection
      e.preventDefault();
      const next = new Set(selectedEntries);
      if (next.has(entry.id)) {
        next.delete(entry.id);
      } else {
        next.add(entry.id);
      }
      selectedEntries = next;
      lastSelectedId = entry.id;
    } else {
      // Normal click — set anchor, clear previous selection
      selectedEntries = new Set([entry.id]);
      lastSelectedId = entry.id;
    }
  }

  function deleteSelected() {
    if (selectedEntries.size === 0) return;
    wsStore.removeEntries(selectedEntries);
    selectedEntries = new Set();
    lastSelectedId = '';
  }

  function deleteSingle(id: string) {
    wsStore.removeEntries(new Set([id]));
  }

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

  /** Map feed entry types to the closest AgentStatus for animated icon */
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

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="panel-header flex items-center justify-between">
    <span class="panel-title flex items-center gap-1.5">
      <MessageSquare size={14} />
      Agent Feed
    </span>
    <div class="flex items-center gap-2">
      {#if selectedEntries.size > 0}
        <button
          onclick={deleteSelected}
          class="btn btn-secondary flex items-center gap-1"
          style="padding: 4px 8px; font-size: 10px; color: var(--color-error);"
        >
          <Trash2 size={10} />Delete {selectedEntries.size}
        </button>
      {/if}
      {#if !autoScroll}
        <button
          onclick={() => { autoScroll = true; feedContainer?.scrollTop !== undefined && (feedContainer.scrollTop = feedContainer.scrollHeight); }}
          class="btn btn-secondary flex items-center gap-1"
          style="padding: 4px 8px; font-size: 10px;"
        >
          <ArrowDown size={10} />Bottom
        </button>
      {/if}
    </div>
  </div>

  <div
    bind:this={feedContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto p-3 space-y-1"
  >
    {#if filteredFeed.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center text-center">
        <MessageSquare size={32} class="empty-state-icon mb-3" style="color: var(--color-text-muted); opacity: 0.3;" />
        <p class="text-sm" style="color: var(--color-text-secondary);">Ready for your request</p>
        <p class="text-xs mt-1" style="color: var(--color-text-muted);">Type a message below to get started</p>
      </div>
    {:else}
      {#each filteredFeed as entry (entry.id)}
        <div class="flex flex-col group">
          <div
            class="flex items-start gap-2.5 py-1.5 text-sm leading-relaxed rounded px-2 -mx-2 transition-colors cursor-default
                   {entry.type === 'user_message' ? 'feed-user-message' : ''}
                   {selectedEntries.has(entry.id) ? 'bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30' : 'hover:bg-surface-2/30'}"
            onclick={(e) => entry.type === 'tool_group' ? toggleGroup(entry.id) : handleEntryClick(entry, e)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') entry.type === 'tool_group' ? toggleGroup(entry.id) : handleEntryClick(entry, e as unknown as MouseEvent); }}
            role="row"
            tabindex="0"
          >
            <span class="text-xs text-text-muted shrink-0 w-16 leading-5 tabular-nums">
              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>

            {#if entry.type === 'user_message'}
              <div class="shrink-0 flex items-center justify-center w-[14px] h-5">
                <Send size={13} class="text-accent" />
              </div>
            {:else if entry.type === 'tool_group'}
              <div class="shrink-0 flex items-center justify-center w-[14px] h-5">
                {#if expandedGroups.has(entry.id)}
                  <ChevronDown size={14} class="text-blue-400" />
                {:else}
                  <ChevronRight size={14} class="text-blue-400" />
                {/if}
              </div>
            {:else}
              <div
                class="shrink-0 flex items-center justify-center w-[14px] h-5"
                style={getStatusForType(entry.type) === 'thinking' ? 'transform: translateY(7px);' : ''}
              >
                <AnimatedStatusIcon status={getStatusForType(entry.type)} size={14} isManager={entry.agentId === 'kory-manager'} />
              </div>
            {/if}

              <div class="flex-1 min-w-0 {entry.type === 'content' ? 'markdown-content' : ''}">
                <span class="text-xs font-medium {entry.glowClass === 'glow-kory' ? 'text-yellow-400' : entry.type === 'user_message' ? 'text-accent' : 'text-text-secondary'}">
                  {entry.agentName}
                </span>
                {#if entry.type === 'thinking'}
                   <ThinkingBlock 
                     text={entry.text} 
                     durationMs={entry.durationMs} 
                     agentName={entry.agentName} 
                   />
                {:else if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought' || entry.type === 'tool_result'}
                   <div class="{getEntryColor(entry.type)} break-words ml-1 markdown-content">
                     {@html renderMarkdown(entry.text)}
                   </div>
                {:else}
                   <span class="{getEntryColor(entry.type)} break-words ml-1">
                     {entry.text}
                   </span>
                {/if}
              </div>

            <button
              class="shrink-0 p-1 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity flex items-center justify-center"
              style="color: var(--color-text-muted);"
              onclick={(e) => { e.stopPropagation(); deleteSingle(entry.id); }}
              title="Delete message"
            >
              <Trash2 size={12} />
            </button>
          </div>

          {#if entry.type === 'tool_group' && expandedGroups.has(entry.id)}
            <div class="ml-20 border-l border-[var(--color-border)] pl-4 py-1 space-y-1 my-1">
              {#each entry.entries || [] as subEntry (subEntry.id)}
                <div class="flex items-start gap-2 text-[11px] opacity-70">
                  <span class="text-[var(--color-text-muted)] w-12 shrink-0">
                    {new Date(subEntry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <div class="flex-1 min-w-0">
                    <span class={getEntryColor(subEntry.type)}>{subEntry.text}</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  :global(.markdown-content) { font-size: 13px; line-height: 1.5; }
  :global(.markdown-content p) { margin-bottom: 0.5em; }
  :global(.markdown-content p:last-child) { margin-bottom: 0; }
  :global(.markdown-content pre) { 
    background: var(--color-surface-0); 
    padding: 0.75em; 
    border-radius: 6px; 
    overflow-x: auto; 
    margin: 0.5em 0; 
    border: 1px solid var(--color-border);
  }
  :global(.markdown-content code) { 
    font-family: 'JetBrains Mono', monospace; 
    font-size: 12px;
  }
  :global(.markdown-content :not(pre) > code) {
    background: var(--color-surface-2);
    padding: 0.1em 0.3em;
    border-radius: 3px;
    color: var(--color-accent);
  }
  :global(.markdown-content ul, :global(.markdown-content ol)) { margin-left: 1.25em; margin-bottom: 0.5em; list-style: disc; }
  :global(.markdown-content ol) { list-style: decimal; }
  :global(.markdown-content blockquote) { 
    border-left: 3px solid var(--color-border); 
    padding-left: 0.75em; 
    color: var(--color-text-muted);
    font-style: italic;
  }
  :global(.markdown-content a) { color: var(--color-accent); text-decoration: underline; }
  :global(.markdown-content h1, :global(.markdown-content h2), :global(.markdown-content h3)) { 
    font-weight: 600; 
    margin-top: 1em; 
    margin-bottom: 0.5em; 
    color: var(--color-text-primary);
  }
</style>
