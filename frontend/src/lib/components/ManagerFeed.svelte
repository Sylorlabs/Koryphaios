<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { isMac } from '$lib/utils/platform';
  import { tick, onMount } from 'svelte';
  import { 
    MessageSquare, 
    ArrowDown,
    Trash2,
    Paintbrush,
    Bug,
    Zap,
    Beaker
  } from 'lucide-svelte';
  import FeedEntry from './FeedEntry.svelte';
  import type { FeedEntryLocal, FeedEntryType } from '$lib/types';

  let feedContainer = $state<HTMLDivElement>();
  let autoScroll = $state(true);
  let selectedEntries = $state<Set<string>>(new Set());
  let lastSelectedId = $state<string>('');
  let expandedGroups = $state<Set<string>>(new Set());

  // Virtual List State
  let scrollTop = $state(0);
  let clientHeight = $state(800); // Default, updates on mount
  let itemHeight = 100; // Estimated average height
  const OVERSCAN = 5;

  let filteredFeed = $derived(wsStore.groupedFeed as unknown as FeedEntryLocal[]);
  
  // Derived Virtualization
  let startIndex = $derived(Math.max(0, Math.floor(scrollTop / itemHeight) - OVERSCAN));
  let endIndex = $derived(Math.min(filteredFeed.length, Math.ceil((scrollTop + clientHeight) / itemHeight) + OVERSCAN));
  let visibleItems = $derived(filteredFeed.slice(startIndex, endIndex));
  let paddingTop = $derived(startIndex * itemHeight);
  let paddingBottom = $derived(Math.max(0, (filteredFeed.length - endIndex) * itemHeight));

  // Track last feed length to avoid scroll loops
  let lastFeedLength = $state(0);

  // Auto-scroll effect
  $effect(() => {
    const len = filteredFeed.length;
    // Only scroll if new items were actually added
    if (autoScroll && feedContainer && len > lastFeedLength) {
      lastFeedLength = len;
      // Use requestAnimationFrame for smoother scrolling
      requestAnimationFrame(() => {
        if (feedContainer && autoScroll) {
          feedContainer.scrollTo({ top: feedContainer.scrollHeight, behavior: 'smooth' });
        }
      });
    } else if (len !== lastFeedLength) {
      lastFeedLength = len;
    }
  });

  function handleScroll(e: UIEvent) {
    if (!feedContainer) return;
    scrollTop = feedContainer.scrollTop;
    
    const { scrollHeight, clientHeight: ch } = feedContainer;
    // Buffer of 50px to determine if user is at bottom
    // We use the ACTUAL scrollHeight from DOM, not our calculated one, for this check
    const dist = scrollHeight - scrollTop - ch;
    autoScroll = dist < 50;
  }
  
  onMount(() => {
    if (feedContainer) {
      clientHeight = feedContainer.clientHeight;
      // Resize observer to update clientHeight if window resizes
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          clientHeight = entry.contentRect.height;
        }
      });
      ro.observe(feedContainer);
      return () => ro.disconnect();
    }
  });

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
    } else if (isMac() ? e.metaKey : e.ctrlKey) {
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
</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="panel-header flex items-center justify-between">
    <span class="panel-title flex items-center gap-2">
      <MessageSquare size={16} />
      Agent feed
    </span>
    <div class="flex items-center gap-2">
      {#if selectedEntries.size > 0}
        <button
          onclick={deleteSelected}
          class="btn btn-secondary flex items-center gap-1.5"
          style="padding: 4px 10px; font-size: 11px; color: var(--color-error);"
        >
          <Trash2 size={12} />Delete {selectedEntries.size}
        </button>
      {/if}
      {#if !autoScroll}
        <button
          onclick={() => { autoScroll = true; feedContainer?.scrollTo({ top: feedContainer.scrollHeight, behavior: 'smooth' }); }}
          class="btn btn-secondary flex items-center gap-1.5"
          style="padding: 4px 10px; font-size: 11px;"
        >
          <ArrowDown size={12} />Bottom
        </button>
      {/if}
    </div>
  </div>

  <div
    bind:this={feedContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto p-4 space-y-3"
  >
    {#if filteredFeed.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center text-center h-full max-w-2xl mx-auto py-12">
        <div class="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-6 text-amber-500">
          <MessageSquare size={32} />
        </div>
        <h2 class="text-xl font-semibold mb-2" style="color: var(--color-text-primary);">Ready for your request</h2>
        <p class="text-sm mb-8 text-text-muted">Start a new project or collaborate with specialized agents on your existing code.</p>
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 w-full">
          {#each [
            { label: 'Build a new UI component', icon: Paintbrush, prompt: 'Build a beautiful, responsive landing page using Tailwind and Svelte.' },
            { label: 'Debug an issue', icon: Bug, prompt: 'Help me find and fix a bug in my authentication logic.' },
            { label: 'Refactor for performance', icon: Zap, prompt: 'Analyze my code and suggest performance optimizations.' },
            { label: 'Write unit tests', icon: Beaker, prompt: 'Generate comprehensive unit tests for my backend API routes.' }
          ] as suggestion}
            <button 
              class="flex flex-col items-start p-4 rounded-xl border text-left transition-all hover:bg-[var(--color-surface-3)] active:scale-[0.98] group"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
              onclick={() => { wsStore.sendMessage(sessionStore.activeSessionId, suggestion.prompt); }}
            >
              <div class="w-8 h-8 rounded-lg bg-[var(--color-surface-3)] flex items-center justify-center mb-3 text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)] transition-colors">
                <suggestion.icon size={16} />
              </div>
              <span class="text-sm font-medium mb-1" style="color: var(--color-text-primary);">{suggestion.label}</span>
              <span class="text-[11px] leading-relaxed opacity-60 line-clamp-2" style="color: var(--color-text-muted);">{suggestion.prompt}</span>
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <!-- Virtual List Spacer -->
      <div style="padding-top: {paddingTop}px; padding-bottom: {paddingBottom}px;">
        {#each visibleItems as entry (entry.id)}
          <FeedEntry 
            {entry}
            isSelected={selectedEntries.has(entry.id)}
            isExpanded={expandedGroups.has(entry.id)}
            onSelect={(e) => handleEntryClick(entry, e)}
            onToggleGroup={() => toggleGroup(entry.id)}
            onDelete={() => deleteSingle(entry.id)}
          />
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  :global(.markdown-content) { font-size: 14px; line-height: 1.7; }
  :global(.markdown-content p) { margin-bottom: 0.75em; }
  :global(.markdown-content p:last-child) { margin-bottom: 0; }
  :global(.markdown-content pre) { 
    margin: 1em 0; 
  }
  :global(.markdown-content code) { 
    font-family: 'JetBrains Mono', monospace; 
    font-size: 13px;
  }
  :global(.markdown-content :not(pre) > code) {
    background: var(--color-surface-2);
    padding: 0.2em 0.4em;
    border-radius: 4px;
    color: var(--color-accent);
    font-size: 0.9em;
  }
  :global(.markdown-content ul, :global(.markdown-content ol)) { margin-left: 1.5em; margin-bottom: 0.75em; list-style: disc; }
  :global(.markdown-content ol) { list-style: decimal; }
  :global(.markdown-content blockquote) { 
    border-left: 4px solid var(--color-border); 
    padding-left: 1em; 
    color: var(--color-text-muted);
    font-style: italic;
    margin: 1em 0;
  }
  :global(.markdown-content a) { color: var(--color-accent); text-decoration: underline; text-underline-offset: 2px; }
  :global(.markdown-content h1, :global(.markdown-content h2), :global(.markdown-content h3)) { 
    font-weight: 600; 
    margin-top: 1.5em; 
    margin-bottom: 0.75em; 
    color: var(--color-text-primary);
  }
</style>