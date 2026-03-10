<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { RefreshCw, Check, AlertCircle } from "lucide-svelte";
  import { toast } from "$lib/stores/toast.svelte";

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

  function getStatusIcon() {
    if (updater.checking) {
      return RefreshCw;
    }
    if (updater.updateAvailable) {
      return AlertCircle;
    }
    return Check;
  }

  function getStatusText() {
    if (updater.checking) {
      return "Checking...";
    }
    if (updater.updateAvailable) {
      return "Update Available";
    }
    return "Check for Updates";
  }

  function getStatusColor() {
    if (updater.checking) {
      return "text-slate-400";
    }
    if (updater.updateAvailable) {
      return "text-amber-400";
    }
    return "text-slate-300";
  }
</script>

{#if variant === 'button'}
  <button
    onclick={handleCheck}
    disabled={updater.checking}
    class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed {className}"
    title={updater.lastChecked ? `Last checked: ${updater.getLastCheckedText()}` : 'Check for updates'}
  >
    {#const Icon = getStatusIcon()}
    <Icon class="w-4 h-4 {updater.checking ? 'animate-spin' : ''} {updater.updateAvailable ? 'text-amber-400' : ''}" />
    <span class={updater.updateAvailable ? 'text-amber-400' : ''}>
      {getStatusText()}
    </span>
    {#if updater.lastChecked}
      <span class="text-xs text-slate-500">
        ({updater.getLastCheckedText()})
      </span>
    {/if}
  </button>
{:else}
  <button
    onclick={handleCheck}
    disabled={updater.checking}
    class="w-full flex items-center gap-3 px-4 py-2 text-left text-sm hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed {className}"
  >
    {#const Icon = getStatusIcon()}
    <Icon class="w-4 h-4 {updater.checking ? 'animate-spin' : ''} {getStatusColor()}" />
    <span class="flex-1 {getStatusColor()}">
      {getStatusText()}
    </span>
    {#if updater.lastChecked}
      <span class="text-xs text-slate-500">
        {updater.getLastCheckedText()}
      </span>
    {/if}
  </button>
{/if}
