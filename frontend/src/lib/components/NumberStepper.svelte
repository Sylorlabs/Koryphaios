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

  // ── Direct text input mode ──
  // Click the number to type a custom value; Enter/blur commits, Esc cancels.
  let editing = $state(false);
  let draft = $state('');
  let inputEl = $state<HTMLInputElement>();

  function startEdit() {
    draft = String(value);
    editing = true;
    // Focus after the input renders
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  function commitEdit() {
    editing = false;
    const parsed = parseInt(draft, 10);
    if (!Number.isNaN(parsed)) {
      void onchange(clamp(parsed));
    }
  }

  function cancelEdit() {
    editing = false;
  }

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

  {#if editing}
    <input
      bind:this={inputEl}
      type="number"
      {min}
      {max}
      bind:value={draft}
      onkeydown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      }}
      onblur={commitEdit}
      class="min-w-0 flex-1 bg-transparent text-center text-base font-semibold tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      style="color: var(--color-text-primary);"
      aria-label={label}
    />
  {:else}
    <button
      type="button"
      onclick={startEdit}
      class="flex min-w-0 flex-1 items-center justify-center px-3 text-base font-semibold tabular-nums text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)]"
      title="Click to type a custom value"
      aria-label={`Edit ${label}`}
    >
      {value.toLocaleString()}
    </button>
  {/if}

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
