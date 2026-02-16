<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { FileCode, X, Pencil, FilePlus } from 'lucide-svelte';
  import { tick } from 'svelte';
  import FileIcon from './icons/FileIcon.svelte';

  let codeContainer = $state<HTMLPreElement>();
  let collapsed = $state<Set<string>>(new Set());

  let edits = $derived([...wsStore.activeFileEdits.values()]);

  $effect(() => {
    // Auto-scroll code container when content changes
    if (edits.length > 0 && codeContainer) {
      tick().then(() => {
        if (codeContainer) {
          codeContainer.scrollTop = codeContainer.scrollHeight;
        }
      });
    }
  });

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  function getRelativePath(path: string): string {
    // Show last 3 segments for context
    const parts = path.split('/');
    return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : path;
  }

  function toggleCollapse(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }

  function getLineNumbers(content: string): string {
    const lines = content.split('\n');
    return lines.map((_, i) => i + 1).join('\n');
  }
</script>

{#if edits.length > 0}
  <div class="flex flex-col gap-2 p-3">
    {#each edits as edit (edit.path)}
      <div
        class="rounded-lg border overflow-hidden transition-all"
        style="border-color: var(--color-border); background: var(--color-surface-0);"
      >
        <!-- File header -->
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:brightness-110"
          style="background: var(--color-surface-2);"
          onclick={() => toggleCollapse(edit.path)}
        >
          <FileIcon path={edit.path} size={14} />
          <span class="text-xs font-mono truncate" style="color: var(--color-text-primary);">
            {getFileName(edit.path)}
          </span>
          <span class="text-[10px] font-mono truncate ml-auto" style="color: var(--color-text-muted);">
            {getRelativePath(edit.path)}
          </span>
          <span class="text-[10px] px-1.5 py-0.5 rounded shrink-0 {edit.operation === 'create' ? 'text-emerald-400' : 'text-amber-400'}"
                style="background: var(--color-surface-3);">
            {edit.operation === 'create' ? 'NEW' : 'EDIT'}
          </span>
          <!-- Typing indicator -->
          <span class="flex gap-0.5 shrink-0">
            <span class="w-1 h-1 rounded-full bg-accent animate-pulse" style="animation-delay: 0ms;"></span>
            <span class="w-1 h-1 rounded-full bg-accent animate-pulse" style="animation-delay: 150ms;"></span>
            <span class="w-1 h-1 rounded-full bg-accent animate-pulse" style="animation-delay: 300ms;"></span>
          </span>
        </button>

        <!-- Code content -->
        {#if !collapsed.has(edit.path)}
          <div class="flex overflow-hidden" style="max-height: 400px;">
            <!-- Line numbers -->
            <pre
              class="text-right pr-2 pl-3 py-2 text-[11px] leading-[1.4] select-none shrink-0 font-mono"
              style="color: var(--color-text-muted); background: var(--color-surface-1); border-right: 1px solid var(--color-border);"
            >{getLineNumbers(edit.content)}</pre>

            <!-- Code content -->
            <pre
              bind:this={codeContainer}
              class="flex-1 overflow-auto py-2 px-3 text-[11px] leading-[1.4] font-mono"
              style="color: var(--color-text-primary);"
            >{edit.content}<span class="inline-block w-[2px] h-[14px] bg-accent animate-pulse ml-px align-middle"></span></pre>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
