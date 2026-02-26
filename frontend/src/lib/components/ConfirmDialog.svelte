<script lang="ts">
  import { AlertTriangle, X } from 'lucide-svelte';

  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'info';
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
      first?.focus();

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
    if (e.key === 'Escape' && open && onCancel) {
      onCancel();
    }
    if (e.key === 'Enter' && open && onConfirm) {
      onConfirm();
    }
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
      </div>
      <div class="dialog-footer">
        <button class="btn btn-secondary" onclick={onCancel}>
          {cancelLabel}
        </button>
        <button class={buttonClass} onclick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
