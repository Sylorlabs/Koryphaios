<script lang="ts">
  import WorkerCard from '$lib/components/WorkerCard.svelte';
  import AgentActivity from './AgentActivity.svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { tick } from 'svelte';
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
  let selectedId = $derived(rail.selectedAgentId ?? '__main');

  $effect(() => {
    const ids = new Set(rail.sessionAgentChats.map((agent) => agent.identity.id));
    if ([...ids].some((id) => !seenAgentIds.has(id))) autoRevealed = true;
    if (ids.size === 0) autoRevealed = false;
    seenAgentIds = ids;
  });

  // Sliding selection highlight: measured from the selected segment's live
  // geometry so it follows name truncation, queue badges and scrolling.
  let stripEl = $state<HTMLDivElement | undefined>();
  let hlStyle = $state('opacity:0');

  async function syncHighlight() {
    await tick();
    if (!stripEl) return;
    const seg =
      selectedId === '__main'
        ? stripEl.querySelector<HTMLElement>('[data-seg-main]')
        : stripEl.querySelector<HTMLElement>(`[data-seg-id="${CSS.escape(selectedId)}"]`);
    if (!seg) {
      hlStyle = 'opacity:0';
      return;
    }
    const stripBox = stripEl.getBoundingClientRect();
    const segBox = seg.getBoundingClientRect();
    hlStyle = `opacity:1; transform: translateX(${segBox.left - stripBox.left + stripEl.scrollLeft}px); width: ${segBox.width}px;`;
    seg.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  $effect(() => {
    // Re-measure whenever selection or the segment set changes.
    void selectedId;
    void activeAgentChats.length;
    void stripEl;
    void syncHighlight();
  });

  function onStripKeydown(event: KeyboardEvent) {
    const tabs = stripEl
      ? [...stripEl.querySelectorAll<HTMLElement>('[role="tab"]')]
      : [];
    const idx = tabs.indexOf(document.activeElement as HTMLElement);
    if (idx < 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next =
        event.key === 'ArrowRight'
          ? tabs[(idx + 1) % tabs.length]
          : tabs[(idx - 1 + tabs.length) % tabs.length];
      next?.focus();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const segId = (document.activeElement as HTMLElement)?.dataset?.segId;
      if (!segId) return;
      event.preventDefault();
      void rail.closeAgent(segId);
    }
  }
</script>

{#if hasAgents && !forceHidden && (visible || autoRevealed || hasActiveAgents)}
  <div
    class="relative px-3 py-2 border-b shrink-0"
    style="border-color: var(--color-border); background: var(--color-surface-1);"
    aria-label="Activity"
  >
    <div class="flex min-h-7 min-w-0 items-center gap-2">
      <!-- One continuous segmented strip: Main chat + one tab per active
           agent, with the selection highlight sliding between segments. -->
      <div
        class="agent-strip"
        role="tablist"
        tabindex={-1}
        aria-label="Chats and active sub-agents"
        data-testid="active-agent-tabs"
        bind:this={stripEl}
        onkeydown={onStripKeydown}
      >
        <div class="seg-highlight" style={hlStyle} aria-hidden="true"></div>
        <button
          type="button"
          class="agent-seg main-seg"
          class:selected={!rail.selectedAgentId}
          data-seg-main
          role="tab"
          aria-selected={!rail.selectedAgentId}
          tabindex={rail.selectedAgentId ? -1 : 0}
          onclick={() => rail.clearSelection()}
          title="Return to the manager chat and review the full session"
          aria-label="Main chat"
          in:fly={{ x: -28, duration: 380, easing: cubicOut }}
        >
          <span class="seg-name">Main chat</span>
        </button>

        {#each activeAgentChats as agent, i (agent.identity.id)}
          <span class="seg-divider" aria-hidden="true"></span>
          <div
            class="contents-fly flex shrink-0 h-full"
            in:fly={{ x: -28, duration: 280, delay: i * 60, easing: cubicOut }}
            out:fly={{ x: -12, duration: 180, easing: cubicOut }}
          >
            <WorkerCard
              {agent}
              status={agent.status}
              selected={rail.selectedAgentId === agent.identity.id}
              closing={rail.closingAgentIds.has(agent.identity.id)}
              tabindex={rail.selectedAgentId === agent.identity.id ? 0 : -1}
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
  .agent-strip {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-2);
    overflow-x: auto;
    scrollbar-width: none;
    /* Soft fades at the scroll edges. */
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 14px,
      #000 calc(100% - 14px),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 14px,
      #000 calc(100% - 14px),
      transparent 100%
    );
  }
  .agent-strip::-webkit-scrollbar {
    display: none;
  }
  .seg-highlight {
    position: absolute;
    top: 1px;
    left: 0;
    height: calc(100% - 2px);
    border-radius: 7px;
    background: var(--color-surface-3);
    transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), width 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    pointer-events: none;
  }
  .agent-seg {
    position: relative;
    z-index: 1;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 5px;
    height: 100%;
    padding: 0 8px;
    color: var(--color-text-primary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  .agent-seg.selected {
    color: var(--color-accent);
  }
  .agent-seg:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: 6px;
  }
  .seg-name {
    font-weight: 600;
  }
  .seg-divider {
    width: 1px;
    height: 14px;
    flex-shrink: 0;
    background: var(--color-border);
  }
  @media (prefers-reduced-motion: reduce) {
    .seg-highlight {
      transition: none;
    }
  }
</style>
