<script lang="ts">
  import MapPin from 'lucide-svelte/icons/map-pin';
  import Info from 'lucide-svelte/icons/info';
  import SettingsScopeBar from './settings/SettingsScopeBar.svelte';

  let {
    scope,
    description,
    compact = false,
    showProjectName = false,
  }: {
    scope: string;
    description: string;
    compact?: boolean;
    /** Show the concrete project name in the selector instead of the scope word. */
    showProjectName?: boolean;
  } = $props();

  // The project selector already names the concrete project. Keep the
  // explanation at the category level so Notes does not say "AsterBridge"
  // twice in the same row (and Memory/Skills follow the same rule for
  // Personal, Session, and Workspace scopes).
  const scopeLabel = $derived(scope.split(' · ')[0] || scope);
  const showProjectSelector = $derived(scopeLabel !== 'Personal' && scopeLabel !== 'Session');
  const projectLabel = $derived(scopeLabel === 'Workspace' ? 'Workspace' : 'Project');
</script>

<div class="knowledge-scope-row" class:compact>
  {#if showProjectSelector}
    <SettingsScopeBar {compact} {projectLabel} {showProjectName} />
  {:else}
    <span class="scope-marker"><MapPin size={13} /><span>{scopeLabel}</span></span>
  {/if}
  <!-- The scope explanation is reference text, not an action: it opens on
       hover through the global tooltip rather than a disclosure that needs a
       click to discover. `role="img"` + `aria-label` keeps the same text
       available to assistive tech that never triggers the tooltip. -->
  <span class="scope-info" role="img" aria-label={description} data-kory-tooltip={description}>
    <Info size={13} />
  </span>
</div>

<style>
  .knowledge-scope-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    flex-shrink: 0;
    padding: 0 24px 14px;
    color: var(--color-text-muted);
  }
  .knowledge-scope-row.compact {
    padding: 0;
  }
  .scope-marker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-primary);
  }
  .scope-marker :global(svg) {
    flex-shrink: 0;
    color: var(--color-text-muted);
  }
  .scope-marker span {
    overflow-wrap: anywhere;
  }
  .scope-info {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    flex-shrink: 0;
    border-radius: 4px;
    color: var(--color-text-muted);
    cursor: help;
  }
  .scope-info:hover {
    color: var(--color-text-primary);
  }
  @media (max-width: 650px) {
    .knowledge-scope-row {
      padding: 0 16px 12px;
    }
  }
</style>
