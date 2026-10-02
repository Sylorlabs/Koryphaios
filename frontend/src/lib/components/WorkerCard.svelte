<script lang="ts">
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import X from 'lucide-svelte/icons/x';

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
  }: {
    agent: WorkerCardAgent;
    /**
     * The agent's status, passed separately from `agent` on purpose.
     *
     * AgentState objects held in the agent store's Map are not reactive
     * proxies, so `agentStore.updateAgentStatus()` mutates `.status` in place
     * and republishes the Map. A keyed #each then hands this component the
     * *same* object reference, which Svelte treats as an unchanged prop — so
     * any $derived reading `agent.status` never re-evaluates and the tile keeps
     * rendering a stale status icon and a stale "Stop and close" label.
     * A primitive prop compares by value, so this does invalidate.
     */
    status: AgentStatus;
    selected?: boolean;
    onSelect?: () => void;
    onClose?: () => void;
    closing?: boolean;
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
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'jules') return 'Jules (cloud)';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  let glowClass = $derived(
    agent.identity.domain === 'ui' ? 'glow-codex' :
    agent.identity.domain === 'backend' ? 'glow-google' :
    agent.identity.domain === 'test' ? 'glow-test' :
    'glow-claude'
  );

  let isActive = $derived(!['idle', 'done', 'error'].includes(status));

  let contextPercent = $derived(
    agent.contextMax > 0 ? Math.min((agent.tokensUsed / agent.contextMax) * 100, 100) : 0
  );

  let isManager = $derived(agent.identity.role === 'manager');

  // The tile is name + status glyph only. The hover card is deliberately
  // short: which provider/model the agent is burning and how much of its
  // context window is left. Status, task text and the "click to steer" hint
  // all restate what the chip and the header already show, and they turned the
  // tooltip into a paragraph the reader had to parse on every pass of the rail.
  let details = $derived(
    [
      `${providerLabel(agent.identity.provider)} ${agent.identity.model}`,
      agent.contextKnown && agent.contextMax > 0 ? `Context ${Math.round(contextPercent)}%` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
</script>

<div
  class="agent-card inline-flex shrink-0 items-center gap-1.5 rounded-lg border text-left transition-all duration-300
            {selected ? `ring-1 ring-[var(--color-accent)] shadow-[0_0_0_1px_rgba(var(--color-accent-rgb), 0.2)]` : ''}
            {isActive ? `active ${glowClass} glow-active` : 'opacity-70'}"
  style="max-width: 220px; height: 24px; padding: 0 5px 0 7px; background: var(--color-surface-2); border-color: {selected
    ? 'rgba(var(--color-accent-rgb), 0.42)'
    : 'var(--color-border)'}; color: var(--color-text-primary);"
  onclick={() => onSelect?.()}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    }
  }}
  role="button"
  tabindex="0"
  title={details}
  aria-label={details}
>
  <span
    class="shrink-0"
    style="color: {status === 'error' ? 'var(--color-error)' : status === 'done' ? 'var(--color-success)' : 'var(--color-accent)'}"
  >
    <AnimatedStatusIcon {status} size={13} {isManager} isStatic={!isActive} />
  </span>
  <span class="text-[11px] font-medium truncate">{agent.identity.name}</span>
  <button
    type="button"
    class="shrink-0 rounded p-0.5 transition-colors hover:bg-[var(--color-surface-3)] disabled:cursor-default disabled:opacity-40"
    style="color: var(--color-text-muted);"
    title={isActive ? `Stop and close ${agent.identity.name}` : `Close ${agent.identity.name}`}
    aria-label={isActive ? `Stop and close ${agent.identity.name}` : `Close ${agent.identity.name}`}
    disabled={closing}
    onclick={(event) => {
      event.stopPropagation();
      onClose?.();
    }}
  >
    <X size={11} />
  </button>
</div>
