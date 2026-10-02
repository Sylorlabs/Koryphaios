<script lang="ts">
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';

  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'info';
    /** Adds a "Don't show again" button so a caller can let users opt out of this dialog. */
    showSuppressOption?: boolean;
    suppressLabel?: string;
    /** Bindable so the caller can persist the choice when the user confirms. */
    suppressChecked?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  }

  let {
    open = false,
    title = 'Confirm',
    message = 'Are you sure?',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'danger',
    showSuppressOption = false,
    suppressLabel = "Don't show again",
    suppressChecked = $bindable(false),
    onConfirm,
    onCancel,
  }: Props = $props();

  let dialogEl = $state<HTMLElement | null>(null);

  $effect(() => {
    if (open && dialogEl) {
      const focusable = dialogEl.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Cancel stays the initial focus even when an optional control (the
      // "Don't show again" button) is rendered above the footer. Focus must not
      // land on an opt-out control the user never asked to touch.
      const initial = dialogEl.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? first;
      initial?.focus();

      function trapFocus(e: KeyboardEvent) {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }

      dialogEl.addEventListener('keydown', trapFocus);
      return () => dialogEl?.removeEventListener('keydown', trapFocus);
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      onCancel?.();
      return;
    }
    if (e.key !== 'Enter') return;
    // A focused button already activates on Enter. Confirming here as well would
    // both operate that control and dismiss the dialog in one keystroke.
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('button')) return;
    onConfirm?.();
  }

  function handleOverlayMouseDown(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onCancel?.();
    }
  }

  let buttonClass = $derived(
    variant === 'danger' ? 'btn btn-danger' : 
    variant === 'warning' ? 'btn btn-primary' : 
    'btn btn-primary'
  );
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="dialog-overlay" onmousedown={handleOverlayMouseDown} role="presentation">
    <div class="dialog" role="alertdialog" aria-modal="true" tabindex="-1" bind:this={dialogEl}>
      <div class="dialog-header">
        <div class="flex items-center gap-2">
          {#if variant === 'danger' || variant === 'warning'}
            <AlertTriangle size={18} class="text-error" />
          {/if}
          <h2 class="dialog-title">{title}</h2>
        </div>
      </div>
      <div class="dialog-body">
        <p class="text-sm text-text-secondary">{message}</p>
        {#if showSuppressOption}
          <div class="dialog-suppress">
            <button
              type="button"
              class="dialog-suppress-button"
              aria-pressed={suppressChecked}
              onclick={() => (suppressChecked = !suppressChecked)}
            >
              <span class="dialog-suppress-box" aria-hidden="true">
                {#if suppressChecked}<Check size={11} strokeWidth={3} />{/if}
              </span>
              {suppressLabel}
            </button>
          </div>
        {/if}
      </div>
      <div class="dialog-footer">
        <button class="btn btn-secondary" data-dialog-initial-focus onclick={onCancel}>
          {cancelLabel}
        </button>
        <button class={buttonClass} onclick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-suppress {
    margin-top: var(--space-md);
    padding-top: var(--space-md);
    border-top: 1px solid var(--color-border);
  }

  /* The whole row is the target, so the label is as clickable as the box. */
  .dialog-suppress-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-sm);
    margin-left: calc(var(--space-1) * -1);
    padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition:
      color var(--duration-normal) var(--ease-in-out),
      background var(--duration-normal) var(--ease-in-out);
  }

  .dialog-suppress-button:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }

  .dialog-suppress-button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 60%, transparent);
    outline-offset: 2px;
  }

  .dialog-suppress-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-border-bright);
    color: var(--color-on-accent);
  }

  .dialog-suppress-button[aria-pressed='true'] {
    color: var(--color-text-primary);
  }

  .dialog-suppress-button[aria-pressed='true'] .dialog-suppress-box {
    background: var(--color-accent);
    border-color: var(--color-accent);
  }
</style>
