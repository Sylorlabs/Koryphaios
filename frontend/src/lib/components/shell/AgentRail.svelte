<script lang="ts">
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { AgentRailState } from './useAgentRail.svelte';

  let {
    rail,
    visible = false,
  }: {
    rail: AgentRailState;
    visible?: boolean;
  } = $props();

  let autoRevealed = $state(false);
  let seenAgentIds = new Set<string>();
  let hasActiveAgents = $derived(
    rail.sessionAgentChats.some((agent) => !['done', 'idle', 'error'].includes(agent.status)),
  );

  $effect(() => {
    const ids = new Set(rail.sessionAgentChats.map((agent) => agent.identity.id));
    if ([...ids].some((id) => !seenAgentIds.has(id))) autoRevealed = true;
    if (ids.size === 0) autoRevealed = false;
    seenAgentIds = ids;
  });
</script>

{#if (visible || autoRevealed || hasActiveAgents) && rail.sessionAgentChats.length > 0}
  <div
    class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0 items-stretch"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <button
      type="button"
      class="shrink-0 rounded-xl border px-4 py-2 text-left transition-colors"
      style="min-width: 160px; background: {rail.selectedAgentId
        ? 'var(--color-surface-2)'
        : 'rgba(213, 178, 97, 0.12)'}; border-color: {rail.selectedAgentId
        ? 'var(--color-border)'
        : 'rgba(213, 178, 97, 0.35)'}; color: var(--color-text-primary);"
      onclick={() => rail.clearSelection()}
      in:fly={{ x: -28, duration: 380, easing: cubicOut }}
    >
      <div
        class="text-xs font-semibold uppercase tracking-[0.14em]"
        style="color: var(--color-text-muted);"
      >
        Main chat
      </div>
      <div class="mt-2 text-sm font-semibold">Manager feed</div>
      <div class="mt-1 text-xs" style="color: var(--color-text-secondary);">
        Talk to Kory and review the full session.
      </div>
    </button>
    {#each rail.sessionAgentChats as agent, i (agent.identity.id)}
      <div
        class="contents-fly flex shrink-0"
        in:fly={{ y: -28, duration: 380, delay: i * 90, easing: cubicOut }}
      >
        <WorkerCard
          {agent}
          selected={rail.selectedAgentId === agent.identity.id}
          onSelect={() => rail.selectAgent(agent.identity.id)}
        />
      </div>
    {/each}
  </div>
{:else if visible && modeStore.showAgentDetails}
  <div
    class="px-4 py-2 border-b flex items-center justify-center shrink-0"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <span class="text-xs opacity-40" style="color: var(--color-text-muted);">
      No worker or critic chats yet
    </span>
  </div>
{/if}
