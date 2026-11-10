<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { AgentIdentity, AgentStatus, AgentSteeringCommand } from '@koryphaios/shared';
  import type { FeedEntryLocal } from '$lib/types';
  import FeedEntry from './FeedEntry.svelte';
  import VirtualList from './VirtualList.svelte';
  import ChatLoading from './ChatLoading.svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import ArrowDown from 'lucide-svelte/icons/arrow-down';
  import Send from 'lucide-svelte/icons/send';
  import { untrack } from 'svelte';
  import { createAutoScroll } from '$lib/utils/autoscroll.svelte';
  import { estimateFeedHeight as estimateRowHeight } from '$lib/utils/estimate-row-height';
  import { feedStore } from '$lib/stores/feed.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { agentStore } from '$lib/stores/agents.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import KorySelect, { type KorySelectOption } from './KorySelect.svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  import BrainIcon from './icons/BrainIcon.svelte';
  import Settings2 from 'lucide-svelte/icons/settings-2';
  import Scissors from 'lucide-svelte/icons/scissors';
  import X from 'lucide-svelte/icons/x';
  import { apiUrl } from '$lib/utils/api-url';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';

  interface Props {
    agent: {
      identity: AgentIdentity;
      status: AgentStatus;
      sessionId: string;
      reasoningLevel?: string;
    };
    feed: FeedEntryLocal[];
    isStreaming?: boolean;
    onClose?: () => void;
  }

  let { agent, feed, isStreaming = false, onClose }: Props = $props();
  let controlsOpen = $state(false);
  let controlsBusy = $state(false);
  let pruneBusy = $state(false);
  let queue = $derived(agentStore.getAgentSteeringQueue(agent.sessionId, agent.identity.id));
  let expandedSteering = $state<string | null>(null);
  let editingSteering = $state<string | null>(null);
  let editingText = $state('');
  let steeringLoadedKey = $state('');

  $effect(() => {
    const sessionId = agent.sessionId;
    const agentId = agent.identity.id;
    const key = `${sessionId}:${agentId}`;
    if (!sessionId || !agentId || steeringLoadedKey === key) return;
    steeringLoadedKey = key;
    void agentStore.loadAgentSteeringQueue(sessionId, agentId).catch((error) => {
      if (import.meta.env.DEV) console.warn('Failed to load steering queue', error);
    });
  });

  let modelOptions = $derived.by(() => {
    const values = providersStore.statusList
      .filter((provider) => provider.enabled && (provider.adapterAvailable ?? provider.authenticated))
      .flatMap((provider) => {
        const models = provider.selectedModels?.length ? provider.selectedModels : provider.models;
        return models.map((model) => ({
          value: `${provider.name}:${model}`,
          label: `${provider.label ?? provider.name} · ${model}`,
          provider: provider.name,
        }));
      });
    const current = `${agent.identity.provider}:${agent.identity.model}`;
    if (!values.some((option) => option.value === current)) {
      values.unshift({ value: current, label: current, provider: agent.identity.provider });
    }
    return values;
  });

  let currentModel = $derived(`${agent.identity.provider}:${agent.identity.model}`);
  let modelDefinition = $derived.by(() => {
    const provider = providersStore.statusList.find((item) => item.name === agent.identity.provider);
    return provider?.allAvailableModels?.find(
      (model) => model.id === agent.identity.model || model.apiModelId === agent.identity.model,
    );
  });
  let reasoningOptions = $derived<KorySelectOption[]>(
    (modelDefinition?.reasoningLevels ?? []).map((level) => ({
      value: level,
      label: level.charAt(0).toUpperCase() + level.slice(1),
    })),
  );

  let feedContainer = $state<HTMLDivElement>();
  let virtualList = $state<VirtualList<FeedEntryLocal>>();
  let expandedGroups = $state<Set<string>>(new Set());

  // -- Autoscroll ----------------------------------------------------------
  let scrollEl = $derived<HTMLDivElement | undefined>(
    feed.length === 0 ? feedContainer : virtualList?.getScrollElement(),
  );
  const autoScrollCtl = createAutoScroll(() => scrollEl, { threshold: 100 });

  // Attach the scroll/observer listeners whenever the container element
  // changes (e.g. empty-state ↔ VirtualList).
  $effect(() => {
    void scrollEl;
    untrack(() => autoScrollCtl.attach());
  });

  // The scroll state belongs to one (session, thread) pair, not to the feed
  // component. Reset following whenever the reader opens a different one so
  // its first paint is bottom-anchored rather than inheriting a parked
  // position from the chat they just left.
  let threadViewKey = $derived(`${agent.sessionId}:${agent.identity.id}`);
  let landedThreadKey = $state('');
  $effect(() => {
    const key = threadViewKey;
    if (!key) return;
    void key;
    untrack(() => {
      landedThreadKey = '';
      autoScrollCtl.setFollow(true);
    });
  });

  // Hold an opaque surface over the mounted transcript until its opening
  // layout has stopped measuring. No visible scroll into place on reopen.
  let showLoadingSurface = $derived(
    wsStore.isLoadingSession || (feed.length > 0 && landedThreadKey !== threadViewKey),
  );

  function handleTranscriptLanded() {
    landedThreadKey = untrack(() => threadViewKey);
  }

  // Per-token streaming signal: tracks the text length of the last
  // (streaming) entry so we can keep the view pinned during fast
  // streaming.
  let streamingTextSig = $derived.by(() => {
    const last = feed[feed.length - 1];
    return last?.text?.length ?? 0;
  });

  // Pin on per-token text growth (no counter increment).
  $effect(() => {
    void streamingTextSig;
    autoScrollCtl.requestPin();
  });

  // Bump the "N new messages" counter only when a *new entry* is added
  // to the feed (not on per-token updates of an existing entry).
  $effect(() => {
    void feed.length;
    autoScrollCtl.notifyNewEntry();
  });

  // Opening a thread (or swapping the container, e.g. empty-state →
  // VirtualList) is positioned by the list itself: it lands on the newest
  // entry, or restores a reader who had deliberately scrolled up, and reports
  // which of those happened. Forcing a jump here would undo that restore and
  // animate the view back down after a reopened thread had already painted.

  function estimateFeedHeight(entry: FeedEntryLocal): number {
    return estimateRowHeight(entry);
  }

  function toggleGroup(id: string) {
    if (expandedGroups.has(id)) expandedGroups.delete(id);
    else expandedGroups.add(id);
    expandedGroups = new Set(expandedGroups);
  }

  function noopSelect() {}

  async function deleteThreadEntry(entry: FeedEntryLocal, messageId?: string) {
    try {
      await feedStore.deleteEntry(entry, messageId);
      const sessionId = sessionStore.activeSessionId;
      if (sessionId) agentStore.applySessionFeedVisibility(sessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Feed entry deletion failed.';
      toastStore.error(detail);
    }
  }

  function refreshThreadVisibility() {
    const sessionId = sessionStore.activeSessionId;
    if (sessionId) agentStore.applySessionFeedVisibility(sessionId);
  }

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex CLI';
    if (provider === 'codex-auth') return 'OpenAI Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'aistudio') return 'Google AI Studio';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'unorouter') return 'UnoRouter';
    if (provider === 'tokenharbor') return 'Token Harbor';
    if (provider === 'logfare') return 'Logfare';
    if (provider === 'apinex') return 'APInex';
    if (provider === 'gwarden') return 'Gwarden AI';
    if (provider === 'respan') return 'Respan';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'opencode') return 'OpenCode';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  async function updateControls(patch: { model?: string; reasoningLevel?: string }) {
    if (!agent.identity.id || !agent.sessionId || controlsBusy || isStreaming) return;
    controlsBusy = true;
    try {
      const response = await apiFetch(apiUrl(`/api/agent/${encodeURIComponent(agent.identity.id)}/controls`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.sessionId, ...patch }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || data.ok === false) throw new Error(data.error ?? 'Worker controls could not be updated.');
      toastStore.success('Worker controls updated for the next turn.');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Worker controls could not be updated.');
    } finally {
      controlsBusy = false;
    }
  }

  async function pruneWorkerContext() {
    if (!agent.identity.id || !agent.sessionId || pruneBusy || isStreaming) return;
    pruneBusy = true;
    try {
      const response = await apiFetch(apiUrl(`/api/agent/${encodeURIComponent(agent.identity.id)}/prune-context`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.sessionId, keepRecent: 12 }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string; data?: { removed?: number } }>(response);
      if (!response.ok || data.ok === false) throw new Error(data.error ?? 'Worker context could not be pruned.');
      toastStore.success(data.data?.removed ? `Pruned ${data.data.removed} older worker messages.` : 'Worker context is already compact.');
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : 'Worker context could not be pruned.');
    } finally {
      pruneBusy = false;
    }
  }

  async function queueRequest(path: string, init: RequestInit) {
    const response = await apiFetch(apiUrl(path), init);
    const data = await parseJsonResponse<{ ok?: boolean; data?: AgentSteeringCommand[]; error?: string }>(response);
    if (!response.ok || data.ok === false) throw new Error(data.error ?? 'Steering queue update failed.');
    if (data.data) agentStore.setAgentSteeringQueue(agent.sessionId, agent.identity.id, data.data);
  }

  async function editSteering(id: string) {
    const content = editingText.trim();
    if (!content) return;
    try {
      await queueRequest(`/api/agent/${encodeURIComponent(agent.identity.id)}/steering/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.sessionId, content }),
      });
      editingSteering = null;
    } catch (error) { toastStore.error(error instanceof Error ? error.message : 'Steering update failed.'); }
  }

  async function deleteSteering(id: string) {
    try {
      await queueRequest(`/api/agent/${encodeURIComponent(agent.identity.id)}/steering/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(agent.sessionId)}`, { method: 'DELETE' });
    } catch (error) { toastStore.error(error instanceof Error ? error.message : 'Steering deletion failed.'); }
  }

  async function moveSteering(id: string, direction: -1 | 1) {
    const index = queue.findIndex((item) => item.id === id);
    const target = queue[index + direction];
    if (!target || target.status !== 'queued') return;
    try {
      await queueRequest(`/api/agent/${encodeURIComponent(agent.identity.id)}/steering/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.sessionId, commandId: id, beforeId: direction < 0 ? target.id : queue[index + 2]?.id ?? null }),
      });
    } catch (error) { toastStore.error(error instanceof Error ? error.message : 'Steering reorder failed.'); }
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
    <div class="ml-4 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5" style="border-color: var(--color-border); background: var(--color-surface-2);">
      <AnimatedStatusIcon status={agent.status} size={12} isManager={false} />
      <span class="text-[10px] font-bold uppercase tracking-wider" style="color: {agent.status === 'error' ? 'var(--color-error)' : agent.status === 'done' ? 'var(--color-success)' : 'var(--color-accent)'};">{agent.status.replace('_', ' ')}</span>
      <span class="h-3 w-px" style="background: var(--color-border);"></span>
      <Send size={11} style="color: var(--color-accent);" />
      <span class="text-[10px]" style="color: var(--color-text-secondary);">Composer steers this agent directly</span>
    </div>
  </div>

  <div class="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2" style="border-color: var(--color-border); background: var(--color-surface-1);">
    <div class="flex items-center gap-2 text-[10px]" style="color: var(--color-text-muted);">
      <Settings2 size={13} />
      <span>Worker controls</span>
      {#if isStreaming}<span>Stop the worker before changing controls.</span>{/if}
    </div>
    <div class="flex items-center gap-1.5">
      {#if controlsOpen}
        <div class="flex min-w-[220px] items-center gap-1.5">
          <KorySelect
            compact
            dense
            searchable
            label="Worker model"
            value={currentModel}
            options={modelOptions}
            disabled={controlsBusy || isStreaming}
            onchange={(value) => updateControls({ model: value })}
          >
            {#snippet leading(option)}
              {#if option?.provider}<ProviderIcon provider={option.provider} size={15} />{/if}
            {/snippet}
          </KorySelect>
          {#if reasoningOptions.length > 0}
            <KorySelect
              compact
              dense
              label="Reasoning"
              value={agent.reasoningLevel ?? ''}
              options={reasoningOptions}
              disabled={controlsBusy || isStreaming}
              placeholder="Reasoning"
              onchange={(value) => updateControls({ reasoningLevel: value })}
            >
              {#snippet leading()}
                <BrainIcon reasoningLevel={agent.reasoningLevel ?? ''} size={15} />
              {/snippet}
            </KorySelect>
          {/if}
        </div>
      {/if}
      <button type="button" class="worker-control-button" disabled={controlsBusy || isStreaming} onclick={() => void pruneWorkerContext()} title="Prune older worker context">
        <Scissors size={13} /> Prune context
      </button>
      <button type="button" class="worker-control-button" aria-pressed={controlsOpen} onclick={() => (controlsOpen = !controlsOpen)} title="Change worker model or reasoning level">
        <Settings2 size={13} /> Controls
      </button>
      {#if onClose}
        <button type="button" class="worker-control-button danger" onclick={() => onClose?.()} title="Stop and close worker">
          <X size={13} /> Close worker
        </button>
      {/if}
    </div>
  </div>

  {#if queue.length > 0}
    <section class="steering-queue" aria-label="Queued steering">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <Send size={13} style="color: var(--color-accent);" />
          <strong>Steering queue</strong>
          <span class="queue-count">{queue.filter((item) => item.status === 'queued').length} queued</span>
        </div>
        <span class="queue-hint">Messages sent while working wait here</span>
      </div>
      <div class="queue-stack">
        {#each queue as item, index (item.id)}
          <article class:expanded={expandedSteering === item.id} class="queue-item" tabindex="0" onclick={() => (expandedSteering = expandedSteering === item.id ? null : item.id)} onkeydown={(event) => event.key === 'Enter' && (expandedSteering = expandedSteering === item.id ? null : item.id)}>
            <div class="queue-item-main">
              <span class="queue-index">{index + 1}</span>
              <div class="min-w-0 flex-1">
                {#if editingSteering === item.id}
                  <textarea class="queue-editor" bind:value={editingText} onclick={(event) => event.stopPropagation()}></textarea>
                  <div class="queue-actions" onclick={(event) => event.stopPropagation()}>
                    <button type="button" onclick={() => void editSteering(item.id)}>Save</button>
                    <button type="button" onclick={() => (editingSteering = null)}>Cancel</button>
                  </div>
                {:else}
                  <div class="queue-preview">{item.content}</div>
                  <div class="queue-meta">{item.status} · {new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                {/if}
              </div>
              {#if item.status === 'queued'}
                <div class="queue-actions" onclick={(event) => event.stopPropagation()}>
                  <button type="button" aria-label="Move steering up" onclick={() => void moveSteering(item.id, -1)} disabled={index === 0}>↑</button>
                  <button type="button" aria-label="Move steering down" onclick={() => void moveSteering(item.id, 1)} disabled={index === queue.length - 1}>↓</button>
                  <button type="button" aria-label="Edit steering" onclick={() => { editingSteering = item.id; editingText = item.content; }}>Edit</button>
                  <button type="button" aria-label="Delete steering" onclick={() => void deleteSteering(item.id)}>×</button>
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <div class="relative flex-1 min-h-0 overflow-hidden">
    {#if wsStore.isLoadingSession}
      <ChatLoading />
    {:else if feed.length === 0}
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
          follow={autoScrollCtl.follow}
          resetKey={threadViewKey}
          onLanded={handleTranscriptLanded}
          onRestoreState={(state) => autoScrollCtl.setFollow(state.follow)}
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
                onDelete={(_event, target) => deleteThreadEntry(entry, target?.messageId)}
                onUserVisibilityChanged={refreshThreadVisibility}
              />
            </div>
          {/snippet}
        </VirtualList>
      </div>
    {/if}

    {#if !wsStore.isLoadingSession && showLoadingSurface && feed.length > 0}
      <ChatLoading cover />
    {/if}

  {#if !showLoadingSurface && !autoScrollCtl.follow}
    <div
      transition:fade={{ duration: 150 }}
      class="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 pointer-events-none"
    >
      <button
        onclick={() => autoScrollCtl.jumpToBottom('instant')}
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

<style>
  .worker-control-button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 4px 7px;
    color: var(--color-text-secondary);
    font-size: 10px;
  }
  .worker-control-button:hover { background: var(--color-surface-2); color: var(--color-text-primary); }
  .worker-control-button:disabled { cursor: default; opacity: 0.45; }
  .worker-control-button.danger:hover { color: var(--color-error); }
  .steering-queue { padding: 10px 16px; border-bottom: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-accent) 5%, var(--color-surface-1)); }
  .queue-count, .queue-hint, .queue-meta { color: var(--color-text-muted); font-size: 10px; }
  .queue-hint { opacity: .8; }
  .queue-stack { display: flex; gap: 6px; margin-top: 8px; overflow: visible; }
  .queue-item { min-width: 132px; max-width: 220px; flex: 1; border: 1px solid var(--color-border); border-radius: 10px; padding: 7px; background: var(--color-surface-2); transition: transform 160ms ease, box-shadow 160ms ease, max-width 180ms ease; box-shadow: 0 3px 10px rgba(0,0,0,.16); }
  .queue-item:hover, .queue-item:focus-visible, .queue-item.expanded { transform: translateY(-2px); max-width: 360px; box-shadow: 0 8px 24px rgba(0,0,0,.25); outline: none; }
  .queue-item-main { display: flex; align-items: flex-start; gap: 7px; }
  .queue-index { display: grid; place-items: center; width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%; background: var(--color-accent); color: var(--color-surface-0); font-size: 10px; font-weight: 700; }
  .queue-preview { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--color-text-primary); font-size: 11px; line-height: 1.35; }
  .queue-item:hover .queue-preview, .queue-item:focus-visible .queue-preview, .queue-item.expanded .queue-preview { -webkit-line-clamp: 8; }
  .queue-actions { display: flex; gap: 3px; margin-top: 5px; }
  .queue-actions button { border: 1px solid var(--color-border); border-radius: 5px; padding: 2px 5px; color: var(--color-text-secondary); font-size: 10px; }
  .queue-actions button:hover:not(:disabled) { color: var(--color-text-primary); background: var(--color-surface-3); }
  .queue-actions button:disabled { opacity: .35; }
  .queue-editor { width: 100%; min-height: 60px; resize: vertical; border: 1px solid var(--color-accent); border-radius: 6px; padding: 5px; background: var(--color-surface-1); color: var(--color-text-primary); font-size: 11px; }
</style>
