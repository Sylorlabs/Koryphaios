<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { Download, X } from "lucide-svelte";
  import UpdateDialog from "./UpdateDialog.svelte";

  let updateDialog: UpdateDialog;

  async function handleRestart() {
    await updater.installUpdateAndRestart();
  }

  function handleDismiss() {
    updater.dismissUpdate();
  }

  function handleShowDetails() {
    updater.dismissUpdate();
    updateDialog?.openDialog();
  }
</script>

<UpdateDialog bind:this={updateDialog} />

{#if updater.showUpdateBanner && updater.updateAvailable}
  <div class="fixed bottom-4 right-4 z-[190] w-full max-w-sm px-4 sm:px-0">
    <div
      class="flex items-start gap-3 rounded-xl border border-[var(--color-border)]
             bg-[color:var(--color-surface-1)]/95 px-4 py-3 shadow-xl backdrop-blur-xl"
    >
      <Download size={16} class="mt-0.5 shrink-0 text-[var(--color-accent)]" />

      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-[var(--color-text-primary)]">
          {updater.getUpdateMessage()}
        </p>
        <p class="text-xs text-[var(--color-text-muted)]">
          Restart to apply the update
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <button
          onclick={handleShowDetails}
          class="px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)]
                 rounded-lg border border-[var(--color-border)]
                 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]
                 transition-colors duration-150"
        >
          Details
        </button>
        <button
          onclick={handleRestart}
          class="btn btn-primary px-2.5 py-1 text-xs"
        >
          Restart
        </button>
        <button
          onclick={handleDismiss}
          class="ml-1 opacity-50 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  </div>
{/if}

{#if !updater.showUpdateBanner && updater.updateAvailable}
  <button
    onclick={() => updater.showUpdateNotification()}
    class="fixed bottom-4 right-4 z-[190] flex items-center gap-1.5
           rounded-full border border-[var(--color-border)]
           bg-[color:var(--color-surface-1)]/95 px-3 py-1.5
           text-xs font-medium text-[var(--color-accent)]
           shadow-lg backdrop-blur-xl
           hover:bg-[var(--color-surface-2)] transition-colors duration-150"
    title="Update available"
  >
    <Download size={12} />
    Update ready
  </button>
{/if}
