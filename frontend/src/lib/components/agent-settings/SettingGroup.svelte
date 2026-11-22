<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';

  /**
   * Collapsible group of related advanced settings. The header always shows a
   * live one-line summary so a collapsed group still says what it is set to.
   */
  interface Props {
    id: string;
    title: string;
    description: string;
    summary?: string;
    icon: typeof ChevronRight;
    expanded: boolean;
    ontoggle: () => void;
    children: Snippet;
  }

  let { id, title, description, summary, icon: Icon, expanded, ontoggle, children }: Props =
    $props();
</script>

<section id={`agent-group-${id}`} class="setting-group" data-group={id}>
  <button
    type="button"
    class="setting-group-header"
    aria-expanded={expanded}
    aria-controls={`agent-group-panel-${id}`}
    onclick={ontoggle}
  >
    <span class="setting-group-icon" aria-hidden="true"><Icon size={16} /></span>
    <span class="setting-group-text">
      <span class="setting-group-title">{title}</span>
      <span class="setting-group-description">{expanded ? description : (summary ?? description)}</span>
    </span>
    <ChevronRight size={16} class="setting-group-chevron {expanded ? 'rotate-90' : ''}" />
  </button>
  {#if expanded}
    <div id={`agent-group-panel-${id}`} class="setting-group-panel">
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .setting-group {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    background: var(--color-surface-1);
  }
  .setting-group-header {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 1rem;
    text-align: left;
    transition: background-color 150ms ease-out;
  }
  .setting-group-header:hover {
    background: var(--color-surface-2);
  }
  .setting-group-header:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
  .setting-group-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--color-text-muted);
  }
  .setting-group-text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
  }
  .setting-group-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .setting-group-description {
    margin-top: 0.15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .setting-group :global(.setting-group-chevron) {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 150ms ease-out;
  }
  .setting-group-panel {
    border-top: 1px solid var(--color-border);
  }
  .setting-group-panel > :global(* + *) {
    border-top: 1px solid var(--color-border);
  }
</style>
