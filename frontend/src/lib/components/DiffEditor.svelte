<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import FileText from 'lucide-svelte/icons/file-text';
  import { gitStore } from '$lib/stores/git.svelte';

  let { zenMode = false }: { zenMode?: boolean } = $props();

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
  <div
    class="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2 {zenMode ? 'pr-28' : 'pr-4'} shrink-0"
  >
    <div class="flex items-center gap-2">
      <span class="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">
        {gitStore.state.activeDiff?.staged ? 'Staged' : 'Working Tree'}
      </span>
      <span class="font-mono text-xs font-semibold text-[var(--color-text-primary)]">{gitStore.state.activeDiff?.file}</span>
    </div>
    <button
      class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
      onclick={() => gitStore.closeDiff()}
      aria-label="Close diff"
      title="Close diff"
    >
      <X size={14} />
    </button>
  </div>

  <!-- Diff Content -->
  <div class="flex-1 overflow-auto p-4 font-mono text-xs">
    {#if gitStore.state.currentDiff && gitStore.state.currentDiff.trim() !== ""}
      {#each lines as line}
        <div class="whitespace-pre-wrap {
          line.type === 'add' ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]' :
          line.type === 'remove' ? 'bg-[var(--color-error-bg)] text-[var(--color-error)]' :
          line.type === 'header' ? 'text-[var(--color-info)] opacity-70' :
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
