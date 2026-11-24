<script lang="ts">
  import AnimatedStatusIcon from '$lib/components/AnimatedStatusIcon.svelte';
  import X from 'lucide-svelte/icons/x';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import type { AgentRailState } from './useAgentRail.svelte';
  import { TERMINAL_AGENT_STATUSES } from '$lib/stores/run-state-core';
  import { agentStore } from '$lib/stores/agents.svelte';
  import {
    AGENT_GROUP_ORDER,
    agentElapsedMs,
    agentStatusInfo,
    buildLineage,
    describeToolActivity,
    flattenLineage,
    formatElapsed,
    providerLabel,
    resultSummary,
    type AgentStatusGroup,
    type LineageNode,
  } from '$lib/utils/agent-presentation';

  let { rail, expanded = false }: { rail: AgentRailState; expanded?: boolean } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let preview = $state(false);
  let pinned = $state(false);
  let open = $derived(preview || pinned);
  /** Rows whose task/result detail the user opened, by agent id. */
  let openRows = $state<Set<string>>(new Set());
  /** Finished roots beyond this many fold behind one disclosure. */
  const FINISHED_VISIBLE = 3;
  let showAllFinished = $state(false);

  // Keep the existing View / Activity command usable as well as this trigger.
  $effect(() => { pinned = expanded; });

  type RailAgent = AgentRailState['sessionAgentChats'][number] & {
    startedAt?: number;
    endedAt?: number;
    parentAgentId?: string;
    stopReason?: 'cancelled';
  };

  const agents = $derived(rail.sessionAgentChats as RailAgent[]);
  const info = (agent: RailAgent) => agentStatusInfo(agent.status, { stopReason: agent.stopReason });

  const counts = $derived.by(() => {
    const result: Record<AgentStatusGroup, number> = { running: 0, waiting: 0, failed: 0, finished: 0 };
    let needsYou = 0;
    for (const agent of agents) {
      result[info(agent).group]++;
      if (agent.status === 'waiting_user') needsYou++;
    }
    return { ...result, needsYou };
  });

  /** "3 running · 1 needs you · 1 failed" — the trigger's at-a-glance summary. */
  const summary = $derived(
    [
      counts.running ? `${counts.running} running` : '',
      counts.needsYou ? `${counts.needsYou} needs you` : '',
      counts.waiting - counts.needsYou > 0 ? `${counts.waiting - counts.needsYou} waiting` : '',
      counts.failed ? `${counts.failed} failed` : '',
    ].filter(Boolean),
  );

  // Lineage: parent → children, roots ordered by what needs the user first.
  // Children stay under their parent whatever their own status.
  const trees = $derived.by(() => {
    const rank = (agent: RailAgent) => AGENT_GROUP_ORDER.indexOf(info(agent).group);
    return buildLineage(agents).sort((a, b) => rank(a.agent) - rank(b.agent));
  });
  const finishedRoots = $derived(trees.filter((node) => info(node.agent).group === 'finished'));
  const hiddenFinished = $derived(
    showAllFinished ? 0 : Math.max(0, finishedRoots.length - FINISHED_VISIBLE),
  );
  const visibleRows = $derived.by(() => {
    const keep = new Set(finishedRoots.slice(0, finishedRoots.length - hiddenFinished));
    const shown = trees.filter((node) => info(node.agent).group !== 'finished' || keep.has(node));
    return flattenLineage(shown);
  });
  const hasNested = $derived(visibleRows.some((row) => row.depth > 0));

  // One clock for every live duration, ticking only while the panel is open
  // and something is still running.
  let now = $state(Date.now());
  $effect(() => {
    if (!open || !agents.some((agent) => !TERMINAL_AGENT_STATUSES.has(agent.status))) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function elapsed(agent: RailAgent): string {
    return formatElapsed(agentElapsedMs(agent, now));
  }

  function activityLine(agent: RailAgent): string {
    const status = info(agent);
    if (status.live) {
      const tool = describeToolActivity(agentStore.getAgentCurrentTool(agent.sessionId, agent.identity.id));
      return tool ? `${status.label}: ${tool}` : status.label;
    }
    return status.label;
  }

  function closeLabel(agent: RailAgent): string {
    return `${TERMINAL_AGENT_STATUSES.has(agent.status) ? 'Close' : 'Stop and close'} ${agent.identity.name}`;
  }

  function toggleRow(agentId: string) {
    const next = new Set(openRows);
    if (next.has(agentId)) next.delete(agentId);
    else next.add(agentId);
    openRows = next;
  }

  function dismiss() {
    preview = false;
    pinned = false;
  }

  function selectAgent(agentId: string) {
    rail.selectAgent(agentId);
    dismiss();
    trigger.focus();
  }

  async function clearAll() {
    await rail.closeAllAgents();
    dismiss();
    trigger.focus();
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && !root?.contains(event.target as Node)) dismiss();
  }}
  onkeydown={(event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      trigger.focus();
    }
  }}
/>

{#snippet closeButton(agent: RailAgent)}
  <button
    type="button"
    class="close-agent"
    aria-label={closeLabel(agent)}
    title={closeLabel(agent)}
    disabled={rail.closingAgentIds.has(agent.identity.id)}
    onclick={() => void rail.closeAgent(agent.identity.id)}
  ><X size={12} /></button>
{/snippet}

{#snippet detailRow(node: LineageNode<RailAgent>)}
  {@const agent = node.agent}
  {@const status = info(agent)}
  {@const rowOpen = openRows.has(agent.identity.id)}
  {@const summaryText = status.live ? '' : resultSummary(agent.content)}
  <li
    class="row"
    data-agent-id={agent.identity.id}
    data-group={status.group}
    data-tone={status.tone}
    data-depth={node.depth}
    style:--depth={node.depth}
  >
    <div class="row-main">
      <button
        type="button"
        class="disclosure-btn"
        aria-expanded={rowOpen}
        aria-controls={`${id}-row-${agent.identity.id}`}
        aria-label={`${rowOpen ? 'Hide' : 'Show'} details for ${agent.identity.name}`}
        onclick={() => toggleRow(agent.identity.id)}
      ><ChevronRight size={12} class={`chev ${rowOpen ? 'open' : ''}`} /></button>
      <button
        class="agent-info"
        type="button"
        onclick={() => selectAgent(agent.identity.id)}
        aria-label={`Open ${agent.identity.name} chat`}
      >
        <span class="line">
          <AnimatedStatusIcon status={agent.status} size={13} isStatic={!status.live} />
          <span class="agent-name">{agent.identity.name}</span>
          <span class="elapsed tabular-nums">{elapsed(agent)}</span>
        </span>
        <span class="line sub">
          <span class="status-text" data-tone={status.tone}>{activityLine(agent)}</span>
        </span>
        <span class="metadata">{providerLabel(agent.identity.provider)} · {agent.identity.model}</span>
        {#if agent.task && !rowOpen}<span class="task">{agent.task}</span>{/if}
        {#if summaryText && !rowOpen}<span class="result">{summaryText}</span>{/if}
      </button>
      {@render closeButton(agent)}
    </div>
    {#if rowOpen}
      <dl class="row-detail" id={`${id}-row-${agent.identity.id}`}>
        <div><dt>Task</dt><dd>{agent.task || 'No task was recorded.'}</dd></div>
        {#if !status.live}
          <div><dt>Result</dt><dd>{resultSummary(agent.content, 600) || (status.group === 'failed' ? 'The agent stopped with an error before reporting a result.' : 'No result text was reported.')}</dd></div>
        {/if}
        {#if node.children.length}
          <div><dt>Spawned</dt><dd>{node.children.length} {node.children.length === 1 ? 'agent' : 'agents'}</dd></div>
        {/if}
      </dl>
    {/if}
  </li>
{/snippet}

<div
  bind:this={root}
  class="activity-anchor"
  role="group"
  aria-label="Agent activity"
  onpointerenter={() => (preview = true)}
  onpointerleave={() => (preview = false)}
  onfocusout={(event) => {
    if (!root.contains(event.relatedTarget as Node | null)) dismiss();
  }}
>
  <button
    bind:this={trigger}
    type="button"
    class="activity-trigger"
    aria-expanded={open}
    aria-controls={`${id}-activity`}
    aria-label={summary.length ? `Activity, ${summary.join(', ')}` : 'Activity'}
    onclick={() => {
      preview = false;
      pinned = !pinned;
    }}
  >
    <span class="trigger-label">Activity</span>
    {#if counts.needsYou || counts.failed}
      <!-- Words, not a coloured dot: the one thing in the strip that asks for
           the user should say so. -->
      <span class="trigger-flag" data-tone={counts.needsYou ? 'attention' : 'error'} aria-hidden="true">
        {counts.needsYou ? `${counts.needsYou} needs you` : `${counts.failed} failed`}
      </span>
    {:else if counts.running}
      <span class="trigger-count tabular-nums" aria-hidden="true">{counts.running}</span>
    {/if}
  </button>

  {#if open}
    <div class="activity-popover" id={`${id}-activity`}>
      <section class="activity-panel" aria-label={pinned ? 'Activity details' : 'Activity preview'}>
        <header>
          <div class="heading">
            <strong>Activity</strong>
            {#if summary.length}<span class="heading-summary">{summary.join(' · ')}</span>{/if}
          </div>
          <div class="header-actions">
            {#if agents.length}
              <button
                type="button"
                class="clear-all"
                title={counts.running + counts.waiting > 0 ? 'Stops running agents and closes every card' : 'Closes every card'}
                onclick={() => void clearAll()}
              >
                Clear all
              </button>
            {/if}
            {#if pinned}
            <button type="button" class="icon-btn" aria-label="Close activity" onclick={() => { dismiss(); trigger.focus(); }}>
              <X size={14} />
            </button>
            {/if}
          </div>
        </header>
        {#if agents.length === 0}
          <p class="empty">No agents in this chat yet. Kory starts them when a task is worth splitting.</p>
        {:else if pinned}
          {#if hasNested}<p class="lineage-caption">Delegated by Kory; indented agents were started by the agent above them.</p>{/if}
          <ul class="tree" aria-label="Agents">
            {#each visibleRows as node (node.agent.identity.id)}
              {@render detailRow(node)}
            {/each}
          </ul>
          {#if finishedRoots.length > FINISHED_VISIBLE}
            <button
              type="button"
              class="more"
              aria-expanded={showAllFinished}
              onclick={() => (showAllFinished = !showAllFinished)}
            >
              {showAllFinished ? 'Show fewer finished agents' : `Show ${hiddenFinished} more finished ${hiddenFinished === 1 ? 'agent' : 'agents'}`}
            </button>
          {/if}
        {:else}
          <ul class="tree compact" aria-label="Agents">
            {#each flattenLineage(trees) as node (node.agent.identity.id)}
              {@const agent = node.agent}
              {@const status = info(agent)}
              <li class="row preview-item" data-tone={status.tone} data-depth={node.depth} style:--depth={node.depth}>
                <div class="row-main">
                  <div class="line preview-row">
                    <AnimatedStatusIcon status={agent.status} size={13} isStatic={!status.live} />
                    <span class="agent-name">{agent.identity.name}</span>
                    <span class="status-text" data-tone={status.tone}>{status.label}</span>
                    <span class="elapsed tabular-nums">{elapsed(agent)}</span>
                  </div>
                  {@render closeButton(agent)}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .activity-anchor { position: relative; flex-shrink: 0; }
  .activity-trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 2px 4px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; color: var(--color-text-primary); cursor: pointer; }
  .trigger-label { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
  .activity-trigger:hover .trigger-label { color: var(--color-accent); }
  .trigger-count, .trigger-flag { display: inline-grid; place-items: center; min-width: 18px; height: 16px; padding: 0 6px; white-space: nowrap; border-radius: var(--radius-full); font-size: 10px; font-weight: 700; line-height: 1; }
  .trigger-count { background: var(--color-surface-3); color: var(--color-text-secondary); }
  .trigger-flag[data-tone='attention'] { background: var(--color-warning); color: var(--color-on-accent); }
  .trigger-flag[data-tone='error'] { background: var(--color-error); color: var(--color-surface-0); }

  .activity-popover { position: absolute; top: 100%; right: 0; z-index: 40; padding-top: 6px; width: min(380px, calc(100vw - 32px)); }
  .activity-panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-1); color: var(--color-text-primary); box-shadow: 0 8px 24px color-mix(in srgb, var(--color-text-primary) 12%, transparent); overflow: hidden; font-size: 12px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }
  .heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .heading-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-muted); font-size: 11px; }
  .header-actions { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
  .clear-all { padding: 3px 6px; border-radius: var(--radius-sm); color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
  .clear-all:hover { color: var(--color-error); }
  .icon-btn { display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .empty, .lineage-caption { margin: 0; padding: 10px 12px; color: var(--color-text-muted); font-size: 11px; line-height: 1.5; }
  .lineage-caption { padding-bottom: 2px; }

  .tree { list-style: none; margin: 0; padding: 4px; max-height: min(420px, 62vh); overflow-y: auto; scrollbar-width: thin; }
  .row { position: relative; padding-left: calc(var(--depth, 0) * 16px); }
  /* Indent guide: a quiet rule from the parent down to each child. */
  .row[data-depth]:not([data-depth='0'])::before { content: ''; position: absolute; top: 0; bottom: 0; left: calc(var(--depth) * 16px - 8px); width: 1px; background: var(--color-border); }
  .row + .row[data-depth='0'] { border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent); }
  .row-main { display: flex; align-items: flex-start; gap: 2px; min-width: 0; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; width: 100%; }
  .preview-row { padding: 6px; }
  .agent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .elapsed { flex-shrink: 0; min-width: 4ch; text-align: right; color: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .sub { padding-left: 19px; }
  .status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); font-size: 11px; }
  .preview-row .status-text { flex-shrink: 0; max-width: 45%; }
  .status-text[data-tone='error'] { color: color-mix(in srgb, var(--color-error) 78%, var(--color-text-primary)); }
  .status-text[data-tone='attention'] { color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text-primary)); font-weight: 600; }
  .agent-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 6px; border-radius: var(--radius-sm); }
  .metadata, .task, .result { padding-left: 19px; font-size: 11px; }
  .metadata { color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task, .result { color: var(--color-text-secondary); display: -webkit-box; line-clamp: 1; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .result { color: var(--color-text-muted); }
  .disclosure-btn { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 24px; margin-top: 3px; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .disclosure-btn :global(.chev) { transition: transform var(--duration-fast, 100ms) ease; }
  .disclosure-btn :global(.chev.open) { transform: rotate(90deg); }
  .row-detail { margin: 0 6px 8px 41px; padding-left: 10px; border-left: 1px solid var(--color-border); display: grid; gap: 6px; }
  .row-detail dt { font-size: 10px; color: var(--color-text-muted); }
  .row-detail dd { margin: 1px 0 0; font-size: 11px; color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9rem; overflow: auto; }
  .more { display: block; width: calc(100% - 8px); margin: 0 4px 6px; padding: 6px; border-radius: var(--radius-sm); text-align: left; color: var(--color-accent); font-size: 11px; }
  .close-agent { flex-shrink: 0; padding: 6px; margin-top: 3px; border-radius: var(--radius-sm); opacity: 0; color: var(--color-text-muted); transition: opacity 120ms ease, color 120ms ease, background 120ms ease; }
  .row-main:hover .close-agent, .row-main:focus-within .close-agent { opacity: 1; }
  .close-agent:hover { color: var(--color-error); }
  button { cursor: pointer; }
  button:hover { background: var(--color-surface-2); }
  .activity-trigger:hover { background: transparent; }
  button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
  button:disabled { opacity: 0.4; cursor: default; }
  @media (hover: none) { .close-agent { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .close-agent, .disclosure-btn :global(.chev) { transition: none; }
  }
</style>
