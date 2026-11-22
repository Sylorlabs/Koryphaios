<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * One setting: plain-language label and one-line description on the left,
   * its control on the right (stacked on narrow widths). `children` renders the
   * control; `below` renders optional follow-up content (callouts, sub-rules).
   */
  interface Props {
    label: string;
    description?: string;
    id?: string;
    /** Put the control under the text instead of beside it (wide controls). */
    stacked?: boolean;
    children: Snippet;
    below?: Snippet;
  }

  let { label, description, id, stacked = false, children, below }: Props = $props();
</script>

<div class="setting-row" class:stacked {id}>
  <div class="setting-row-main">
    <div class="setting-row-text">
      <div class="setting-row-label">{label}</div>
      {#if description}
        <p class="setting-row-description">{description}</p>
      {/if}
    </div>
    <div class="setting-row-control">
      {@render children()}
    </div>
  </div>
  {#if below}
    <div class="setting-row-below">{@render below()}</div>
  {/if}
</div>

<style>
  .setting-row {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.9rem 1.25rem;
  }
  .setting-row + :global(.setting-row) {
    border-top: 1px solid var(--color-border);
  }
  .setting-row-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.6rem;
    align-items: start;
  }
  @media (min-width: 768px) {
    .setting-row:not(.stacked) .setting-row-main {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1.5rem;
    }
    .setting-row:not(.stacked) .setting-row-control {
      justify-self: end;
      max-width: 34rem;
    }
  }
  .setting-row-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .setting-row-description {
    margin: 0.2rem 0 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .setting-row-control {
    min-width: 0;
  }
  .setting-row-below:empty {
    display: none;
  }
</style>
