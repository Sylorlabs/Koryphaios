<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import ManagerFeed from '$lib/components/ManagerFeed.svelte';
  import FileEditPreview from '$lib/components/FileEditPreview.svelte';
  import DiffEditor from '$lib/components/DiffEditor.svelte';
  import CommandInput from '$lib/components/CommandInput.svelte';
  import WorkerCard from '$lib/components/WorkerCard.svelte';

  interface Agent {
    identity: { id: string };
    status: string;
    sessionId: string;
  }

  interface Props {
    showAgents: boolean;
    zenMode: boolean;
    inputRef?: HTMLTextAreaElement;
    onSend: (message: string, model?: string, reasoningLevel?: string) => void;
    onStop: () => void;
  }

  let { 
    showAgents, 
    zenMode, 
    inputRef = $bindable(),
    onSend, 
    onStop 
  }: Props = $props();

  let activeSessionId = $derived(sessionStore.activeSessionId);
  
  let activeAgents = $derived([...wsStore.agents.values()].filter((a: Agent) => 
    a.sessionId === activeSessionId && a.status !== 'done' && a.status !== 'idle'
  ));

  let isRunning = $derived(wsStore.managerStatus !== 'idle' && wsStore.managerStatus !== 'done');
</script>

<!-- Agent cards (collapsible) - only in advanced mode -->
{#if !zenMode && showAgents && modeStore.showAgentDetails && activeAgents.length > 0}
  <div class="px-4 py-2 border-b flex gap-2 overflow-x-auto shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
    {#each activeAgents as agent (agent.identity.id + agent.status)}
      <WorkerCard {agent} />
    {/each}
  </div>
{:else if !zenMode && showAgents && modeStore.showAgentDetails}
  <div class="px-4 py-2 border-b flex items-center justify-center shrink-0" style="border-color: var(--color-border); background: var(--color-surface-1);">
    <span class="text-xs opacity-40" style="color: var(--color-text-muted);">No agents running</span>
  </div>
{/if}

<!-- File Edit Preview (Cursor-style streaming) -->
<FileEditPreview />

<!-- Chat / Feed area -->
<section class="flex-1 overflow-hidden flex flex-col" role="main" aria-label="Chat feed">
  {#if gitStore.state.activeDiff}
    <DiffEditor />
  {:else}
    <ManagerFeed />
  {/if}
</section>

<!-- Context window usage - only in advanced mode -->
{#if wsStore.contextUsage.isReliable && modeStore.showCostTracking}
  <div 
    class="shrink-0 px-4 flex items-center gap-3" 
    style="padding-top: var(--space-2); padding-bottom: var(--space-2); border-top: 1px solid var(--color-border); background: var(--color-surface-1);"
  >
    <span class="shrink-0" style="font-size: var(--text-xs); color: var(--color-text-muted);">
      Context
    </span>
    <div class="flex-1 rounded-full overflow-hidden" style="height: 6px; background: var(--color-surface-3);">
      <div
        class="h-full rounded-full transition-all"
        style="width: {wsStore.contextUsage.percent}%; transition-duration: var(--duration-slower); background: {
          wsStore.contextUsage.percent > 85 ? '#ef4444' :
          wsStore.contextUsage.percent > 65 ? '#f59e0b' : 
          'var(--color-accent)'
        };"
      ></div>
    </div>
    {#if wsStore.contextUsage.max > 0}
      <span class="shrink-0 tabular-nums" style="font-size: var(--text-xs); color: var(--color-text-muted);">
        {wsStore.contextUsage.used >= 1000 ? `${(wsStore.contextUsage.used / 1000).toFixed(1)}k` : wsStore.contextUsage.used} / {(wsStore.contextUsage.max / 1000).toFixed(1)}k
      </span>
    {/if}
  </div>
{/if}

<!-- Command Input -->
<div class="shrink-0 border-t" style="border-color: var(--color-border); background: var(--color-surface-1);">
  <CommandInput
    bind:inputRef
    {onSend}
    {isRunning}
    {onStop}
  />
</div>
