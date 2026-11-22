<script lang="ts">
  import AnimatedStatusIcon from '$lib/components/AnimatedStatusIcon.svelte';
  import X from 'lucide-svelte/icons/x';
  import type { AgentRailState } from './useAgentRail.svelte';
  import { TERMINAL_AGENT_STATUSES } from '$lib/stores/run-state-core';

  let { rail, expanded = false }: { rail: AgentRailState; expanded?: boolean } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let preview = $state(false);
  let pinned = $state(false);
  let open = $derived(preview || pinned);

  // Keep the existing View / Activity command usable as well as this trigger.
  $effect(() => { pinned = expanded; });

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
    onclick={() => {
      preview = false;
      pinned = !pinned;
    }}
  >Activity</button>

  {#if open}
    <div class="activity-popover" id={`${id}-activity`}>
      <section class="activity-panel" aria-label={pinned ? 'Activity details' : 'Activity preview'}>
        <header>
          <strong>Activity</strong>
          <div class="header-actions">
            <button type="button" class="clear-all" onclick={() => void clearAll()}>
              Clear all
            </button>
            {#if pinned}
            <button type="button" aria-label="Close activity" onclick={() => { dismiss(); trigger.focus(); }}>
              <X size={14} />
            </button>
            {/if}
          </div>
        </header>
        <ul>
          {#each rail.sessionAgentChats as agent (agent.identity.id)}
            <li>
              {#if pinned}
                <div class="activity-item">
                  <button class="agent-info" type="button" onclick={() => selectAgent(agent.identity.id)} aria-label={`Open ${agent.identity.name} chat`}>
                    <span class="summary">
                      <AnimatedStatusIcon status={agent.status} size={13} isManager={false} />
                      <span class="agent-name">{agent.identity.name}</span>
                      <span class="status">{agent.status.replaceAll('_', ' ')}</span>
                    </span>
                    <span class="metadata">{agent.identity.provider} · {agent.identity.model}</span>
                    {#if agent.task}<span class="task">{agent.task}</span>{/if}
                  </button>
                  <button
                    type="button"
                    class="close-agent"
                    aria-label={`${TERMINAL_AGENT_STATUSES.has(agent.status) ? 'Close' : 'Stop and close'} ${agent.identity.name}`}
                    disabled={rail.closingAgentIds.has(agent.identity.id)}
                    onclick={() => void rail.closeAgent(agent.identity.id)}
                  ><X size={12} /></button>
                </div>
              {:else}
                <div class="activity-item preview-item">
                  <div class="summary preview-row">
                    <AnimatedStatusIcon status={agent.status} size={13} isManager={false} />
                    <span class="agent-name">{agent.identity.name}</span>
                    <span class="status">{agent.status.replaceAll('_', ' ')}</span>
                  </div>
                  <button
                    type="button"
                    class="close-agent"
                    aria-label={`${TERMINAL_AGENT_STATUSES.has(agent.status) ? 'Close' : 'Stop and close'} ${agent.identity.name}`}
                    disabled={rail.closingAgentIds.has(agent.identity.id)}
                    onclick={() => void rail.closeAgent(agent.identity.id)}
                  ><X size={12} /></button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    </div>
  {/if}
</div>

<style>
  .activity-anchor { position: relative; flex-shrink: 0; }
  .activity-trigger { padding: 4px 0; font-size: 12px; font-weight: 600; color: var(--color-text-primary); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .activity-trigger:hover { color: var(--color-accent); }
  .activity-popover { position: absolute; top: 100%; right: 0; z-index: 40; padding-top: 6px; width: min(340px, calc(100vw - 32px)); }
  .activity-panel { border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-surface-1); color: var(--color-text-primary); box-shadow: 0 8px 24px color-mix(in srgb, var(--color-text-primary) 12%, transparent); overflow: hidden; font-size: 11px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }
  .header-actions { display: flex; align-items: center; gap: 6px; }
  .clear-all { padding: 3px 5px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; }
  .clear-all:hover { color: var(--color-error); }
  ul { list-style: none; margin: 0; padding: 4px; max-height: min(320px, 60vh); overflow-y: auto; }
  .summary { display: flex; align-items: center; gap: 6px; min-width: 0; width: 100%; }
  .preview-row { padding: 6px; }
  .agent-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { flex-shrink: 0; color: var(--color-text-muted); }
  .activity-item { display: flex; align-items: flex-start; }
  .preview-item { align-items: center; }
  .agent-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 7px 6px; border-radius: 6px; }
  .metadata { color: var(--color-text-muted); overflow-wrap: anywhere; }
  .task { color: var(--color-text-secondary); display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .close-agent { padding: 6px; margin-top: 3px; opacity: 0; color: var(--color-text-muted); transition: opacity 120ms ease, color 120ms ease, background 120ms ease; }
  .activity-item:hover .close-agent, .activity-item:focus-within .close-agent { opacity: 1; }
  .close-agent:hover { color: var(--color-error); }
  button { cursor: pointer; }
  button:hover { background: var(--color-surface-2); }
  button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  button:disabled { opacity: 0.4; cursor: default; }
</style>
