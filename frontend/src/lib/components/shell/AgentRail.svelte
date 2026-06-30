<script lang="ts">
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import type { AgentRailState } from './useAgentRail.svelte';

  let {
    rail,
    visible = false,
  }: {
    rail: AgentRailState;
    visible?: boolean;
  } = $props();
</script>

{#if visible && modeStore.showAgentDetails && rail.sessionAgentChats.length > 0}
  <div
    class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0 items-stretch"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <button
      type="button"
      class="shrink-0 rounded-xl border px-4 py-2 text-left transition-colors"
      style="min-width: 160px; background: {rail.selectedAgentId ? 'var(--color-surface-2)' : 'rgba(213, 178, 97, 0.12)'}; border-color: {rail.selectedAgentId ? 'var(--color-border)' : 'rgba(213, 178, 97, 0.35)'}; color: var(--color-text-primary);"
      onclick={() => rail.clearSelection()}
    >
      <div class="text-xs font-semibold uppercase tracking-[0.14em]" style="color: var(--color-text-muted);">
        Main chat
      </div>
      <div class="mt-2 text-sm font-semibold">Manager feed</div>
      <div class="mt-1 text-xs" style="color: var(--color-text-secondary);">
        Talk to Kory and review the full session.
      </div>
    </button>
    {#each rail.sessionAgentChats as agent (agent.identity.id)}
      <WorkerCard
        {agent}
        selected={rail.selectedAgentId === agent.identity.id}
        onSelect={() => rail.selectAgent(agent.identity.id)}
      />
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