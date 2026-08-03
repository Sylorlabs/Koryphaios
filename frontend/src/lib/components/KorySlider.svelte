<script lang="ts">
  let {
    id,
    label,
    value = $bindable(),
    min,
    max,
    step,
    unit = '',
    description,
  }: {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    description?: string;
  } = $props();

  let progress = $derived(((value - min) / (max - min)) * 100);
</script>

<div class="space-y-2">
  <div class="flex items-baseline justify-between gap-4">
    <label for={id} class="text-xs font-medium text-[var(--color-text-primary)]">{label}</label>
    <output for={id} class="font-mono text-xs text-[var(--color-accent)]">{value}{unit}</output>
  </div>
  {#if description}
    <p id={`${id}-description`} class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      {description}
    </p>
  {/if}
  <input
    {id}
    type="range"
    bind:value
    {min}
    {max}
    {step}
    aria-describedby={description ? `${id}-description` : undefined}
    style={`--slider-progress: ${progress}%`}
  />
  <div
    class="flex justify-between font-mono text-[10px] text-[var(--color-text-muted)]"
    aria-hidden="true"
  >
    <span>{min}{unit}</span>
    <span>{max}{unit}</span>
  </div>
</div>

<style>
  input[type='range'] {
    width: 100%;
    height: 18px;
    margin: 0;
    cursor: pointer;
    appearance: none;
    background: transparent;
  }

  input[type='range']::-webkit-slider-runnable-track {
    height: 6px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: linear-gradient(
      to right,
      var(--color-accent) 0 var(--slider-progress),
      var(--color-surface-3) var(--slider-progress) 100%
    );
  }

  input[type='range']::-moz-range-track {
    height: 6px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-surface-3);
  }

  input[type='range']::-moz-range-progress {
    height: 6px;
    border-radius: 999px;
    background: var(--color-accent);
  }

  input[type='range']::-webkit-slider-thumb {
    width: 18px;
    height: 18px;
    margin-top: -7px;
    appearance: none;
    border: 2px solid var(--color-surface-1);
    border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-border);
  }

  input[type='range']::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: 2px solid var(--color-surface-1);
    border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-border);
  }

  input[type='range']:focus-visible {
    outline: none;
  }

  input[type='range']:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 35%, transparent);
  }

  input[type='range']:focus-visible::-moz-range-thumb {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 35%, transparent);
  }
</style>
