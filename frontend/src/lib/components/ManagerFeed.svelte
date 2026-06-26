<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { isMac } from '$lib/utils/platform';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import {
    MessageSquare,
    ArrowDown,
    Trash2,
    Paintbrush,
    Bug,
    Zap,
    Beaker,
    GitBranch,
    Pencil,
    Check,
    X
  } from 'lucide-svelte';
  import FeedEntry from './FeedEntry.svelte';
  import type { FeedEntryLocal } from '$lib/types';

  let feedContainer = $state<HTMLDivElement>();
  let autoScroll = $state(true);
  let selectedEntries = $state<Set<string>>(new Set());
  let lastSelectedId = $state<string>('');
  let expandedGroups = $state<Set<string>>(new Set());
  let editingSuggestionId = $state<string | null>(null);
  let editingSuggestionText = $state('');

  interface Props {
    onUseSuggestion?: (prompt: string) => void;
  }

  let { onUseSuggestion }: Props = $props();

  type DashboardSuggestion = {
    id: string;
    label: string;
    icon: typeof Zap;
    prompt: string;
  };

  const defaultSuggestions: DashboardSuggestion[] = [
    { id: 'map-codebase', label: 'Map the codebase', icon: Zap, prompt: 'Inspect this project and summarize the architecture, key entry points, and the highest-leverage next steps.' },
    { id: 'critique-ui', label: 'Critique the UI', icon: Paintbrush, prompt: 'Critique the current UI in this project, identify the weakest hierarchy and spacing choices, and recommend the most important visual fixes.' },
    { id: 'review-changes', label: 'Review recent changes', icon: GitBranch, prompt: 'Review the current uncommitted changes in this project and identify the most likely bugs, regressions, or missing tests.' },
    { id: 'debug-regression', label: 'Debug a regression', icon: Bug, prompt: 'Help me trace a bug in this project. Start by asking for the failing behavior or error, then narrow the likely root cause.' }
  ];
  let suggestions = $state<DashboardSuggestion[]>(defaultSuggestions);

  let filteredFeed = $derived(wsStore.groupedFeed);

  // Track last feed length to avoid scroll loops
  let lastFeedLength = $state(0);
  let lastUserScrollAt = $state(0);

  // Auto-scroll effect: only when new items added and user was already at bottom (not right after they scrolled up)
  $effect(() => {
    const len = filteredFeed.length;
    const justScrolled = Date.now() - lastUserScrollAt < 200;
    if (autoScroll && feedContainer && len > lastFeedLength && !justScrolled) {
      lastFeedLength = len;
      requestAnimationFrame(() => {
        if (feedContainer && autoScroll) {
          feedContainer.scrollTop = feedContainer.scrollHeight;
        }
      });
    } else if (len !== lastFeedLength) {
      lastFeedLength = len;
    }
  });

  function handleScroll(_e: UIEvent) {
    if (!feedContainer) return;
    lastUserScrollAt = Date.now();

    const { scrollHeight, clientHeight: ch } = feedContainer;
    const scrollTop = feedContainer.scrollTop;
    const dist = scrollHeight - scrollTop - ch;
    autoScroll = dist < 50;
  }
  
  onMount(() => {
    if (!feedContainer) return;
    const container = feedContainer;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (autoScroll) {
          container.scrollTop = container.scrollHeight;
        } else {
          const dist = container.scrollHeight - container.scrollTop - entry.contentRect.height;
          autoScroll = dist < 50;
        }
      }
    });
    ro.observe(container);

    // Scroll during streaming: fire on any DOM content change inside the feed
    let rafId: number | null = null;
    const mo = new MutationObserver(() => {
      if (!autoScroll) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (autoScroll) container.scrollTop = container.scrollHeight;
      });
    });
    mo.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
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
        const startIdx = filteredFeed.findIndex(f => f.id === lastSelectedId);
        const endIdx = filteredFeed.findIndex(f => f.id === entry.id);
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) next.add(filteredFeed[i].id);
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

  function runSuggestion(prompt: string) {
    onUseSuggestion?.(prompt);
  }

  function handleSuggestionKeydown(event: KeyboardEvent, prompt: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    runSuggestion(prompt);
  }

  function startEditingSuggestion(suggestion: DashboardSuggestion) {
    editingSuggestionId = suggestion.id;
    editingSuggestionText = suggestion.prompt;
  }

  function cancelEditingSuggestion() {
    editingSuggestionId = null;
    editingSuggestionText = '';
  }

  function saveSuggestionEdit(id: string) {
    const nextText = editingSuggestionText.trim();
    if (!nextText) return;
    suggestions = suggestions.map((suggestion) =>
      suggestion.id === id ? { ...suggestion, prompt: nextText } : suggestion
    );
    editingSuggestionId = null;
    editingSuggestionText = '';
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
    </div>
  </div>

  <div class="relative flex-1 min-h-0 overflow-hidden">
    <div
      bind:this={feedContainer}
      onscroll={handleScroll}
      class="absolute inset-0 overflow-y-auto p-4 space-y-3 feed-scroll"
    >
    {#if filteredFeed.length === 0}
      <div class="px-6 py-10 max-w-5xl mx-auto">
        <div class="flex gap-5 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <div class="flex-1 space-y-6 min-w-0">
            <div class="rounded-[28px] border p-8 shadow-2xl backdrop-blur-sm" style="background: linear-gradient(165deg, rgba(213, 178, 97, 0.12), rgba(12, 10, 9, 0.4)); border-color: rgba(213, 178, 97, 0.24);">
              <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border mb-6" style="background: rgba(0, 0, 0, 0.2); border-color: rgba(213, 178, 97, 0.15); color: var(--color-text-secondary);">
                <div class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
                <span class="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">Workspace Analyzed</span>
              </div>
              
              <h2 class="text-3xl font-semibold leading-tight mb-4 tracking-tight" style="color: var(--color-text-primary);">
                What should Koryphaios do with your project?
              </h2>
              
              <p class="text-[15px] max-w-2xl leading-relaxed mb-10 opacity-70" style="color: var(--color-text-secondary);">
                I'm connected and ready to help. Choose a strategic starting point or describe your task in the composer below.
              </p>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
                {#each suggestions as suggestion (suggestion.id)}
                  {@const Icon = suggestion.icon}
                  <div 
                    class="suggestion-card relative flex flex-col items-start p-5 rounded-2xl border text-left transition-all duration-300 group cursor-pointer overflow-hidden"
                    style="background: rgba(12, 10, 9, 0.4); border-color: var(--color-border);"
                    role="button"
                    tabindex="0"
                    onclick={() => runSuggestion(suggestion.prompt)}
                    onkeydown={(event) => handleSuggestionKeydown(event, suggestion.prompt)}
                  >
                    <div class="absolute inset-0 bg-gradient-to-br from-[var(--color-accent)]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    
                    <button
                      type="button"
                      class="absolute top-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg transition-all opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-3)]"
                      style="color: var(--color-text-muted);"
                      onclick={(e) => {
                        e.stopPropagation();
                        startEditingSuggestion(suggestion);
                      }}
                      title="Edit suggestion"
                      aria-label={`Edit ${suggestion.label}`}
                    >
                      <Pencil size={14} />
                    </button>

                    <div class="relative w-full text-left">
                      <div class="w-11 h-11 rounded-xl flex items-center justify-center mb-5 bg-[var(--color-surface-3)] group-hover:scale-110 group-hover:bg-[var(--color-accent)]/10 group-hover:text-[var(--color-accent)] transition-all duration-300" style="color: var(--color-text-secondary);">
                        <Icon size={19} />
                      </div>
                      
                      <span class="text-sm font-bold mb-2 block pr-10 tracking-tight transition-colors group-hover:text-[var(--color-text-primary)]" style="color: var(--color-text-secondary);">{suggestion.label}</span>
                      
                      {#if editingSuggestionId === suggestion.id}
                        <textarea
                          bind:value={editingSuggestionText}
                          class="w-full min-h-[120px] rounded-xl border px-3 py-2 text-xs leading-relaxed focus:ring-1 focus:ring-[var(--color-accent)]/30 outline-none"
                          style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary); resize: vertical;"
                          onclick={(e) => e.stopPropagation()}
                        ></textarea>
                      {:else}
                        <span class="text-xs leading-relaxed block opacity-50 group-hover:opacity-100 transition-opacity duration-300" style="color: var(--color-text-muted);">{suggestion.prompt}</span>
                      {/if}
                    </div>

                    {#if editingSuggestionId === suggestion.id}
                      <div class="relative mt-4 flex items-center gap-2">
                        <button
                          type="button"
                          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
                          onclick={(e) => {
                            e.stopPropagation();
                            saveSuggestionEdit(suggestion.id);
                          }}
                        >
                          <Check size={12} />
                          Save
                        </button>
                        <button
                          type="button"
                          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
                          onclick={(e) => {
                            e.stopPropagation();
                            cancelEditingSuggestion();
                          }}
                        >
                          <X size={12} />
                          Cancel
                        </button>
                      </div>
                    {:else}
                      <div class="relative mt-5 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] opacity-0 group-hover:opacity-40 transition-all duration-300 translate-y-2 group-hover:translate-y-0" style="color: var(--color-text-muted);">
                        Load into composer <ArrowDown size={10} />
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div class="rounded-[24px] border p-6 flex flex-col justify-between transition-all hover:border-[var(--color-accent)]/20" style="background: var(--color-surface-2); border-color: var(--color-border);">
                <div>
                  <div class="text-[10px] font-bold uppercase tracking-[0.2em] mb-4 opacity-50" style="color: var(--color-text-muted);">Pro Tips</div>
                  <div class="space-y-4">
                    {#each [
                      'Ask for a repo walkthrough before making changes.',
                      'Review spacing and hierarchy before polish work.'
                    ] as tip}
                      <div class="flex items-start gap-3">
                        <div class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 bg-amber-500/40"></div>
                        <p class="text-xs leading-relaxed opacity-70" style="color: var(--color-text-secondary);">{tip}</p>
                      </div>
                    {/each}
                  </div>
                </div>

                <button
                  type="button"
                  class="w-full mt-6 flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-xs font-bold transition-all hover:bg-[var(--color-surface-3)] border-[var(--color-border)]"
                  style="color: var(--color-text-secondary);"
                  onclick={() => runSuggestion('Write a concrete implementation plan for the highest-priority improvement in this project.')}
                >
                  <Beaker size={14} />
                  Plan next improvement
                </button>
              </div>

              <div class="rounded-[24px] border p-6 transition-all hover:border-[var(--color-accent)]/20" style="background: var(--color-surface-2); border-color: var(--color-border);">
                 <div class="text-[10px] font-bold uppercase tracking-[0.2em] mb-4 opacity-50" style="color: var(--color-text-muted);">Workflow</div>
                 <div class="space-y-4">
                    {#each [
                      'Use composer below for direct tasks.',
                      'Open Git panel for change review.'
                    ] as tip}
                      <div class="flex items-start gap-3">
                        <div class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 bg-blue-500/40"></div>
                        <p class="text-xs leading-relaxed opacity-70" style="color: var(--color-text-secondary);">{tip}</p>
                      </div>
                    {/each}
                  </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    {:else}
      {#each filteredFeed as entry, i (entry.id)}
        <FeedEntry 
          {entry}
          isSelected={selectedEntries.has(entry.id)}
          isExpanded={expandedGroups.has(entry.id)}
          isStreaming={i === filteredFeed.length - 1 && (wsStore.managerStatus === 'streaming' || wsStore.managerStatus === 'thinking')}
          onSelect={(e) => handleEntryClick(entry, e)}
          onToggleGroup={() => toggleGroup(entry.id)}
          onDelete={() => deleteSingle(entry.id)}
        />
      {/each}
    {/if}
    </div><!-- /feedContainer -->

  {#if !autoScroll}
    <div
      transition:fade={{ duration: 150 }}
      class="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 pointer-events-none"
    >
      <button
        onclick={() => { autoScroll = true; if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight; }}
        class="pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
        style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary); box-shadow: 0 4px 16px rgba(0,0,0,0.35);"
        aria-label="Scroll to bottom"
      >
        <ArrowDown size={12} />
        <span>Jump to bottom</span>
      </button>
    </div>
  {/if}
  </div><!-- /relative wrapper -->
</div><!-- /outer -->

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
  .feed-scroll {
    overscroll-behavior: contain;
  }
  .suggestion-card:hover {
    transform: translateY(-2px);
    border-color: rgba(213, 178, 97, 0.4) !important;
    box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5), 0 0 20px rgba(213, 178, 97, 0.05);
  }
</style>
