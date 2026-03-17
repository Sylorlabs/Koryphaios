<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { autoInitStore } from '$lib/stores/auto-init.svelte';
  import { Sparkles, Loader2, Check, AlertCircle } from 'lucide-svelte';

  // Only show on first load, not on reconnects
  let hasInitialized = $state(false);
  
  $effect(() => {
    if (autoInitStore.isInitialized && !hasInitialized) {
      hasInitialized = true;
    }
  });
</script>

{#if !hasInitialized && (autoInitStore.isLoading || autoInitStore.error)}
  <div 
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    style="background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(8px);"
    transition:fade={{ duration: 300 }}
  >
    <div 
      class="w-full max-w-md p-8 rounded-2xl shadow-2xl"
      style="background: var(--color-surface-0); border: 1px solid var(--color-border);"
      transition:fly={{ y: 20, duration: 300 }}
    >
      <!-- Logo -->
      <div class="text-center mb-8">
        <div 
          class="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-4"
          style="background: linear-gradient(135deg, var(--color-accent), var(--color-purple));"
        >
          <Sparkles size={32} class="text-white" />
        </div>
        <h1 class="text-2xl font-bold mb-2" style="color: var(--color-text-primary);">
          Koryphaios
        </h1>
        <p class="text-sm" style="color: var(--color-text-muted);">
          {autoInitStore.error ? 'Initialization failed' : 'Getting things ready...'}
        </p>
      </div>

      <!-- Steps -->
      <div class="space-y-3 mb-6">
        {#each autoInitStore.steps as step, i}
          <div 
            class="flex items-center gap-3 p-3 rounded-xl transition-all"
            style="background: {step.status === 'loading' ? 'var(--color-surface-2)' : 'var(--color-surface-1)'}; opacity: {step.status === 'pending' ? '0.5' : '1'};"
          >
            <div 
              class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style="background: {step.status === 'complete' ? 'var(--color-success)' : step.status === 'error' ? 'var(--color-error)' : step.status === 'loading' ? 'var(--color-accent)' : 'var(--color-surface-3)'};"
            >
              {#if step.status === 'complete'}
                <Check size={16} class="text-white" />
              {:else if step.status === 'error'}
                <AlertCircle size={16} class="text-white" />
              {:else if step.status === 'loading'}
                <Loader2 size={16} class="text-white animate-spin" />
              {:else}
                <span class="text-xs font-bold text-white">{i + 1}</span>
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm" style="color: var(--color-text-primary);">
                  {step.name}
                </span>
              </div>
              {#if step.message}
                <p class="text-xs truncate" style="color: var(--color-text-muted);">
                  {step.message}
                </p>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- Error state -->
      {#if autoInitStore.error}
        <div 
          class="p-4 rounded-xl mb-4 text-sm"
          style="background: rgba(239, 68, 68, 0.1); color: var(--color-error); border: 1px solid rgba(239, 68, 68, 0.2);"
        >
          {autoInitStore.error}
        </div>
        <button
          onclick={() => autoInitStore.initialize()}
          class="w-full py-3 rounded-xl font-medium transition-all hover:opacity-90"
          style="background: var(--color-accent); color: white;"
        >
          Try Again
        </button>
      {/if}

      <!-- Skip option for impatient users -->
      {#if autoInitStore.isLoading}
        <button
          onclick={() => hasInitialized = true}
          class="w-full mt-4 text-xs transition-colors hover:underline"
          style="color: var(--color-text-muted);"
        >
          Skip initialization →
        </button>
      {/if}
    </div>
  </div>
{/if}
