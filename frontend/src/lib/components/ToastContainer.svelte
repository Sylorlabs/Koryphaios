<script lang="ts">
  import { toastStore } from '$lib/stores/toast.svelte';
  import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-svelte';

  const iconMap = {
    success: CheckCircle,
    error: AlertCircle,
    info: Info,
    warning: AlertTriangle,
  };

  const colorMap = {
    success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
    error: 'border-red-500/40 bg-red-500/10 text-red-400',
    info: 'border-blue-500/40 bg-blue-500/10 text-blue-400',
    warning: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  };
</script>

{#if toastStore.toasts.length > 0}
  <div class="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 max-w-sm">
    {#each toastStore.toasts as toast (toast.id)}
      <div
        class="flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-xl
               animate-slide-in {colorMap[toast.type]}"
      >
        <svelte:component this={iconMap[toast.type]} size={18} class="shrink-0 mt-0.5" />
        <p class="text-sm flex-1">{toast.message}</p>
        <button
          class="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          onclick={() => toastStore.dismiss(toast.id)}
        >
          <X size={14} />
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  @keyframes slide-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .animate-slide-in {
    animation: slide-in 0.25s ease-out;
  }
</style>
