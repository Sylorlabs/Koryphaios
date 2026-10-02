<script lang="ts">
  import WorkerCard from '$lib/components/WorkerCard.svelte';
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
  // Tiles are a single 24px row, so one row plus the container padding is the
  // natural height. The strip still wraps to more rows when many agents are
  // live, and the resize handle grows it further on demand.
  const RAIL_MIN_HEIGHT = 32;
  let railHeight = $state<number>(
    typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem('koryphaios-rail-height') ?? RAIL_MIN_HEIGHT) || RAIL_MIN_HEIGHT
      : RAIL_MIN_HEIGHT,
  );
  let dragging = $state(false);
  // The rail is a sub-agent surface: with no agents in this session there is
  // nothing to show, so it stays fully out of the layout instead of rendering
  // an empty shell.
  let hasAgents = $derived(rail.sessionAgentChats.length > 0);
  let hasActiveAgents = $derived(
    rail.sessionAgentChats.some((agent) => !['done', 'idle', 'error'].includes(agent.status)),
  );
  let activeAgentCount = $derived(
    rail.sessionAgentChats.filter((agent) => !['done', 'idle', 'error'].includes(agent.status)).length,
  );
  let activitySummary = $derived(
    activeAgentCount > 0
      ? `${activeAgentCount} ${activeAgentCount === 1 ? 'task' : 'tasks'} in progress`
      : `${rail.sessionAgentChats.length} recent ${rail.sessionAgentChats.length === 1 ? 'item' : 'items'}`,
  );

  function startRailResize(event: PointerEvent) {
    event.preventDefault();
    dragging = true;
    const startY = event.clientY;
    const startH = railHeight;
    const onMove = (e: PointerEvent) => {
      railHeight = Math.min(420, Math.max(RAIL_MIN_HEIGHT, startH + (e.clientY - startY)));
    };
    const onUp = () => {
      dragging = false;
      try { localStorage.setItem('koryphaios-rail-height', String(railHeight)); } catch { /* ignore */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

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
    <div class="flex min-h-7 items-center gap-2">
      <button
        type="button"
        class="shrink-0 inline-flex items-center rounded-lg border px-2 transition-colors"
        style="height: 28px; background: {rail.selectedAgentId
          ? 'var(--color-surface-2)'
          : 'rgba(var(--color-accent-rgb), 0.12)'}; border-color: {rail.selectedAgentId
          ? 'var(--color-border)'
          : 'rgba(var(--color-accent-rgb), 0.35)'}; color: var(--color-text-primary);"
        onclick={() => rail.clearSelection()}
        title="Return to the manager chat and review the full session"
        aria-label="Main chat"
        in:fly={{ x: -28, duration: 380, easing: cubicOut }}
      >
        <span class="text-[11px] font-medium">Main chat</span>
      </button>

      <div class="min-w-0 flex-1" role="status" aria-live="polite">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold" style="color: var(--color-text-primary);">Activity</span>
          <span
            class="rounded-full px-1.5 py-0.5 text-[10px] leading-none"
            style="background: var(--color-surface-3); color: var(--color-muted);"
          >{rail.sessionAgentChats.length}</span>
        </div>
        <span class="block truncate text-[11px]" style="color: var(--color-text-muted);">
          {activitySummary}
        </span>
      </div>

      {#if visible}
        <span class="hidden text-[11px] sm:inline" style="color: var(--color-muted);">
          Select an item to review
        </span>
      {/if}
    </div>

    {#if visible}
      <div
        class="mt-2 flex gap-1.5 flex-wrap overflow-y-auto items-start pr-2"
        style="max-height: {railHeight}px;"
        aria-label="Activity details"
      >
        {#each rail.sessionAgentChats as agent, i (agent.identity.id)}
          <div
            class="contents-fly flex shrink-0 min-w-0"
            in:fly={{ y: -28, duration: 380, delay: i * 90, easing: cubicOut }}
            out:fly={{ y: -12, duration: 200, easing: cubicOut }}
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
      <button
        type="button"
        aria-label="Resize activity details"
        title="Drag to resize activity details"
        class="absolute bottom-0 left-0 right-0 h-2 cursor-row-resize flex items-center justify-center opacity-60 hover:opacity-100"
        style="background: {dragging ? 'var(--color-accent)' : 'transparent'};"
        onpointerdown={startRailResize}
      >
        <span class="block h-1 w-16 rounded-full" style="background: var(--color-border);"></span>
      </button>
    {/if}
  </div>
{/if}
