<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    label,
    children,
  }: {
    label: string;
    children: Snippet;
  } = $props();
</script>

<svelte:boundary>
  {@render children()}
  {#snippet failed(error, reset)}
    <div class="panel-error" role="alert">
      <p class="panel-error__title">{label} failed to render</p>
      <p class="panel-error__detail">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <button type="button" onclick={reset}>Retry {label.toLowerCase()}</button>
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .panel-error {
    display: grid;
    gap: 6px;
    place-content: center;
    margin: 12px;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    text-align: center;
  }

  .panel-error__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .panel-error__detail {
    margin: 0;
    max-width: 52ch;
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .panel-error button {
    justify-self: center;
    min-height: 32px;
    margin-top: 4px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0 12px;
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    font-size: 12px;
    cursor: pointer;
  }
</style>
