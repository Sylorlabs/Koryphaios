<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { Download, ExternalLink, Loader2 } from "lucide-svelte";

  let installing = $state(false);
  let showDialog = $state(false);

  async function handleInstall() {
    installing = true;
    await updater.installUpdateAndRestart();
  }

  function handleDismiss() {
    showDialog = false;
    updater.dismissUpdate();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleDismiss();
  }

  export function openDialog() {
    showDialog = true;
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if showDialog && updater.updateAvailable && updater.updateInfo}
  <div
    class="dialog-overlay"
    onmousedown={(e) => e.target === e.currentTarget && handleDismiss()}
    role="presentation"
  >
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
      tabindex="-1"
    >
      <div class="dialog-header">
        <div class="flex items-center gap-2">
          <Download size={16} class="text-[var(--color-accent)] shrink-0" />
          <h2 class="dialog-title" id="update-dialog-title">
            Update available — v{updater.updateInfo.version}
          </h2>
        </div>
      </div>

      <div class="dialog-body space-y-3">
        {#if updater.updateInfo.notes}
          <div
            class="rounded-lg border border-[var(--color-border)]
                   bg-[var(--color-surface-2)] p-3"
          >
            <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
              What's new
            </p>
            <div class="max-h-32 space-y-1 overflow-y-auto text-sm text-[var(--color-text-muted)]">
              {#each updater.updateInfo.notes.split('\n').filter((l) => l.trim()) as line}
                <p>
                  <span class="mr-1.5 text-[var(--color-accent)]">·</span>{line
                    .replace(/^[-*]\s*/, '')
                    .replace(/^\w+:\s*/, '')}
                </p>
              {/each}
            </div>
          </div>
        {:else}
          <p class="text-sm text-[var(--color-text-muted)]">
            A new version of Koryphaios is ready to install.
          </p>
        {/if}

        {#if updater.updateInfo.pubDate}
          <p class="text-xs text-[var(--color-text-muted)]">
            Released {new Date(updater.updateInfo.pubDate).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        {/if}
      </div>

      <div class="dialog-footer">
        <button
          onclick={updater.openChangelog}
          class="btn btn-secondary flex items-center gap-1.5"
        >
          <ExternalLink size={14} />
          Changelog
        </button>
        <button onclick={handleDismiss} disabled={installing} class="btn btn-secondary">
          Later
        </button>
        <button onclick={handleInstall} disabled={installing} class="btn btn-primary flex items-center gap-1.5">
          {#if installing}
            <Loader2 size={14} class="animate-spin" />
            Installing…
          {:else}
            <Download size={14} />
            Install & Restart
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
