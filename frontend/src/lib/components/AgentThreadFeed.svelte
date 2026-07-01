<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import type { FeedEntryLocal } from '$lib/types';
  import FeedEntry from './FeedEntry.svelte';
  import VirtualList from './VirtualList.svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import { MessageSquare, ArrowDown } from 'lucide-svelte';
  import { createAutoScroll } from '$lib/utils/autoscroll.svelte';

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
  let virtualList = $state<VirtualList<FeedEntryLocal>>();
  let expandedGroups = $state<Set<string>>(new Set());

  // -- Autoscroll ----------------------------------------------------------
  let scrollEl = $derived<HTMLDivElement | undefined>(
    feed.length === 0 ? feedContainer : virtualList?.getScrollElement(),
  );
  const autoScrollCtl = createAutoScroll(() => scrollEl, { threshold: 100 });

  // Re-pin when feed grows OR the last entry's text grows (per-token
  // streaming).
  let streamingTextSig = $derived.by(() => {
    const last = feed[feed.length - 1];
    return last?.text?.length ?? 0;
  });
  $effect(() => {
    void feed.length;
    void streamingTextSig;
    autoScrollCtl.requestPin();
  });

  function estimateFeedHeight(entry: FeedEntryLocal): number {
    switch (entry.type) {
      case 'user_message':
        return 60;
      case 'content':
        return 120;
      case 'tool_call':
      case 'tool_result':
      case 'tool_group':
        return 80;
      default:
        return 100;
    }
  }

  function scrollFeedToBottom(behavior: ScrollBehavior = 'instant') {
    autoScrollCtl.jumpToBottom(behavior === 'smooth' ? 'smooth' : 'instant');
  }

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
    {#if feed.length === 0}
    <div bind:this={feedContainer} class="absolute inset-0 overflow-y-auto p-4 feed-scroll">
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
    </div>
    {:else}
      <div class="absolute inset-0">
        <VirtualList
          bind:this={virtualList}
          items={feed}
          estimateHeight={estimateFeedHeight}
          class="h-full p-4 feed-scroll"
        >
          {#snippet row(entry, i)}
            <div class="pb-3">
              <FeedEntry
                {entry}
                isSelected={false}
                isExpanded={expandedGroups.has(entry.id)}
                isStreaming={i === feed.length - 1 && isStreaming}
                onSelect={noopSelect}
                onToggleGroup={() => toggleGroup(entry.id)}
                onDelete={noopDelete}
              />
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}

  {#if !autoScrollCtl.follow}
    <div
      transition:fade={{ duration: 150 }}
      class="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 pointer-events-none"
    >
      <button
        onclick={() => autoScrollCtl.jumpToBottom('smooth')}
        class="pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
        style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary); box-shadow: 0 4px 16px rgba(0,0,0,0.35);"
        aria-label="Scroll to bottom"
      >
        <ArrowDown size={12} />
        <span>
          {#if autoScrollCtl.unseenCount > 0}
            {autoScrollCtl.unseenCount} new {autoScrollCtl.unseenCount === 1 ? 'message' : 'messages'}
          {:else}
            Jump to bottom
          {/if}
        </span>
      </button>
    </div>
  {/if}
  </div><!-- /relative wrapper -->
</div><!-- /outer -->
