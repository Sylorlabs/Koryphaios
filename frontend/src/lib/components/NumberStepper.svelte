<script lang="ts">
  import { Minus, Plus } from 'lucide-svelte';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    label: string;
    onchange: (value: number) => unknown | Promise<unknown>;
  }

  let { value, min, max, step = 1, label, onchange }: Props = $props();

  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const update = (delta: number) => onchange(clamp(value + delta));

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      void update(step);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      void update(-step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      void onchange(min);
    } else if (event.key === 'End') {
      event.preventDefault();
      void onchange(max);
    }
  }
</script>

<div
  class="flex h-12 w-full min-w-[170px] items-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-inner focus-within:ring-2 focus-within:ring-[var(--color-accent)]/40"
  role="spinbutton"
  tabindex="0"
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  onkeydown={handleKeydown}
>
  <button
    type="button"
    aria-label={`Decrease ${label}`}
    disabled={value <= min}
    onclick={() => update(-step)}
    class="flex h-full w-12 shrink-0 items-center justify-center border-r border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-25"
  >
    <Minus size={18} strokeWidth={2.25} />
  </button>
  <span class="flex min-w-0 flex-1 items-center justify-center px-3 text-base font-semibold tabular-nums text-[var(--color-text-primary)]">
    {value.toLocaleString()}
  </span>
  <button
    type="button"
    aria-label={`Increase ${label}`}
    disabled={value >= max}
    onclick={() => update(step)}
    class="flex h-full w-12 shrink-0 items-center justify-center border-l border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-25"
  >
    <Plus size={18} strokeWidth={2.25} />
  </button>
</div>
