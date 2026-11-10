<script lang="ts">
  import { CRITIC_MODE_OPTIONS, type CriticMode } from '@koryphaios/shared';
  import KorySelect from './KorySelect.svelte';

  let { value, onchange, compact = false, flat = false, disabled = false }: {
    value: CriticMode;
    onchange: (mode: CriticMode) => unknown;
    compact?: boolean;
    flat?: boolean;
    disabled?: boolean;
  } = $props();
</script>

<div class="flex items-center gap-2 rounded-md">
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
    options={CRITIC_MODE_OPTIONS.map((option) => ({ ...option, label: compact ? `Critic: ${option.label}` : option.label }))}
    onchange={(mode) => onchange(mode as CriticMode)}
  />
</div>
