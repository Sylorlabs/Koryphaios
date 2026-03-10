<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { Sparkles, Download, X, ExternalLink, Loader2 } from "lucide-svelte";
  import { fly, fade } from "svelte/transition";

  let installing = $state(false);

  async function handleInstall() {
    installing = true;
    await updater.installUpdate();
    // App will restart, no need to reset state
  }

  function handleDismiss() {
    updater.dismissUpdate();
  }

  function handleViewChangelog() {
    updater.openChangelog();
  }
</script>

{#if updater.updateAvailable && updater.updateInfo}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    transition:fade={{ duration: 200 }}
    onclick={handleDismiss}
    onkeydown={(e) => e.key === 'Escape' && handleDismiss()}
    role="dialog"
    aria-modal="true"
    aria-labelledby="update-title"
  >
    <div
      class="relative w-full max-w-md mx-4 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
      transition:fly={{ y: 20, duration: 300 }}
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header with gradient -->
      <div class="relative bg-gradient-to-br from-indigo-600 to-purple-600 p-6">
        <button
          onclick={handleDismiss}
          class="absolute top-4 right-4 p-1 text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          aria-label="Dismiss update"
        >
          <X class="w-5 h-5" />
        </button>
        
        <div class="flex items-center gap-3">
          <div class="p-3 bg-white/10 rounded-xl">
            <Sparkles class="w-8 h-8 text-white" />
          </div>
          <div>
            <h2 id="update-title" class="text-xl font-bold text-white">
              Update Available
            </h2>
            <p class="text-white/80 text-sm">
              Version {updater.updateInfo.version}
            </p>
          </div>
        </div>
      </div>

      <!-- Content -->
      <div class="p-6 space-y-4">
        <!-- Release notes preview -->
        {#if updater.updateInfo.notes}
          <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <h3 class="text-sm font-medium text-slate-300 mb-2">What's New</h3>
            <div class="text-sm text-slate-400 max-h-32 overflow-y-auto space-y-1">
              {#each updater.updateInfo.notes.split('\n').filter(line => line.trim()) as line}
                <p class="flex items-start gap-2">
                  <span class="text-indigo-400 mt-1">•</span>
                  <span>{line.replace(/^- /, '').replace(/^\w+:\s*/, '')}</span>
                </p>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Release date -->
        {#if updater.updateInfo.pubDate}
          <p class="text-xs text-slate-500 text-center">
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
            class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
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
              class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium rounded-lg transition-colors"
            >
              <ExternalLink class="w-4 h-4" />
              <span>View Changelog</span>
            </button>
            
            <button
              onclick={handleDismiss}
              disabled={installing}
              class="flex-1 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-slate-400 hover:text-slate-300 text-sm font-medium rounded-lg transition-colors"
            >
              Remind Me Later
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
