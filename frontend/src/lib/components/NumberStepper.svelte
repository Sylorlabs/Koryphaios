<script lang="ts">
  import Minus from 'lucide-svelte/icons/minus';
  import Plus from 'lucide-svelte/icons/plus';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    valueText?: string;
    onchange: (value: number) => unknown | Promise<unknown>;
    compact?: boolean;
    disabled?: boolean;
  }

  let {
    value,
    min,
    max,
    step = 1,
    label,
    valueText,
    onchange,
    compact = false,
    disabled = false,
  }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  const decimalPlaces = $derived(Math.max(0, (String(step).split('.')[1] ?? '').length));
  const clamp = (next: number) => Number(Math.min(max, Math.max(min, next)).toFixed(decimalPlaces));

  $effect.pre(() => {
    if (!editing) draft = String(value);
  });

  function setValue(next: number) {
    const bounded = clamp(next);
    draft = String(bounded);
    void onchange(bounded);
  }

  function update(delta: number) {
    setValue(value + delta);
  }

  function commitDraft() {
    editing = false;
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed)) {
      draft = String(value);
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
      draft = String(value);
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<div
  class="flex w-full items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-inner focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)]/45 {compact
    ? 'h-10 min-w-0'
    : 'h-12 min-w-[170px]'}"
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
    class="min-w-0 flex-1 bg-transparent px-1 text-center font-semibold tabular-nums text-[var(--color-text-primary)] outline-none disabled:cursor-not-allowed disabled:opacity-50 {compact
      ? 'text-sm'
      : 'text-base'}"
  />
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
