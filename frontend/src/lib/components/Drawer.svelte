<script lang="ts">
  import { X } from 'lucide-svelte';

  interface Props {
    open?: boolean;
    title?: string;
    onClose?: () => void;
    children?: import('svelte').Snippet;
  }

  let {
    open = false,
    title = '',
    onClose,
    children,
  }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open && onClose) {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="backdrop" onclick={onClose} role="presentation"></div>
  <div class="drawer open" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
    <div class="drawer-header">
      <h2 id="drawer-title" class="drawer-title">{title}</h2>
      <button
        class="btn btn-secondary"
        style="padding: 8px;"
        onclick={onClose}
        aria-label="Close"
      >
        <X size={18} />
      </button>
    </div>
    <div class="drawer-content">
      {#if children}
        {@render children()}
      {/if}
    </div>
  </div>
{/if}
