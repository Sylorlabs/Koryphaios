<script lang="ts">
  import {
    showsExecutionModeSelector,
    type ProviderExecutionCapabilities,
    type ProviderExecutionMode,
  } from '@koryphaios/shared';
  import KorySelect from './KorySelect.svelte';

  let {
    capabilities,
    value,
    onchange,
  }: {
    capabilities?: ProviderExecutionCapabilities;
    value?: ProviderExecutionMode;
    onchange?: (mode: ProviderExecutionMode) => unknown;
  } = $props();
  const options = $derived(
    (capabilities?.modes ?? []).map((mode) => ({
      value: mode.id,
      label: mode.id === 'local' ? 'Local · this machine' : 'Cloud · provider environment',
      description:
        mode.reason ??
        (mode.id === 'local'
          ? 'Workspace tools run locally; model inference may still be remote.'
          : 'Workspace work runs in a remote environment.'),
      disabled: !mode.available,
    })),
  );
  const reason = $derived(capabilities?.modes.find((mode) => !mode.available)?.reason);
</script>

{#if showsExecutionModeSelector(capabilities)}
  <div class="execution-modes" data-testid="provider-execution-modes">
    <KorySelect
      label="Execution location"
      value={value ?? capabilities!.defaultMode}
      {options}
      disabled={!onchange || !capabilities?.modes.some((mode) => mode.available)}
      onchange={(next) => onchange?.(next as ProviderExecutionMode)}
    />
    {#if reason}<p role="note">{reason}</p>{/if}
  </div>
{/if}

<style>
  .execution-modes {
    display: grid;
    gap: 8px;
  }
  p {
    color: var(--color-text-muted);
    font-size: 11px;
    line-height: 1.5;
  }
</style>
