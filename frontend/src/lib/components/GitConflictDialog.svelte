<script lang="ts">
  import { onMount } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Send from 'lucide-svelte/icons/send';
  import X from 'lucide-svelte/icons/x';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    conflicts: string[];
    onClose: () => void;
  }

  let { conflicts, onClose }: Props = $props();
  let dialogElement = $state<HTMLDivElement>();

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogElement?.focus();
    return () => previousFocus?.focus();
  });

  async function sendToKory() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to send conflicts to');
      return;
    }

    const fileList = conflicts.join('\n- ');
    const message = `I encountered Git merge conflicts in the following files:
- ${fileList}

Please help me resolve these conflicts. You can read the files to see the conflict markers.`;

    wsStore.sendMessage(sessionId, message);
    toastStore.success('Conflict details sent to Kory');
    onClose();
  }
</script>

<div class="fixed inset-0 z-[100] flex items-center justify-center p-4">
  <button
    type="button"
    class="absolute inset-0 bg-black/60 backdrop-blur-sm"
    aria-label="Close merge conflict details"
    onclick={onClose}
  ></button>
  <div
    bind:this={dialogElement}
    class="relative w-full max-w-md overflow-hidden rounded-2xl border bg-[var(--color-surface-1)] shadow-2xl"
    style="border-color: color-mix(in srgb, var(--color-error) 35%, var(--color-border));"
    onkeydown={(event) => {
      if (event.key === 'Escape') onClose();
    }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="conflict-title"
    tabindex="-1"
  >
    <div
      class="flex items-center gap-3 border-b px-4 py-3"
      style="border-color: color-mix(in srgb, var(--color-error) 25%, var(--color-border)); background: var(--color-error-bg);"
    >
      <div
        class="flex h-8 w-8 items-center justify-center rounded-full"
        style="background: color-mix(in srgb, var(--color-error) 18%, transparent); color: var(--color-error);"
      >
        <AlertTriangle size={18} />
      </div>
      <div>
        <h3 id="conflict-title" class="text-sm font-bold text-[var(--color-error)]">
          Merge needs attention
        </h3>
        <p class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
          Git left unresolved files
        </p>
      </div>
      <button
        type="button"
        class="ml-auto rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
        aria-label="Close merge conflict details"
        onclick={onClose}
      >
        <X size={16} />
      </button>
    </div>

    <div class="p-4">
      <p class="mb-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
        Git could not merge {conflicts.length} file{conflicts.length !== 1 ? 's' : ''}. Resolve
        every conflict before committing; closing this message does not change the files.
      </p>

      <div
        class="mb-4 max-h-40 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)]"
      >
        {#each conflicts as file (file)}
          <div
            class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 font-mono text-[11px] last:border-0"
          >
            <div class="h-1.5 w-1.5 rounded-full bg-[var(--color-error)]"></div>
            <span class="truncate text-[var(--color-text-primary)]">{file}</span>
          </div>
        {/each}
      </div>

      <div
        class="mb-1 rounded-xl border p-3"
        style="border-color: color-mix(in srgb, var(--color-warning) 25%, var(--color-border)); background: var(--color-warning-bg);"
      >
        <div class="flex gap-2">
          <Send size={14} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
          <p class="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            Send the exact file list to Kory to inspect the conflict markers and propose a reviewed
            resolution. No file is changed by sending the request.
          </p>
        </div>
      </div>
    </div>

    <div
      class="flex gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3"
    >
      <button type="button" class="btn btn-secondary flex-1 text-xs" onclick={onClose}>
        I’ll resolve it
      </button>
      <button
        type="button"
        class="btn btn-primary flex-1 gap-2 border-none text-xs"
        onclick={sendToKory}
      >
        <Send size={12} /> Send to Kory
      </button>
    </div>
  </div>
</div>
