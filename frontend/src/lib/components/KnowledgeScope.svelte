<script lang="ts">
  import MapPin from 'lucide-svelte/icons/map-pin';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Info from 'lucide-svelte/icons/info';
  import SettingsScopeBar from './settings/SettingsScopeBar.svelte';

  let {
    scope,
    description,
    compact = false,
  }: {
    scope: string;
    description: string;
    compact?: boolean;
  } = $props();

  // The project selector already names the concrete project. Keep the
  // expandable explanation at the category level so Notes does not say
  // "AsterBridge" twice in the same row (and Memory/Skills follow the same
  // rule for Personal, Session, and Workspace scopes).
  const scopeLabel = $derived(scope.split(' · ')[0] || scope);
  const showProjectSelector = $derived(scopeLabel !== 'Personal' && scopeLabel !== 'Session');
  const projectLabel = $derived(scopeLabel === 'Workspace' ? 'Workspace' : 'Project');
</script>

<div class="knowledge-scope-row" class:compact>
  {#if showProjectSelector}<SettingsScopeBar {compact} {projectLabel} />{/if}
  {#if showProjectSelector}
    <!-- The project selector beside this is the control that changes scope.
         This used to repeat "Project" as a second dotted-underline link that
         only expanded a paragraph, so it read as a navigation link that did
         nothing. With a selector present it is a plain disclosure icon. -->
    <details class="knowledge-scope icon-only" class:compact>
      <summary aria-label={`About ${scopeLabel} scope`} title={`About ${scopeLabel} scope`}>
        <Info size={13} /><ChevronDown size={12} />
      </summary>
      <p class="scope-explanation">{description}</p>
    </details>
  {:else}
    <details class="knowledge-scope" class:compact>
      <summary aria-label={`About ${scopeLabel}`}><MapPin size={13} /><span>{scopeLabel}</span><ChevronDown size={12} /></summary>
      <p class="scope-explanation">{description}</p>
    </details>
  {/if}
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
  .knowledge-scope { flex-shrink: 0; color: var(--color-text-muted); }
  .knowledge-scope.icon-only summary {
    gap: 3px;
    min-height: 24px;
    border-bottom: 0;
    color: var(--color-text-muted);
  }
  summary { display: flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%; min-height: 28px; font-size: 12px; cursor: pointer; list-style: none; border-radius: 4px; border-bottom: 1.5px dotted color-mix(in srgb, var(--color-text-secondary) 55%, transparent); padding-bottom: 1px; color: var(--color-text-primary); font-weight: 500; }
  summary span { overflow-wrap: anywhere; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { border-bottom-color: var(--color-text-primary); }
  summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 4px; }
  summary :global(svg) { flex-shrink: 0; color: var(--color-text-muted); }
  .knowledge-scope[open] summary :global(svg:last-child) { transform: rotate(180deg); }
  .scope-explanation { max-width: 72ch; margin-top: 8px; padding-bottom: 4px; font-size: 12px; line-height: 1.7; color: var(--color-text-secondary); }
  @media (max-width: 650px) {
    .knowledge-scope-row { padding: 0 16px 12px; }
  }
</style>
