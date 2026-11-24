<script lang="ts">
  import { onMount } from 'svelte';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Send from 'lucide-svelte/icons/send';
  import Square from 'lucide-svelte/icons/square';
  import Terminal from 'lucide-svelte/icons/terminal';
  import { processStore, type Process } from '$lib/stores/processes.svelte';
  import { isAgentBackgroundProcess } from '@koryphaios/shared';

  let { sessionId }: { sessionId: string } = $props();
  const id = $props.id();
  let expanded = $state<Record<string, boolean>>({});
  let inputs = $state<Record<string, string>>({});
  let logs = $state<Record<string, string>>({});
  let mounted = $state(false);

  let shells = $derived(
    processStore.processes.filter(
      (process) =>
        process.sessionId === sessionId &&
        isAgentBackgroundProcess(process) &&
        (process.status === 'running' || process.status === 'starting'),
    ),
  );

  async function refresh() {
    await processStore.loadSessionProcesses(sessionId);
    await Promise.all(
      shells.filter((process) => expanded[process.id]).map((process) => refreshLogs(process)),
    );
  }

  async function refreshLogs(process: Process) {
    const current = await processStore.loadProcessLogs(process.id, 250);
    logs = {
      ...logs,
      [process.id]: [current?.stdout, current?.stderr].filter(Boolean).join('\n'),
    };
  }

  async function toggle(process: Process) {
    expanded = { ...expanded, [process.id]: !expanded[process.id] };
    if (expanded[process.id]) await refreshLogs(process);
  }

  async function sendInput(process: Process) {
    const value = inputs[process.id] ?? '';
    if (!value) return;
    if (await processStore.writeInput(process.id, `${value}\n`)) {
      inputs = { ...inputs, [process.id]: '' };
      setTimeout(() => void refreshLogs(process), 150);
    }
  }

  onMount(() => {
    mounted = true;
    void refresh();
  });

  // Only poll while background shells exist — avoids 1,440 idle HTTP requests
  // per hour when none are running. A top-level effect owns the timer so it is
  // torn down with the component (it used to be created inside onMount).
  $effect(() => {
    if (!mounted || shells.length === 0) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  });
</script>

{#if shells.length > 0}
  <section class="shells" aria-labelledby={`${id}-title`}>
    <div class="shells-header">
      <Terminal size={13} class="text-[var(--color-text-muted)]" />
      <h2 id={`${id}-title`} class="shells-title">Background shells</h2>
      <span class="shells-count tabular-nums">{shells.length}</span>
      <button
        type="button"
        class="icon-btn ml-auto"
        onclick={refresh}
        aria-label="Refresh background shells"
        title="Refresh background shells"
      >
        <RefreshCw size={12} class={processStore.isLoading ? 'spin' : ''} />
      </button>
    </div>
    <ul class="shell-list">
      {#each shells as process (process.id)}
        {@const open = expanded[process.id] ?? false}
        <li class="shell" data-status={process.status}>
          <div class="shell-row">
            <button
              type="button"
              class="shell-toggle"
              onclick={() => toggle(process)}
              aria-expanded={open}
              aria-controls={open ? `${id}-${process.id}` : undefined}
            >
              <ChevronRight size={12} class={`chev ${open ? 'open' : ''}`} />
              <span class="shell-state" data-status={process.status}>
                <span class="state-dot" aria-hidden="true"></span>
                {process.status === 'starting' ? 'Starting' : 'Running'}
              </span>
              <span class="shell-name">{process.name}</span>
              <span class="shell-command">$ {process.command}</span>
            </button>
            <button
              type="button"
              class="icon-btn kill"
              onclick={() => processStore.killProcess(process.id)}
              title={`Stop ${process.name}`}
              aria-label={`Stop ${process.name}`}
            >
              <Square size={11} fill="currentColor" />
            </button>
          </div>
          {#if open}
            <div class="shell-detail" id={`${id}-${process.id}`}>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <pre class="shell-log" tabindex="0" aria-label={`${process.name} output`}>{logs[process.id] || 'Waiting for output…'}</pre>
              <form
                class="shell-input"
                onsubmit={(event) => {
                  event.preventDefault();
                  void sendInput(process);
                }}
              >
                <input
                  value={inputs[process.id] ?? ''}
                  oninput={(event) =>
                    (inputs = { ...inputs, [process.id]: event.currentTarget.value })}
                  placeholder="Type into stdin…"
                  aria-label={`Input for ${process.name}`}
                />
                <button
                  type="submit"
                  class="send"
                  disabled={!(inputs[process.id] ?? '')}
                  aria-label="Send input"
                >
                  <Send size={13} />
                </button>
              </form>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .shells { flex-shrink: 0; padding: 6px 16px 8px; border-top: 1px solid var(--color-border); background: var(--color-surface-1); }
  .shells-header { display: flex; align-items: center; gap: 6px; min-height: 26px; }
  .shells-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--color-text-secondary); }
  .shells-count { font-size: 11px; color: var(--color-text-muted); }
  .shell-list { list-style: none; margin: 0; padding: 0; max-height: 16rem; overflow-y: auto; scrollbar-width: thin; }
  .shell + .shell { border-top: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent); }
  .shell-row { display: flex; align-items: center; gap: 4px; min-height: 30px; }
  .shell-toggle { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 0; text-align: left; border-radius: var(--radius-sm); }
  .shell-toggle :global(.chev) { flex-shrink: 0; color: var(--color-text-muted); transition: transform var(--duration-fast, 100ms) ease; }
  .shell-toggle :global(.chev.open) { transform: rotate(90deg); }
  .shell-state { display: inline-flex; flex-shrink: 0; align-items: center; gap: 5px; min-width: 66px; font-size: 11px; color: var(--color-text-secondary); }
  .state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-success); }
  .shell-state[data-status='starting'] .state-dot { background: transparent; border: 1.5px solid var(--color-warning); }
  .shell-name { flex-shrink: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; color: var(--color-text-primary); }
  .shell-command { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/1.4 var(--font-mono); color: var(--color-text-muted); }
  .icon-btn { display: grid; place-items: center; flex-shrink: 0; width: 26px; height: 26px; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .icon-btn:hover { background: var(--color-surface-3); color: var(--color-text-primary); }
  .kill:hover { color: var(--color-error); background: var(--color-error-bg); }
  .shell-detail { margin: 0 0 8px 20px; padding-left: 10px; border-left: 1px solid var(--color-border); }
  .shell-log { margin: 0; min-height: 3.5rem; max-height: 9rem; overflow: auto; padding: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.6 var(--font-mono); color: var(--color-text-secondary); background: transparent; border: 0; }
  .shell-input { display: flex; gap: 6px; padding-top: 6px; }
  .shell-input input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-0); color: var(--color-text-primary); font: 12px var(--font-mono); outline: none; }
  .shell-input input:focus { border-color: var(--color-accent); }
  .send { display: grid; place-items: center; padding: 0 10px; border-radius: var(--radius-md); background: var(--color-accent); color: var(--color-on-accent); }
  .send:disabled { opacity: 0.4; }
  button:focus-visible, .shell-log:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
  .shells :global(.spin) { animation: shells-spin 1s linear infinite; }
  @keyframes shells-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .shells :global(.spin), .shell-toggle :global(.chev) { animation: none; transition: none; }
  }
</style>
