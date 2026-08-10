<script lang="ts">
  interface Props {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onchange: (value: number) => unknown | Promise<unknown>;
    unit?: string;
    description?: string;
    displayValue?: string;
    valueText?: string;
    disabled?: boolean;
  }

  let {
    id,
    label,
    value,
    min,
    max,
    step,
    onchange,
    unit = '',
    description,
    displayValue,
    valueText,
    disabled = false,
  }: Props = $props();

  let slider = $state<HTMLDivElement>();
  let draggingPointerId = $state<number | null>(null);
  let percentage = $derived(
    max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0,
  );
  let renderedValue = $derived(displayValue ?? `${value}${unit}`);
  let accessibleValue = $derived(valueText ?? renderedValue);

  function decimalPlaces(input: number): number {
    const text = String(input).toLowerCase();
    if (text.includes('e-')) return Number(text.split('e-')[1]) || 0;
    return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
  }

  function normalize(next: number): number {
    if (!Number.isFinite(next)) return value;
    const clamped = Math.min(max, Math.max(min, next));
    if (!(step > 0)) return clamped;
    const snapped = min + Math.round((clamped - min) / step) * step;
    const precision = Math.min(
      12,
      Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step)),
    );
    return Math.min(max, Math.max(min, Number(snapped.toFixed(precision))));
  }

  function commit(next: number) {
    if (disabled) return;
    const normalized = normalize(next);
    if (normalized === value) return;
    void onchange(normalized);
  }

  function updateFromPointer(event: PointerEvent) {
    if (!slider) return;
    const bounds = slider.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    commit(min + ratio * (max - min));
  }

  function handlePointerDown(event: PointerEvent) {
    if (disabled || !slider) return;
    event.preventDefault();
    slider.focus();
    draggingPointerId = event.pointerId;
    slider.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  }

  function handlePointerMove(event: PointerEvent) {
    if (event.pointerId !== draggingPointerId) return;
    updateFromPointer(event);
  }

  function finishPointer(event: PointerEvent) {
    if (event.pointerId !== draggingPointerId || !slider) return;
    updateFromPointer(event);
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    draggingPointerId = null;
  }

  function cancelPointer(event: PointerEvent) {
    if (event.pointerId !== draggingPointerId || !slider) return;
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    draggingPointerId = null;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (disabled) return;
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = value + step;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = value - step;
    else if (event.key === 'PageUp') next = value + step * 10;
    else if (event.key === 'PageDown') next = value - step * 10;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    commit(next);
  }
</script>

<div class="space-y-2">
  <div class="flex items-baseline justify-between gap-4">
    <span id={`${id}-label`} class="text-xs font-medium text-[var(--color-text-primary)]"
      >{label}</span
    >
    <output class="font-mono text-xs tabular-nums text-[var(--color-accent)]"
      >{renderedValue}</output
    >
  </div>
  {#if description}
    <p id={`${id}-description`} class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
      {description}
    </p>
  {/if}
  <div
    bind:this={slider}
    {id}
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-labelledby={`${id}-label`}
    aria-describedby={description ? `${id}-description` : undefined}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={accessibleValue}
    aria-orientation="horizontal"
    aria-disabled={disabled}
    class="relative flex h-8 w-full touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-1)] {disabled
      ? 'cursor-not-allowed opacity-50'
      : 'cursor-pointer'}"
    onkeydown={handleKeydown}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={finishPointer}
    onpointercancel={cancelPointer}
  >
    <span
      class="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-3)]"
      aria-hidden="true"
    >
      <span class="block h-full bg-[var(--color-accent)]" style={`width: ${percentage}%`}></span>
    </span>
    <span
      class="pointer-events-none absolute h-[18px] w-[18px] -translate-x-1/2 rounded-full border-2 border-[var(--color-surface-1)] bg-[var(--color-accent)]"
      style={`left: ${percentage}%; box-shadow: 0 0 0 1px var(--color-border)`}
      aria-hidden="true"
    ></span>
  </div>
  <div
    class="flex justify-between font-mono text-[10px] text-[var(--color-text-muted)]"
    aria-hidden="true"
  >
    <span>{min}{unit}</span>
    <span>{max}{unit}</span>
  </div>
</div>
