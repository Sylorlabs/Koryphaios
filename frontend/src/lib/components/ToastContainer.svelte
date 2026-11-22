<script lang="ts">
  import { isUndoToast, toastStore } from '$lib/stores/toast.svelte';
  import { formatShortcut } from '$lib/utils/platform';
  import { isTextEntryTarget, isUndoChord } from '$lib/utils/toast-undo';
  import X from 'lucide-svelte/icons/x';
  import CheckCircle from 'lucide-svelte/icons/check-circle';
  import AlertCircle from 'lucide-svelte/icons/alert-circle';
  import Info from 'lucide-svelte/icons/info';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';

  // How many notifications stay open while the stack is collapsed. Two keeps a
  // fresh pair readable without a wall of cards covering the transcript.
  const COLLAPSED_LIMIT = 2;

  const iconMap = {
    success: CheckCircle,
    error: AlertCircle,
    info: Info,
    warning: AlertTriangle,
  };

  // Variant colour lives on the border and icon only. The card itself stays an
  // opaque surface with primary text so it reads over custom chat backgrounds —
  // a translucent tint let the wallpaper bleed through and wash the text out.
  const borderMap = {
    success: 'border-[var(--color-success)]/50',
    error: 'border-[var(--color-error)]/50',
    info: 'border-[var(--color-info)]/50',
    warning: 'border-[var(--color-warning)]/50',
  };
  const iconColorMap = {
    success: 'text-[var(--color-success)]',
    error: 'text-[var(--color-error)]',
    info: 'text-[var(--color-info)]',
    warning: 'text-[var(--color-warning)]',
  };

  /** Explicit reader intent, so a collapse is never re-opened or re-collapsed
   *  behind their back when one toast dismisses. */
  let expanded = $state(false);

  // Newest first: the stack hangs from the top of the window, so a new
  // notification belongs next to the anchor instead of below older ones.
  const ordered = $derived([...toastStore.toasts].reverse());
  const overflowing = $derived(ordered.length > COLLAPSED_LIMIT);
  const shown = $derived(
    expanded || !overflowing ? ordered : ordered.slice(0, COLLAPSED_LIMIT),
  );
  const hidden = $derived(overflowing ? ordered.slice(COLLAPSED_LIMIT) : []);

  const hiddenSummary = $derived.by(() => {
    const counts = { error: 0, warning: 0, success: 0, info: 0 };
    for (const toast of hidden) counts[toast.type] += 1;
    return [
      counts.error ? `${counts.error} error${counts.error === 1 ? '' : 's'}` : null,
      counts.warning ? `${counts.warning} warning${counts.warning === 1 ? '' : 's'}` : null,
      counts.success ? `${counts.success} success${counts.success === 1 ? '' : 'es'}` : null,
      counts.info ? `${counts.info} info` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  });

  /** The platform undo chord answers the newest undo offer, unless the reader
   *  is typing: text fields keep their own undo. */
  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || !isUndoChord(event)) return;
    if (isTextEntryTarget(event.target) || isTextEntryTarget(document.activeElement)) return;
    if (toastStore.runLatestUndo()) event.preventDefault();
  }

  // Writing this through a plain statement (not in the button handler) covers
  // the pile shrinking from anywhere — a timeout, a clear-all, a dismiss.
  $effect(() => {
    if (!overflowing) expanded = false;
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if toastStore.toasts.length > 0}
  <div class="toast-anchor">
    <div class="toast-stack" role="region" aria-label="Notifications">
      {#each shown as toast (toast.id)}
        {@const ToastIcon = iconMap[toast.type]}
        <div
          class="toast-card border {borderMap[toast.type]}"
          onmouseenter={() => toastStore.pause(toast.id)}
          onmouseleave={() => toastStore.resume(toast.id)}
          role="alert"
          aria-live="assertive"
          data-toast-type={toast.type}
        >
          <ToastIcon size={18} class="mt-0.5 shrink-0 {iconColorMap[toast.type]}" />
          <p class="min-w-0 flex-1 text-sm break-words [overflow-wrap:anywhere]">{toast.message}</p>
          {#if toast.action}
            <button
              type="button"
              class="ml-1 shrink-0 text-xs underline opacity-75 transition-opacity hover:opacity-100"
              onclick={() => toastStore.runAction(toast.id)}
              title={isUndoToast(toast) ? `Undo (${formatShortcut('Mod+Z')})` : undefined}
            >
              {toast.action.label}
            </button>
          {:else if toast.onRetry}
            <button
              class="ml-1 shrink-0 text-xs underline opacity-75 transition-opacity hover:opacity-100"
              onclick={() => {
                toast.onRetry?.();
                toastStore.dismiss(toast.id);
              }}
              aria-label={toast.actionLabel ?? 'Retry action'}
            >
              {toast.actionLabel ?? 'Retry'}
            </button>
          {/if}
          <button
            class="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            onclick={() => toastStore.dismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            <X size={14} />
          </button>
        </div>
      {/each}

      {#if overflowing}
        <div class="toast-more">
          <button
            type="button"
            class="toast-more-toggle"
            aria-expanded={expanded}
            onclick={() => (expanded = !expanded)}
          >
            <span class="min-w-0 flex-1 text-left">
              <span class="block text-xs font-medium">
                {hidden.length} more notification{hidden.length === 1 ? '' : 's'}
              </span>
              <span class="block truncate text-[11px] opacity-70">{hiddenSummary}</span>
            </span>
            {#if expanded}
              <ChevronUp size={14} />
              <span class="sr-only">Collapse notifications</span>
            {:else}
              <ChevronDown size={14} />
              <span class="sr-only">Show all notifications</span>
            {/if}
          </button>
          {#if expanded}
            <button
              type="button"
              class="toast-more-clear"
              onclick={() => toastStore.dismissMany(hidden.map((toast) => toast.id))}
            >
              Clear
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Top middle. The desktop shell's own header occupies the top of the window,
     so the stack starts below it rather than under the toolbar. */
  .toast-anchor {
    position: fixed;
    top: calc(var(--header-height, 52px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 200;
    width: min(28rem, calc(100vw - 2rem));
    pointer-events: none;
  }

  .toast-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Only the cards accept pointer events; the anchor must not eat clicks on the
     transcript underneath it. */
  .toast-card,
  .toast-more {
    pointer-events: auto;
  }

  .toast-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 14px;
    border-radius: 12px;
    border-width: 1px;
    border-style: solid;
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.45);
    animation: toast-drop 0.22s ease-out;
  }

  .toast-more {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 12px;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: color-mix(in srgb, var(--color-surface-1) 94%, transparent);
    color: var(--color-text-secondary);
    backdrop-filter: blur(14px);
    animation: toast-drop 0.22s ease-out;
  }

  .toast-more-toggle {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 8px;
    border: 0;
    background: none;
    padding: 2px 0;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .toast-more-toggle:hover {
    color: var(--color-text-primary);
  }

  .toast-more-clear {
    flex-shrink: 0;
    border: 0;
    background: none;
    padding: 2px 4px;
    font-size: 11px;
    text-decoration: underline;
    color: inherit;
    opacity: 0.75;
    cursor: pointer;
  }

  .toast-more-clear:hover {
    opacity: 1;
  }

  @keyframes toast-drop {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast-card,
    .toast-more {
      animation: none;
    }
  }
</style>
