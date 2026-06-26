<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import type { FeedEntryLocal } from '$lib/types';
  import FeedEntry from './FeedEntry.svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import { MessageSquare, ArrowDown } from 'lucide-svelte';

  interface Props {
    agent: {
      identity: AgentIdentity;
      status: AgentStatus;
    };
    feed: FeedEntryLocal[];
    isStreaming?: boolean;
  }

  let { agent, feed, isStreaming = false }: Props = $props();

  let feedContainer = $state<HTMLDivElement>();
  let autoScroll = $state(true);
  let expandedGroups = $state<Set<string>>(new Set());
  let lastFeedLength = $state(0);
  let lastUserScrollAt = $state(0);

  $effect(() => {
    const len = feed.length;
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

  function handleScroll() {
    if (!feedContainer) return;
    lastUserScrollAt = Date.now();
    const { scrollHeight, clientHeight } = feedContainer;
    const dist = scrollHeight - feedContainer.scrollTop - clientHeight;
    autoScroll = dist < 50;
  }

  onMount(() => {
    if (!feedContainer) return;
    const container = feedContainer;

    const ro = new ResizeObserver((entries) => {
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
    if (expandedGroups.has(id)) expandedGroups.delete(id);
    else expandedGroups.add(id);
    expandedGroups = new Set(expandedGroups);
  }

  function noopSelect() {}
  function noopDelete() {}

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
</script>

<div class="flex flex-col flex-1 overflow-hidden">
  <div class="panel-header flex items-center justify-between">
    <div class="flex items-center gap-3 min-w-0">
      <AnimatedStatusIcon status={agent.status} size={16} isManager={false} />
      <div class="min-w-0">
        <div class="panel-title flex items-center gap-2">
          <MessageSquare size={16} />
          <span class="truncate">{agent.identity.name}</span>
        </div>
        <div class="text-xs mt-1" style="color: var(--color-text-muted);">
          {providerLabel(agent.identity.provider)} · {agent.identity.model} · {agent.identity.domain}
        </div>
      </div>
    </div>
  </div>

  <div class="relative flex-1 min-h-0 overflow-hidden">
    <div bind:this={feedContainer} onscroll={handleScroll} class="absolute inset-0 overflow-y-auto p-4 space-y-3 feed-scroll">
    {#if feed.length === 0}
      <div class="flex h-full items-center justify-center">
        <div class="max-w-lg rounded-[20px] border px-6 py-8 text-center" style="background: var(--color-surface-2); border-color: var(--color-border);">
          <div class="text-lg font-semibold mb-2" style="color: var(--color-text-primary);">
            {agent.identity.name} thread
          </div>
          <p class="text-sm leading-relaxed" style="color: var(--color-text-secondary);">
            Messages sent by the manager and anything you type here will appear in this transcript once the agent is used.
          </p>
        </div>
      </div>
    {:else}
      {#each feed as entry, i (entry.id)}
        <FeedEntry
          {entry}
          isSelected={false}
          isExpanded={expandedGroups.has(entry.id)}
          isStreaming={i === feed.length - 1 && isStreaming}
          onSelect={noopSelect}
          onToggleGroup={() => toggleGroup(entry.id)}
          onDelete={noopDelete}
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
