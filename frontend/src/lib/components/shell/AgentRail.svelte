<script lang="ts">
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import AgentActivity from './AgentActivity.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { AgentRailState } from './useAgentRail.svelte';

  let {
    rail,
    visible = false,
    forceHidden = false,
  }: {
    rail: AgentRailState;
    visible?: boolean;
    /** A deliberate user hide must override automatic activity reveals. */
    forceHidden?: boolean;
  } = $props();

  let autoRevealed = $state(false);
  let seenAgentIds = new Set<string>();
  // The rail is a sub-agent surface: with no agents in this session there is
  // nothing to show, so it stays fully out of the layout instead of rendering
  // an empty shell.
  let hasAgents = $derived(rail.sessionAgentChats.length > 0);
  let hasActiveAgents = $derived(
    rail.sessionAgentChats.some((agent) => !['done', 'idle', 'error'].includes(agent.status)),
  );
  let activeAgentChats = $derived(
    rail.sessionAgentChats.filter((agent) => !['done', 'idle', 'error'].includes(agent.status)),
  );

  $effect(() => {
    const ids = new Set(rail.sessionAgentChats.map((agent) => agent.identity.id));
    if ([...ids].some((id) => !seenAgentIds.has(id))) autoRevealed = true;
    if (ids.size === 0) autoRevealed = false;
    seenAgentIds = ids;
  });
</script>

{#if hasAgents && !forceHidden && (visible || autoRevealed || hasActiveAgents)}
  <div
    class="relative px-3 py-2 border-b shrink-0"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
    aria-label="Activity"
  >
    <div class="flex min-h-7 min-w-0 items-center gap-2">
      <button
        type="button"
        class="main-chat-link shrink-0"
        onclick={() => rail.clearSelection()}
        title="Return to the manager chat and review the full session"
        aria-label="Main chat"
        in:fly={{ x: -28, duration: 380, easing: cubicOut }}
      >
        <span class="text-[11px] font-medium">Main chat</span>
      </button>

      <!-- Active workers are tabs, rather than activity-only rows. This stays
           visible even when the Activity drawer is collapsed. -->
      <div
        class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"
        aria-label="Active sub-agents"
        data-testid="active-agent-tabs"
        role="group"
      >
        {#each activeAgentChats as agent, i (agent.identity.id)}
          <div
            class="contents-fly flex shrink-0"
            in:fly={{ x: -28, duration: 280, delay: i * 60, easing: cubicOut }}
            out:fly={{ x: -12, duration: 180, easing: cubicOut }}
          >
            <WorkerCard
              {agent}
              status={agent.status}
              selected={rail.selectedAgentId === agent.identity.id}
              closing={rail.closingAgentIds.has(agent.identity.id)}
              onSelect={() => rail.selectAgent(agent.identity.id)}
              onClose={() => void rail.closeAgent(agent.identity.id)}
            />
          </div>
        {/each}
      </div>

      <AgentActivity {rail} expanded={visible} />
    </div>
  </div>
{/if}

<style>
  .main-chat-link {
    padding: 4px 0;
    color: var(--color-text-primary);
    font-size: 12px;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .main-chat-link:hover {
    color: var(--color-accent);
  }

  .main-chat-link:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
</style>
