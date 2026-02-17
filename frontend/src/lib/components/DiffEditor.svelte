<script lang="ts">
  import { X, FileText } from 'lucide-svelte';
  import { gitStore } from '$lib/stores/git.svelte';

  // Basic diff parser for display
  function parseDiff(raw: string | null) {
    if (!raw) return [];
    return raw.split('\n').map(line => {
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
        return { type: 'header', text: line };
      }
      if (line.startsWith('+')) return { type: 'add', text: line };
      if (line.startsWith('-')) return { type: 'remove', text: line };
      return { type: 'context', text: line };
    });
  }

  let lines = $derived(parseDiff(gitStore.state.currentDiff));
</script>

<div class="h-full flex flex-col bg-[var(--color-surface-0)]">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] shrink-0 bg-[var(--color-surface-1)]">
    <div class="flex items-center gap-2">
      <span class="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">
        {gitStore.state.activeDiff?.staged ? 'Staged' : 'Working Tree'}
      </span>
      <span class="font-mono text-xs font-semibold text-[var(--color-text-primary)]">{gitStore.state.activeDiff?.file}</span>
    </div>
    <button class="p-1 hover:bg-[var(--color-surface-3)] rounded text-[var(--color-text-muted)]" onclick={() => gitStore.closeDiff()}>
      <X size={14} />
    </button>
  </div>

  <!-- Diff Content -->
  <div class="flex-1 overflow-auto p-4 font-mono text-xs">
    {#if gitStore.state.currentDiff && gitStore.state.currentDiff.trim() !== ""}
      {#each lines as line}
        <div class="whitespace-pre-wrap {
          line.type === 'add' ? 'bg-green-500/10 text-green-400' :
          line.type === 'remove' ? 'bg-red-500/10 text-red-400' :
          line.type === 'header' ? 'text-blue-400 opacity-70' :
          'text-[var(--color-text-secondary)]'
        }">
          {line.text}
        </div>
      {/each}
    {:else if gitStore.state.currentFileContent !== null}
      <div class="text-[var(--color-text-muted)] mb-4 flex items-center gap-2 pb-2 border-b border-[var(--color-border)]">
        <FileText size={14} />
        <span>No differences detected. Showing full file content:</span>
      </div>
      <div class="text-[var(--color-text-secondary)] whitespace-pre-wrap">
        {gitStore.state.currentFileContent}
      </div>
    {:else}
      <div class="flex items-center justify-center h-full text-[var(--color-text-muted)]">
        {#if !gitStore.state.currentDiff && gitStore.state.currentFileContent === null}
          Loading...
        {:else}
          No content available for this file.
        {/if}
      </div>
    {/if}
  </div>
</div>
