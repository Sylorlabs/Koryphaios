<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The one layout for a settings page: a centered column whose title,
   * description, actions and body all share a single left edge.
   *
   * - `narrow` — single-column forms (760px content).
   * - `wide` — grids and two-column layouts (1080px content).
   * - `full` — dashboards that need the whole pane; keeps the same padding.
   */
  interface Props {
    title: string;
    description?: string;
    width?: 'narrow' | 'wide' | 'full';
    /** Right-aligned header controls (refresh, reset, primary action). */
    actions?: Snippet;
    /** Under the description: scope pickers, status pills. */
    meta?: Snippet;
    children: Snippet;
  }

  let { title, description, width = 'narrow', actions, meta, children }: Props = $props();

  const uid = $props.id();
  const headingId = `settings-page-${uid}`;
</script>

<section class="settings-page" data-width={width} aria-labelledby={headingId}>
  <header class="settings-page-header">
    <div class="settings-page-heading">
      <h2 id={headingId}>{title}</h2>
      {#if description}<p>{description}</p>{/if}
      {#if meta}<div class="settings-page-meta">{@render meta()}</div>{/if}
    </div>
    {#if actions}<div class="settings-page-actions">{@render actions()}</div>{/if}
  </header>
  <div class="settings-page-body">{@render children()}</div>
</section>

<style>
  .settings-page {
    --settings-page-max: 760px;
    width: 100%;
    max-width: calc(var(--settings-page-max) + 64px);
    margin: 0 auto;
    padding: 28px 32px 48px;
    min-width: 0;
  }
  .settings-page[data-width='wide'] {
    --settings-page-max: 1080px;
  }
  .settings-page[data-width='full'] {
    max-width: none;
  }
  .settings-page-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 24px;
    margin-bottom: 28px;
  }
  .settings-page-heading {
    min-width: 0;
    flex: 1 1 320px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    line-height: 1.3;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .settings-page-heading > p {
    margin: 4px 0 0;
    max-width: 64ch;
    font-size: 13px;
    line-height: 1.55;
    color: var(--color-text-muted);
  }
  .settings-page-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .settings-page-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .settings-page-body {
    display: flex;
    flex-direction: column;
    gap: 32px;
    min-width: 0;
  }
  @media (max-width: 640px) {
    .settings-page {
      padding: 20px 16px 32px;
    }
    .settings-page-header {
      margin-bottom: 20px;
    }
    .settings-page-body {
      gap: 24px;
    }
  }
</style>
