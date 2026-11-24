<script lang="ts">
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import type { FeedEntryLocal } from '$lib/types';
  import ToolActivityIcon from './ToolActivityIcon.svelte';
  import X from 'lucide-svelte/icons/x';
  import { agentStore } from '$lib/stores/agents.svelte';
  import { ACTIVE_AGENT_STATUSES, TERMINAL_AGENT_STATUSES } from '$lib/stores/run-state-core';
  import { agentStatusInfo, describeToolActivity, providerLabel } from '$lib/utils/agent-presentation';

  interface WorkerCardAgent {
    identity: AgentIdentity;
    status: AgentStatus;
    content: string;
    thinking: string;
    toolCalls: Array<{ name: string; status: string }>;
    task: string;
    tokensUsed: number;
    contextMax: number;
    contextKnown: boolean;
    sessionId?: string;
    stopReason?: 'cancelled';
  }

  let {
    agent,
    status,
    selected = false,
    onSelect,
    onClose,
    closing = false,
    tabindex = -1,
  }: {
    agent: WorkerCardAgent;
    /** Separate primitive prop: AgentState objects are mutated in place, so
     *  `agent.status` never invalidates a $derived. */
    status: AgentStatus;
    selected?: boolean;
    onSelect?: () => void;
    onClose?: () => void;
    closing?: boolean;
    tabindex?: number;
  } = $props();

  // Not terminal: the close control stops the worker before closing it.
  let isActive = $derived(!TERMINAL_AGENT_STATUSES.has(status));
  // Producing right now. A parked (waiting) worker is not live, so its glyph
  // holds still instead of looking busy.
  let isLive = $derived(ACTIVE_AGENT_STATUSES.has(status));
  let statusInfo = $derived(agentStatusInfo(status, { stopReason: agent.stopReason }));
  // The status badge gives the states that need a decision a shape of their
  // own, so they never read through colour alone.
  let badge = $derived<'error' | 'attention' | 'waiting' | null>(
    status === 'error' ? 'error' : status === 'waiting_user' ? 'attention' : status === 'waiting' ? 'waiting' : null,
  );

  let contextPercent = $derived(
    agent.contextMax > 0 ? Math.min((agent.tokensUsed / agent.contextMax) * 100, 100) : 0
  );

  let isManager = $derived(agent.identity.role === 'manager');
  let steeringCount = $derived(agent.sessionId && !isManager
    ? agentStore.getAgentSteeringQueue(agent.sessionId, agent.identity.id).filter((item) => item.status === 'queued').length
    : 0);

  // Live tool icon: the exact glyph+colour the transcript uses for the same
  // tool row, driven by the agent's latest in-flight call. With nothing in
  // flight the strip falls back to the green Command glyph, which animates
  // while the agent is still working and sits static once it isn't.
  let currentTool = $derived(agentStore.getAgentCurrentTool(agent.sessionId, agent.identity.id));
  let iconEntry = $derived<FeedEntryLocal>({
    id: 'seg-icon',
    timestamp: 0,
    // 'tool_call' is the running state (animated); 'tool_result' is complete.
    type: isLive ? 'tool_call' : 'tool_result',
    agentId: agent.identity.id,
    agentName: agent.identity.name ?? agent.identity.id,
    glowClass: '',
    text: '',
    metadata: {
      toolCall: currentTool ?? { name: 'bash', input: {} },
    },
  });

  // The hover card stays deliberately short: which provider/model the agent
  // is burning and how much of its context window is left.
  let activity = $derived(isLive ? describeToolActivity(currentTool) : '');
  // The accessible name is who and what, not the model: a screen reader user
  // hears "frontend, Running tool: bash · bun test" where the tooltip shows
  // the provider details.
  let accessibleName = $derived(
    `${agent.identity.name}, ${statusInfo.label}${activity ? `: ${activity}` : ''}`,
  );

  let details = $derived(
    [
      `${providerLabel(agent.identity.provider)} ${agent.identity.model}`,
      agent.contextKnown && agent.contextMax > 0 ? `Context ${Math.round(contextPercent)}%` : '',
      steeringCount > 0 ? `${steeringCount} queued steering message${steeringCount === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
</script>

<div
  class="agent-seg"
  class:selected
  data-seg-id={agent.identity.id}
  data-testid="agent-seg"
  role="tab"
  aria-selected={selected}
  aria-label={accessibleName}
  data-status={status}
  data-tone={statusInfo.tone}
  {tabindex}
  title={details}
  onclick={() => onSelect?.()}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    }
  }}
>
  <span
    class="seg-icon"
    class:seg-done={status === 'done' || status === 'idle'}
    aria-hidden="true"
  >
    <ToolActivityIcon entry={iconEntry} size={13} />
    {#if badge}
      <span class="seg-badge" data-badge={badge}>
        {#if badge === 'waiting'}<span class="pause-bars"></span>{:else}{badge === 'error' ? '!' : '?'}{/if}
      </span>
    {/if}
  </span>
  <span class="seg-name">{agent.identity.name}</span>
  {#if steeringCount > 0}<span class="queue-badge" aria-label={`${steeringCount} queued steering messages`}>{steeringCount}</span>{/if}
  <button
    type="button"
    class="seg-close"
    class:seg-close-pinned={selected}
    title={isActive ? `Stop and close ${agent.identity.name}` : `Close ${agent.identity.name}`}
    aria-label={isActive ? `Stop and close ${agent.identity.name}` : `Close ${agent.identity.name}`}
    disabled={closing}
    tabindex="-1"
    onclick={(event) => {
      event.stopPropagation();
      onClose?.();
    }}
  >
    <X size={11} />
  </button>
</div>

<style>
  .agent-seg {
    position: relative;
    z-index: 1;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 7px;
    height: 100%;
    padding: 0 6px 0 7px;
    color: var(--color-text-primary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
  }
  /* Accent alone is a pale gold on the light theme; mixing it toward the
     text colour keeps the selected label legible in both. */
  .agent-seg.selected {
    color: color-mix(in srgb, var(--color-accent) 70%, var(--color-text-primary));
  }
  .agent-seg:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
    border-radius: 6px;
  }
  .seg-icon {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }
  .seg-done {
    opacity: 0.6;
  }
  /* A 9px corner badge with its own glyph: "!" failed, "?" waiting on you,
     pause bars for a provider queue. Absolute, so a status change never moves
     the name or the close control. */
  .seg-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    display: grid;
    place-items: center;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--color-surface-2);
    font-size: 8px;
    font-weight: 800;
    line-height: 1;
    color: var(--color-on-accent);
  }
  .seg-badge[data-badge='error'] {
    background: var(--color-error);
    color: var(--color-surface-0);
  }
  .seg-badge[data-badge='attention'] {
    background: var(--color-warning);
  }
  .seg-badge[data-badge='waiting'] {
    background: var(--color-text-muted);
  }
  .pause-bars {
    width: 4px;
    height: 4px;
    border-left: 1.5px solid var(--color-surface-1);
    border-right: 1.5px solid var(--color-surface-1);
  }
  .seg-name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .queue-badge {
    min-width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--color-accent);
    color: var(--color-on-accent);
    font-size: 10px;
    font-weight: 700;
  }
  .seg-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: 4px;
    padding: 2px;
    color: var(--color-text-muted);
    opacity: 0;
    /* Invisible means inert: a click near a tab's edge must never stop a
       running worker the user could not see a control for. */
    pointer-events: none;
    transition: opacity 0.12s;
  }
  .seg-close:hover {
    background: var(--color-surface-3);
  }
  .seg-close:disabled {
    cursor: default;
    opacity: 0.3;
  }
  .agent-seg:hover .seg-close,
  .agent-seg:focus-within .seg-close,
  .seg-close.seg-close-pinned {
    opacity: 1;
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .seg-close {
      transition: none;
    }
  }
</style>
