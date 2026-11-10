<script lang="ts">
  import Minus from 'lucide-svelte/icons/minus';
  import Plus from 'lucide-svelte/icons/plus';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    decimals?: number;
    label: string;
    valueText?: string;
    onchange: (value: number) => unknown | Promise<unknown>;
    compact?: boolean;
    disabled?: boolean;
    unit?: string;
    quiet?: boolean;
  }

  let {
    value,
    min,
    max,
    step = 1,
    decimals,
    label,
    valueText,
    onchange,
    compact = false,
    disabled = false,
    unit = '',
    quiet = false,
  }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  const decimalPlaces = $derived(
    decimals ?? Math.max(0, (String(step).split('.')[1] ?? '').length),
  );
  const clamp = (next: number) => Number(Math.min(max, Math.max(min, next)).toFixed(decimalPlaces));

  $effect.pre(() => {
    if (!editing) draft = decimalPlaces > 0 ? value.toFixed(decimalPlaces) : String(value);
  });

  function setValue(next: number) {
    const bounded = clamp(next);
    draft = decimalPlaces > 0 ? bounded.toFixed(decimalPlaces) : String(bounded);
    void onchange(bounded);
  }

  function update(delta: number) {
    setValue(value + delta);
  }

  function commitDraft() {
    editing = false;
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed)) {
      draft = decimalPlaces > 0 ? value.toFixed(decimalPlaces) : String(value);
      return;
    }
    setValue(parsed);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      update(step);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      update(-step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setValue(min);
    } else if (event.key === 'End') {
      event.preventDefault();
      setValue(max);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
      (event.currentTarget as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editing = false;
      draft = decimalPlaces > 0 ? value.toFixed(decimalPlaces) : String(value);
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<div
  class="number-stepper flex w-full items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-inner focus-within:border-[var(--color-accent)] {compact
    ? 'h-10 min-w-0'
  : 'h-12 min-w-[170px]'}"
  class:quiet
>
  <button
    type="button"
    aria-label={`Decrease ${label}`}
    disabled={disabled || value <= min}
    onclick={() => update(-step)}
    class="flex h-full shrink-0 items-center justify-center border-r border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/65 disabled:cursor-not-allowed disabled:opacity-25 {compact
      ? 'w-9'
      : 'w-12'}"
  >
    <Minus size={compact ? 15 : 18} strokeWidth={2.25} />
  </button>
  <div class="relative flex h-full min-w-0 flex-1 items-center">
    <input
      type="text"
      inputmode={Number.isInteger(step) ? 'numeric' : 'decimal'}
      role="spinbutton"
      aria-label={label}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-valuemin={min}
      aria-valuemax={max}
      {disabled}
      bind:value={draft}
      onfocus={(event) => {
        editing = true;
        event.currentTarget.select();
      }}
      onblur={commitDraft}
      onkeydown={handleKeydown}
    class="stepper-value min-w-0 w-full flex-1 bg-transparent {unit ? 'pl-2 pr-10' : 'px-2'} text-center font-semibold tabular-nums text-[var(--color-text-primary)] !border-0 !outline-none !ring-0 !shadow-none focus:!border-0 focus:!outline-none focus:!ring-0 focus-visible:!border-0 focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!shadow-none disabled:cursor-not-allowed disabled:opacity-50 {compact
        ? 'text-sm'
        : 'text-base'}"
    />
    {#if unit}
      <span
        class="pointer-events-none absolute right-2 shrink-0 text-[10px] font-medium tracking-wide text-[var(--color-text-muted)]"
        aria-hidden="true">{unit}</span
      >
    {/if}
  </div>
  <button
    type="button"
    aria-label={`Increase ${label}`}
    disabled={disabled || value >= max}
    onclick={() => update(step)}
    class="flex h-full shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/65 disabled:cursor-not-allowed disabled:opacity-25 {compact
      ? 'w-9'
      : 'w-12'}"
  >
    <Plus size={compact ? 15 : 18} strokeWidth={2.25} />
  </button>
</div>

<style>
  /* The stepper owns the field surface. Settings-wide input styling must not
     paint a second, rounded textbox inside the composite control. */
  .number-stepper .stepper-value {
    height: 100%;
    margin: 0;
    border-radius: 0 !important;
    background: transparent !important;
  }
  .number-stepper.quiet { border-color: transparent; border-radius: 8px; background: var(--color-surface-2); box-shadow: none; }
  .number-stepper.quiet button { border-color: transparent; }
  .number-stepper.quiet:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
</style>
