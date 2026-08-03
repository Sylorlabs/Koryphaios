<script lang="ts">
  import { backendHealth, recheckBackendHealth } from '$lib/stores/backend-health.svelte';

  const visible = $derived(backendHealth.status === 'recovering');
</script>

{#if visible}
  <div class="backend-recovery" role="status" aria-live="polite">
    <span class="pulse" aria-hidden="true"></span>
    <span>Development backend restarting…</span>
    <button type="button" onclick={recheckBackendHealth}>Check now</button>
  </div>
{/if}

<style>
  .backend-recovery {
    position: fixed;
    right: var(--space-lg);
    bottom: var(--space-lg);
    z-index: 9000;
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
    border: 1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-lg);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
  }

  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-warning);
    animation: pulse 1.2s ease-in-out infinite;
  }

  button {
    border: 0;
    border-left: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-primary);
    cursor: pointer;
    font: inherit;
    padding-left: var(--space-sm);
  }

  @keyframes pulse {
    50% { opacity: .35; transform: scale(.8); }
  }
</style>
