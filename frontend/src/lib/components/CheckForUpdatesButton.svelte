<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { toastStore as toast } from "$lib/stores/toast.svelte";
  import { RefreshCw, Check, AlertCircle } from "lucide-svelte";

  interface Props {
    variant?: 'button' | 'menu-item';
    class?: string;
  }

  let { variant = 'button', class: className = '' }: Props = $props();

  async function handleCheck() {
    const result = await updater.checkForUpdates(false);
    
    if (result) {
      if (result.available) {
        toast.success(`Update available: v${result.version}`);
      } else {
        toast.success("You're on the latest version!");
      }
    } else if (updater.error) {
      toast.error("Failed to check for updates");
    }
  }

  // Reactive icon component based on state
  const StatusIcon = $derived.by(() => {
    if (updater.checking) return RefreshCw;
    if (updater.updateAvailable) return AlertCircle;
    return Check;
  });

  function getStatusText() {
    if (updater.checking) {
      return "Checking...";
    }
    if (updater.updateAvailable) {
      return "Update Available";
    }
    return "Check for Updates";
  }

  // Use theme-aware classes
  function getBaseClasses() {
    return 'transition-all duration-150 ease-out';
  }

  function getStatusClasses() {
    if (updater.updateAvailable) {
      return 'text-[var(--color-accent)]';
    }
    return 'text-[var(--color-text-secondary)]';
  }
</script>

{#if variant === 'button'}
  <button
    onclick={handleCheck}
    disabled={updater.checking}
    class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium 
           text-[var(--color-text-secondary)] 
           hover:text-[var(--color-text-primary)] 
           hover:bg-[var(--color-surface-2)]
           rounded-lg 
           border border-[var(--color-border)]
           {getBaseClasses()}
           disabled:opacity-50 disabled:cursor-not-allowed 
           {className}"
    style="font-family: var(--font-sans);"
    title={updater.lastChecked ? `Last checked: ${updater.getLastCheckedText()}` : 'Check for updates'}
  >
    <StatusIcon class="w-4 h-4 {updater.checking ? 'animate-spin' : ''} {updater.updateAvailable ? 'text-[var(--color-accent)]' : ''}" />
    <span class={updater.updateAvailable ? 'text-[var(--color-accent)]' : ''}>
      {getStatusText()}
    </span>
    {#if updater.lastChecked}
      <span class="text-xs text-[var(--color-text-muted)]">
        ({updater.getLastCheckedText()})
      </span>
    {/if}
  </button>
{:else}
  <button
    onclick={handleCheck}
    disabled={updater.checking}
    class="w-full flex items-center gap-3 px-4 py-2 text-left text-sm 
           text-[var(--color-text-secondary)]
           hover:text-[var(--color-text-primary)]
           hover:bg-[var(--color-surface-2)]
           {getBaseClasses()}
           disabled:opacity-50 disabled:cursor-not-allowed 
           {className}"
    style="font-family: var(--font-sans);"
  >
    <StatusIcon class="w-4 h-4 {updater.checking ? 'animate-spin' : ''} {getStatusClasses()}" />
    <span class="flex-1 {getStatusClasses()}">
      {getStatusText()}
    </span>
    {#if updater.lastChecked}
      <span class="text-xs text-[var(--color-text-muted)]">
        {updater.getLastCheckedText()}
      </span>
    {/if}
  </button>
{/if}

<style>
  /* Respect user's motion preferences */
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
    
    :global(.animate-spin) {
      animation: none;
    }
  }
</style>
