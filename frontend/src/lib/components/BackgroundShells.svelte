<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronRight, RefreshCw, Send, Square, Terminal } from 'lucide-svelte';
  import { processStore, type Process } from '$lib/stores/processes.svelte';

  let { sessionId }: { sessionId: string } = $props();
  let expanded = $state<Record<string, boolean>>({});
  let inputs = $state<Record<string, string>>({});
  let logs = $state<Record<string, string>>({});

  let shells = $derived(
    processStore.processes.filter((process) =>
      process.sessionId === sessionId && (process.status === 'running' || process.status === 'starting'),
    ),
  );

  async function refresh() {
    await processStore.loadSessionProcesses(sessionId);
    await Promise.all(shells.filter((process) => expanded[process.id]).map((process) => refreshLogs(process)));
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
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  });
</script>

{#if shells.length > 0}
  <section class="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2" aria-label="Background shells">
    <div class="mb-1.5 flex items-center justify-between">
      <div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
        <Terminal size={12} class="text-emerald-400" />
        Background shells
        <span class="rounded-full bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[9px]">{shells.length}</span>
      </div>
      <button type="button" class="rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]" onclick={refresh} aria-label="Refresh background shells">
        <RefreshCw size={12} class={processStore.isLoading ? 'animate-spin' : ''} />
      </button>
    </div>
    <div class="max-h-64 space-y-1.5 overflow-y-auto">
      {#each shells as process (process.id)}
        <div class="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]">
          <div class="flex items-center gap-2 px-2.5 py-2">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={() => toggle(process)} aria-expanded={expanded[process.id] ?? false}>
              {#if expanded[process.id]}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
              <span class="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.55)]"></span>
              <span class="truncate text-xs font-semibold text-[var(--color-text-primary)]">{process.name}</span>
              <span class="truncate font-mono text-[10px] text-[var(--color-text-muted)]">$ {process.command}</span>
            </button>
            <button type="button" class="rounded-lg p-1.5 text-red-400 hover:bg-red-500/10" onclick={() => processStore.killProcess(process.id)} title="Kill shell" aria-label={`Kill ${process.name}`}>
              <Square size={12} fill="currentColor" />
            </button>
          </div>
          {#if expanded[process.id]}
            <div class="border-t border-[var(--color-border)]">
              <pre class="max-h-36 min-h-14 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{logs[process.id] || 'Waiting for output…'}</pre>
              <form class="flex gap-2 border-t border-[var(--color-border)] p-2" onsubmit={(event) => { event.preventDefault(); void sendInput(process); }}>
                <input
                  class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  value={inputs[process.id] ?? ''}
                  oninput={(event) => inputs = { ...inputs, [process.id]: event.currentTarget.value }}
                  placeholder="Type into stdin…"
                  aria-label={`Input for ${process.name}`}
                />
                <button type="submit" class="rounded-lg bg-[var(--color-accent)] px-3 text-[var(--color-surface-0)] disabled:opacity-40" disabled={!(inputs[process.id] ?? '')} aria-label="Send input">
                  <Send size={13} />
                </button>
              </form>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}
