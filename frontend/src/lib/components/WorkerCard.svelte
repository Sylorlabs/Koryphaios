<script lang="ts">
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import type { FeedEntryLocal } from '$lib/types';
  import ToolActivityIcon from './ToolActivityIcon.svelte';
  import X from 'lucide-svelte/icons/x';
  import { agentStore } from '$lib/stores/agents.svelte';

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
    if (provider === 'hundredmillionseek') return '100MillionSeek';
    if (provider === 'numes') return 'Numes';
    if (provider === 'coarena') return 'Coarena';
    if (provider === 'crowllm') return 'CrowLLM';
    if (provider === 'radeon') return 'AMD Radeon Cloud';
    if (provider === 'runcrate') return 'Runcrate';
    if (provider === 'tokenharbor') return 'Token Harbor';
    if (provider === 'logfare') return 'Logfare';
    if (provider === 'apinex') return 'APInex';
    if (provider === 'gwarden') return 'Gwarden AI';
    if (provider === 'respan') return 'Respan';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'opencode') return 'OpenCode';
    if (provider === 'beam') return 'Reflection AI';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  let isActive = $derived(!['idle', 'done', 'error'].includes(status));

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
    type: isActive ? 'tool_call' : 'tool_result',
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
  aria-label={details}
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
    {#if status === 'error'}<span class="seg-err-dot"></span>{/if}
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
    gap: 5px;
    height: 100%;
    padding: 0 6px 0 7px;
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
  .seg-err-dot {
    position: absolute;
    top: -1px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-error);
    border: 1px solid var(--color-surface-2);
  }
  .seg-name {
    max-width: 160px;
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
  }
</style>
