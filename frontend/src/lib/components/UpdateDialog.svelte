<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { Sparkles, Download, X, ExternalLink, Loader2 } from "lucide-svelte";
  import { fly, fade } from "svelte/transition";

  let installing = $state(false);
  let showDialog = $state(false);

  // Show dialog when update becomes available (if banner wasn't dismissed)
  $effect(() => {
    if (updater.updateAvailable && !updater.showUpdateBanner && !showDialog) {
      // Only auto-show dialog if banner wasn't shown yet
      // User can click the indicator to show it manually
    }
  });

  async function handleInstall() {
    installing = true;
    await updater.installUpdateAndRestart();
    // App will restart, no need to reset state
  }

  function handleDismiss() {
    showDialog = false;
    updater.dismissUpdate();
  }

  function handleViewChangelog() {
    updater.openChangelog();
  }

  export function openDialog() {
    showDialog = true;
  }
</script>

{#if showDialog && updater.updateAvailable && updater.updateInfo}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center"
    transition:fade={{ duration: 200 }}
  >
    <button
      type="button"
      class="absolute inset-0"
      style="background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);"
      aria-label="Dismiss update"
      onclick={handleDismiss}
    ></button>
    <div
      class="relative w-full max-w-md mx-4 overflow-hidden"
      style="
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-xl);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      "
      transition:fly={{ y: 20, duration: 300 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-title"
      tabindex="-1"
      onkeydown={(e) => e.key === 'Escape' && handleDismiss()}
    >
      <!-- Header with accent gradient -->
      <div 
        class="relative p-6"
        style="
          background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-accent-hover) 100%);
        "
      >
        <button
          onclick={handleDismiss}
          class="absolute top-4 right-4 p-1 rounded-lg transition-all duration-150"
          style="
            color: var(--color-surface-0);
            opacity: 0.7;
          "
          onmouseenter={(e) => e.currentTarget.style.opacity = '1'}
          onmouseleave={(e) => e.currentTarget.style.opacity = '0.7'}
          aria-label="Dismiss update"
        >
          <X class="w-5 h-5" />
        </button>
        
        <div class="flex items-center gap-3">
          <div 
            class="p-3 rounded-xl"
            style="background: rgba(0, 0, 0, 0.15);"
          >
            <Sparkles class="w-8 h-8" style="color: var(--color-surface-0);" />
          </div>
          <div>
            <h2 
              id="update-title" 
              class="text-xl font-bold"
              style="color: var(--color-surface-0);"
            >
              Update Available
            </h2>
            <p style="color: var(--color-surface-0); opacity: 0.85;" class="text-sm">
              Version {updater.updateInfo.version}
            </p>
          </div>
        </div>
      </div>

      <!-- Content -->
      <div class="p-6 space-y-4" style="font-family: var(--font-sans);">
        <!-- Release notes preview -->
        {#if updater.updateInfo.notes}
          <div 
            class="rounded-lg p-4 border"
            style="
              background: var(--color-surface-2);
              border-color: var(--color-border);
            "
          >
            <h3 
              class="text-sm font-medium mb-2"
              style="color: var(--color-text-secondary);"
            >
              What's New
            </h3>
            <div 
              class="text-sm max-h-32 overflow-y-auto space-y-1"
              style="color: var(--color-text-muted);"
            >
              {#each updater.updateInfo.notes.split('\n').filter(line => line.trim()) as line}
                <p class="flex items-start gap-2">
                  <span style="color: var(--color-accent);" class="mt-1">•</span>
                  <span>{line.replace(/^- /, '').replace(/^\w+:\s*/, '')}</span>
                </p>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Release date -->
        {#if updater.updateInfo.pubDate}
          <p 
            class="text-xs text-center"
            style="color: var(--color-text-muted);"
          >
            Released on {new Date(updater.updateInfo.pubDate).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            })}
          </p>
        {/if}

        <!-- Actions -->
        <div class="space-y-2 pt-2">
          <button
            onclick={handleInstall}
            disabled={installing}
            class="w-full flex items-center justify-center gap-2 px-4 py-3 font-medium rounded-lg transition-all duration-150"
            style="
              background: var(--color-accent);
              color: var(--color-surface-0);
              font-family: var(--font-sans);
            "
            onmouseenter={(e) => {
              if (!installing) e.currentTarget.style.background = 'var(--color-accent-hover)';
            }}
            onmouseleave={(e) => {
              e.currentTarget.style.background = 'var(--color-accent)';
            }}
          >
            {#if installing}
              <Loader2 class="w-5 h-5 animate-spin" />
              <span>Installing...</span>
            {:else}
              <Download class="w-5 h-5" />
              <span>Install Update</span>
            {/if}
          </button>

          <div class="flex gap-2">
            <button
              onclick={handleViewChangelog}
              class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-150"
              style="
                background: var(--color-surface-3);
                color: var(--color-text-secondary);
                font-family: var(--font-sans);
              "
              onmouseenter={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-4)';
                e.currentTarget.style.color = 'var(--color-text-primary)';
              }}
              onmouseleave={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-3)';
                e.currentTarget.style.color = 'var(--color-text-secondary)';
              }}
            >
              <ExternalLink class="w-4 h-4" />
              <span>View Changelog</span>
            </button>
            
            <button
              onclick={handleDismiss}
              disabled={installing}
              class="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
              style="
                background: var(--color-surface-3);
                color: var(--color-text-muted);
                font-family: var(--font-sans);
              "
              onmouseenter={(e) => {
                if (!installing) {
                  e.currentTarget.style.background = 'var(--color-surface-4)';
                  e.currentTarget.style.color = 'var(--color-text-secondary)';
                }
              }}
              onmouseleave={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-3)';
                e.currentTarget.style.color = 'var(--color-text-muted)';
              }}
            >
              Remind Me Later
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Scrollbar styling for release notes */
  div::-webkit-scrollbar {
    width: 6px;
  }

  div::-webkit-scrollbar-track {
    background: var(--color-surface-3);
    border-radius: var(--radius-sm);
  }

  div::-webkit-scrollbar-thumb {
    background: var(--color-border-bright);
    border-radius: var(--radius-sm);
  }

  div::-webkit-scrollbar-thumb:hover {
    background: var(--color-accent);
  }

  /* Respect user's motion preferences */
  @media (prefers-reduced-motion: reduce) {
    :global(.animate-spin) {
      animation: none;
    }
  }
</style>
