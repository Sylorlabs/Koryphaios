<script lang="ts">
  import { CRITIC_MODE_OPTIONS, type CriticMode } from '@koryphaios/shared';
  import KorySelect from './KorySelect.svelte';

  /** Words shown on a collapsed composer trigger; the menu keeps the full labels. */
  const SHORT_LABELS: Record<CriticMode, string> = { off: 'Off', auto: 'Auto', always: 'On' };

  let {
    value,
    onchange,
    compact = false,
    flat = false,
    disabled = false,
    shortLabels = false,
  }: {
    value: CriticMode;
    onchange: (mode: CriticMode) => unknown;
    compact?: boolean;
    flat?: boolean;
    disabled?: boolean;
    shortLabels?: boolean;
  } = $props();
</script>

<div
  class="flex items-center gap-2 rounded-md"
  class:composer-critic-control={shortLabels}
  data-testid={shortLabels ? 'composer-critic-control' : undefined}
>
  {#if !compact}
    <span class="text-xs font-semibold" style:color="var(--color-text-secondary)">Critic</span>
  {/if}
  <KorySelect
    label="Critic mode"
    {value}
    {compact}
    {flat}
    dense={flat}
    {disabled}
    options={CRITIC_MODE_OPTIONS.map((option) => ({
      ...option,
      label: compact ? `Critic: ${option.label}` : option.label,
      ...(shortLabels ? { shortLabel: SHORT_LABELS[option.value] } : {}),
    }))}
    onchange={(mode) => onchange(mode as CriticMode)}
  />
</div>
