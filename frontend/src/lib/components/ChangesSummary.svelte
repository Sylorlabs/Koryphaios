<script lang="ts">
  import { wsStore } from "$lib/stores/websocket.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { FileCode, Check, X, ChevronRight, Plus, Minus, Pencil } from "lucide-svelte";
  import { slide } from "svelte/transition";

  let expanded = $state(false);
  let changes = $derived(wsStore.sessionChanges.get(sessionStore.activeSessionId ?? ""));

  function handleRespond(accepted: boolean) {
    if (!sessionStore.activeSessionId) return;
    wsStore.respondToChanges(sessionStore.activeSessionId, accepted);
  }

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }
</script>

{#if changes && changes.length > 0}
  <div class="fixed bottom-24 left-1/2 -translate-x-1/2 w-full max-w-xl px-4 z-50">
    <div class="bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden ring-1 ring-black/20">
      <!-- Header / Toggle -->
      <div class="flex items-center justify-between px-4 py-3 bg-[var(--color-surface-2)]">
        <button
          class="flex items-center gap-2 hover:opacity-80 transition-opacity"
          onclick={() => expanded = !expanded}
        >
          <div class="flex items-center justify-center w-6 h-6 rounded-lg bg-accent/20 text-accent">
            <FileCode size={14} />
          </div>
          <span class="text-xs font-semibold text-[var(--color-text-primary)]">
            {changes.length} file change{changes.length === 1 ? '' : 's'} pending
          </span>
          <ChevronRight size={14} class="text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-90' : ''}" />
        </button>

        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 transition-colors"
            onclick={() => handleRespond(true)}
          >
            <Check size={12} strokeWidth={3} />
            Keep
          </button>
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
            onclick={() => handleRespond(false)}
          >
            <X size={12} strokeWidth={3} />
            Reject
          </button>
        </div>
      </div>

      <!-- Change list -->
      {#if expanded}
        <div transition:slide={{ duration: 200 }} class="max-h-60 overflow-y-auto border-t border-[var(--color-border)] p-2 space-y-1 bg-[var(--color-surface-1)]">
          {#each changes as change}
            <div class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors group">
              {#if change.operation === 'create'}
                <Plus size={12} class="text-emerald-400" />
              {:else if change.operation === 'delete'}
                <Minus size={12} class="text-red-400" />
              {:else}
                <Pencil size={12} class="text-amber-400" />
              {/if}

              <div class="flex-1 min-w-0">
                <p class="text-xs font-mono truncate text-[var(--color-text-primary)]">{getFileName(change.path)}</p>
                <p class="text-[9px] font-mono text-[var(--color-text-muted)] truncate">{change.path}</p>
              </div>

              <div class="flex items-center gap-2 font-mono text-[10px]">
                {#if change.linesAdded > 0}
                  <span class="text-emerald-400">+{change.linesAdded}</span>
                {/if}
                {#if change.linesDeleted > 0}
                  <span class="text-red-400">-{change.linesDeleted}</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
