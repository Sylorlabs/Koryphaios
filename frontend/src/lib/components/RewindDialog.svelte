<script lang="ts">
  import GitCompareArrows from 'lucide-svelte/icons/git-compare-arrows';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import X from 'lucide-svelte/icons/x';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';

  let preview = $derived(wsStore.rewindPreview);
  let dialogEl = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!preview || !dialogEl) return;
    dialogEl.querySelector<HTMLElement>('button')?.focus();
  });

  $effect(() => {
    if (preview && sessionStore.activeSessionId !== preview.sessionId) wsStore.cancelRewind();
  });

  function fileName(path: string) {
    return path.split('/').at(-1) ?? path;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !wsStore.rewindApplying) {
      event.preventDefault();
      wsStore.cancelRewind();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

{#if preview}
  <div
    class="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
    role="presentation"
    onmousedown={(event) => {
      if (event.target === event.currentTarget) wsStore.cancelRewind();
    }}
  >
    <div
      bind:this={dialogEl}
      class="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
      role="alertdialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="rewind-title"
      onkeydown={handleKeydown}
    >
      <header
        class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4"
      >
        <div class="mt-0.5 rounded-lg bg-amber-500/15 p-2 text-amber-400">
          <GitCompareArrows size={17} />
        </div>
        <div class="min-w-0 flex-1">
          <h2 id="rewind-title" class="text-sm font-semibold text-[var(--color-text-primary)]">
            Rewind this session?
          </h2>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
            {preview.message} Other sessions and files outside this session's manifest stay untouched.
          </p>
        </div>
        <button
          type="button"
          class="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
          aria-label="Cancel rewind"
          onclick={() => wsStore.cancelRewind()}
        >
          <X size={15} />
        </button>
      </header>

      <div class="overflow-y-auto px-5 py-4">
        <p class="text-xs font-medium text-[var(--color-text-primary)]">{preview.description}</p>
        <dl
          class="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-[10px] sm:grid-cols-3"
        >
          <div>
            <dt class="uppercase tracking-wider text-[var(--color-text-muted)]">Model</dt>
            <dd class="mt-1 truncate font-mono text-[var(--color-text-primary)]">
              {preview.evidence.model ?? 'Not reported'}
            </dd>
          </div>
          <div>
            <dt class="uppercase tracking-wider text-[var(--color-text-muted)]">Tokens</dt>
            <dd class="mt-1 font-mono text-[var(--color-text-primary)]">
              {preview.evidence.tokensIn === undefined && preview.evidence.tokensOut === undefined
                ? 'Not reported'
                : `${preview.evidence.tokensIn ?? 0} in · ${preview.evidence.tokensOut ?? 0} out`}
            </dd>
          </div>
          <div>
            <dt class="uppercase tracking-wider text-[var(--color-text-muted)]">Cost</dt>
            <dd class="mt-1 font-mono text-[var(--color-text-primary)]">
              {preview.evidence.cost === undefined
                ? 'Unpriced'
                : `$${preview.evidence.cost.toFixed(4)}`}
            </dd>
          </div>
          <div class="col-span-2 sm:col-span-3">
            <dt class="uppercase tracking-wider text-[var(--color-text-muted)]">Prompt SHA-256</dt>
            <dd
              class="mt-1 truncate font-mono text-[var(--color-text-primary)]"
              title={preview.evidence.promptHash}
            >
              {preview.evidence.promptHash ?? 'Legacy checkpoint — unavailable'}
            </dd>
          </div>
        </dl>
        {#if preview.filesChanged.length > 0}
          <div class="mt-4 overflow-hidden rounded-xl border border-[var(--color-border)]">
            {#each preview.filesChanged as file (file.path)}
              <div
                class="flex items-center gap-3 border-b border-[var(--color-border)] px-3 py-2.5 last:border-b-0"
              >
                <span
                  class="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
                >
                  {file.operation}
                </span>
                <div class="min-w-0">
                  <p class="truncate font-mono text-xs text-[var(--color-text-primary)]">
                    {fileName(file.path)}
                  </p>
                  <p class="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                    {file.path}
                  </p>
                </div>
              </div>
            {/each}
          </div>
        {/if}
        {#if preview.diff}
          <pre
            class="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--color-surface-2)] p-3 font-mono text-[10px] leading-relaxed text-[var(--color-text-secondary)]">{preview.diff}</pre>
        {/if}
      </div>

      <footer
        class="flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-3"
      >
        <button
          type="button"
          class="btn btn-secondary"
          disabled={wsStore.rewindApplying}
          onclick={() => wsStore.cancelRewind()}
        >
          Keep current state
        </button>
        <button
          type="button"
          class="btn btn-primary"
          disabled={wsStore.rewindApplying}
          onclick={() => void wsStore.confirmRewind()}
        >
          <RotateCcw size={13} />
          {wsStore.rewindApplying ? 'Rewinding…' : 'Rewind session'}
        </button>
      </footer>
    </div>
  </div>
{/if}
