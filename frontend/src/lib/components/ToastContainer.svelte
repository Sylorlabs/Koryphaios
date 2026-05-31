<script lang="ts">
  import { toastStore } from '$lib/stores/toast.svelte';
  import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-svelte';

  const MAX_EXPANDED_TOASTS = 1;

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

  let hiddenToasts = $derived(
    toastStore.toasts.length > MAX_EXPANDED_TOASTS
      ? toastStore.toasts.slice(0, -MAX_EXPANDED_TOASTS)
      : [],
  );

  let visibleToasts = $derived(
    toastStore.toasts.length > MAX_EXPANDED_TOASTS
      ? toastStore.toasts.slice(-MAX_EXPANDED_TOASTS)
      : toastStore.toasts,
  );

  let hiddenSummary = $derived.by(() => {
    const counts = {
      error: 0,
      warning: 0,
      success: 0,
      info: 0,
    };

    for (const toast of hiddenToasts) {
      counts[toast.type] += 1;
    }

    return [
      counts.error ? `${counts.error} error${counts.error === 1 ? '' : 's'}` : null,
      counts.warning ? `${counts.warning} warning${counts.warning === 1 ? '' : 's'}` : null,
      counts.success ? `${counts.success} success${counts.success === 1 ? '' : 'es'}` : null,
      counts.info ? `${counts.info} info` : null,
    ].filter(Boolean).join(' · ');
  });
</script>

{#if toastStore.toasts.length > 0}
  <div class="fixed bottom-4 right-4 z-[200] flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0">
    {#if hiddenToasts.length > 0}
      <div
        class="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[color:var(--color-surface-1)]/95 px-4 py-2.5 text-[var(--color-text-secondary)] shadow-xl backdrop-blur-xl"
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="text-sm font-medium">
            {hiddenToasts.length} more notification{hiddenToasts.length === 1 ? '' : 's'}
          </span>
          <span class="truncate text-xs opacity-70">{hiddenSummary}</span>
        </div>
        <button
          class="shrink-0 text-xs underline opacity-75 transition-opacity hover:opacity-100"
          onclick={() => toastStore.dismissMany(hiddenToasts.map((toast) => toast.id))}
          aria-label="Clear older notifications"
        >
          Clear
        </button>
      </div>
    {/if}

    {#each visibleToasts as toast (toast.id)}
      {@const ToastIcon = iconMap[toast.type]}
      <div 
        class="flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-xl
               animate-slide-in {colorMap[toast.type]}"
      >
        <ToastIcon size={18} class="shrink-0 mt-0.5" />
        <p class="text-sm flex-1">{toast.message}</p>
        {#if toast.onRetry}
          <button
            class="text-xs underline opacity-75 hover:opacity-100 ml-2 shrink-0"
            onclick={() => { toast.onRetry?.(); toastStore.dismiss(toast.id); }}
            aria-label="Retry action"
          >
            Retry
          </button>
        {/if}
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
