<script lang="ts">
  import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { Square, RotateCcw } from 'lucide-svelte';
  import { fade } from 'svelte/transition';

  interface AgentState {
    identity: AgentIdentity;
    status: AgentStatus;
    content: string;
    thinking: string;
    toolCalls: Array<{ name: string; status: string }>;
    task: string;
    tokensUsed: number;
    contextMax: number;
    contextKnown: boolean;
  }

  let { agent }: { agent: AgentState } = $props();

  function providerLabel(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  let glowClass = $derived(
    agent.identity.domain === 'frontend' ? 'glow-codex' :
    agent.identity.domain === 'backend' ? 'glow-google' :
    agent.identity.domain === 'test' ? 'glow-test' :
    'glow-claude'
  );

  let statusText = $derived(
    agent.status === 'thinking' ? 'Thinking...' :
    agent.status === 'streaming' ? 'Generating...' :
    agent.status === 'tool_calling' ? `Tool: ${agent.toolCalls.at(-1)?.name ?? '...'}` :
    agent.status === 'verifying' ? 'Verifying...' :
    agent.status === 'compacting' ? 'Compacting context...' :
    agent.status === 'waiting_user' ? 'Waiting for input...' :
    agent.status === 'done' ? 'Complete' :
    agent.status === 'error' ? 'Error' :
    'Idle'
  );

  let isActive = $derived(
    agent.status === 'thinking' || agent.status === 'streaming' || agent.status === 'tool_calling' || agent.status === 'compacting'
  );

  let contextPercent = $derived(
    agent.contextMax > 0 ? Math.min((agent.tokensUsed / agent.contextMax) * 100, 100) : 0
  );

  let contextColor = $derived(
    contextPercent > 80 ? 'bg-red-500' :
    contextPercent > 50 ? 'bg-amber-500' :
    'bg-emerald-500'
  );

  let isManager = $derived(agent.identity.role === 'manager');
</script>

<div class="agent-card rounded-lg border transition-all duration-500 
            {isActive ? `active ${glowClass} glow-active min-w-[180px] max-w-[240px]` : 'opacity-60 grayscale-[0.5] scale-95 origin-left'}"
     style="background: var(--color-surface-2); border-color: var(--color-border); padding: {isActive ? '10px 12px' : '6px 10px'};">
  <!-- Header -->
  <div class="flex items-center justify-between {isActive ? 'mb-1.5' : 'mb-0'}">
    <div class="flex items-center gap-1.5">
      <AnimatedStatusIcon status={agent.status} size={isActive ? 16 : 14} {isManager} isStatic={!isActive} />
      <span class="text-xs font-medium {isActive ? 'opacity-100' : 'opacity-70'}" style="color: var(--color-text-primary);">{agent.identity.name}</span>
    </div>
    <div class="flex items-center gap-1">
      {#if isActive}
        <span class="text-[10px] capitalize px-1.5 py-0.5 rounded" style="background: var(--color-surface-3); color: var(--color-text-muted); transition: all 0.3s;">{agent.identity.domain}</span>
        {#if !isManager}
          <button
            class="p-0.5 rounded transition-colors hover:bg-red-500/20"
            style="color: var(--color-text-muted);"
            title="Cancel this worker"
            onclick={() => {
              fetch(`/api/agents/${agent.identity.id}/cancel`, { method: 'POST' }).catch(() => {});
            }}
          >
            <Square size={10} />
          </button>
        {/if}
      {:else}
        <span class="text-[9px] opacity-40 uppercase tracking-tighter">{agent.status}</span>
      {/if}
    </div>
  </div>

  {#if isActive}
    <!-- Status -->
    <div class="flex items-center justify-between mb-1.5" transition:fade={{duration: 200}}>
      <span class="text-[11px]" style="color: {agent.status === 'done' ? 'var(--color-success)' : agent.status === 'error' ? 'var(--color-error)' : 'var(--color-text-secondary)'};">
        {statusText}
      </span>
      <span class="text-[10px]" style="color: var(--color-text-muted);">({providerLabel(agent.identity.provider)}) {agent.identity.model}</span>
    </div>

    <!-- Context window bar -->
    {#if agent.tokensUsed > 0 && agent.contextKnown && agent.contextMax > 0}
      <div class="mb-1">
        <div class="flex items-center justify-between mb-0.5">
          <span class="text-[9px]" style="color: var(--color-text-muted);">Context</span>
          <span class="text-[9px]" style="color: var(--color-text-muted);">{Math.round(agent.tokensUsed / 1000)}k / {Math.round(agent.contextMax / 1000)}k</span>
        </div>
        <div class="h-1 rounded-full overflow-hidden" style="background: var(--color-surface-4);">
          <div class="h-full rounded-full transition-all {contextColor}" style="width: {contextPercent}%;"></div>
        </div>
      </div>
    {/if}

    <!-- Recent tools -->
    {#if agent.toolCalls.length > 0}
      <div class="flex flex-wrap gap-1 mt-1">
        {#each agent.toolCalls.slice(-2) as tc}
          <span class="text-[10px] px-1 py-0.5 rounded" style="background: var(--color-surface-3); color: var(--color-accent);">{tc.name}</span>
        {/each}
      </div>
    {/if}
  {/if}
</div>
