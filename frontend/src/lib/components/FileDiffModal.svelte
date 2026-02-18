<script lang="ts">
  import { X, FileText } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { gitStore } from '$lib/stores/git.svelte';

  interface Props {
    file: string;
    staged: boolean;
    onClose: () => void;
  }

  let { file, staged, onClose }: Props = $props();

  onMount(() => {
    gitStore.loadDiff(file, staged);
  });

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

<div
  class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
  onclick={onClose}
  role="presentation"
>
  <div
    class="w-full max-w-4xl h-[80vh] rounded-xl flex flex-col overflow-hidden bg-[var(--color-surface-1)] border border-[var(--color-border)] shadow-2xl"
    onclick={e => e.stopPropagation()}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    onkeydown={e => { if (e.key === 'Escape') onClose(); }}
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
      <div class="flex items-center gap-2">
        <span class="font-mono text-sm font-semibold">{file}</span>
        <span class="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-3)] text-[var(--color-text-muted)]">
          {staged ? 'Staged' : 'Working Tree'}
        </span>
      </div>
      <button class="p-1 hover:bg-[var(--color-surface-3)] rounded" onclick={onClose}>
        <X size={18} />
      </button>
    </div>

    <!-- Diff Content -->
    <div class="flex-1 overflow-auto bg-[var(--color-surface-0)] p-4 font-mono text-xs">
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
</div>
