<script lang="ts">
  /**
   * One single-select card group. Every permission/autonomy decision in Agent
   * behavior uses this so the indicator, hover, focus ring and selection
   * animation are identical across sections.
   */
  export interface ChoiceCardOption {
    value: string;
    label: string;
    description?: string;
  }

  interface Props {
    label: string;
    value: string;
    options: ChoiceCardOption[];
    onchange: (value: string) => void | Promise<unknown>;
    /** Tailwind grid-columns classes for the card row. */
    columns?: string;
    disabled?: boolean;
  }

  let {
    label,
    value,
    options,
    onchange,
    columns = 'sm:grid-cols-2 xl:grid-cols-3',
    disabled = false,
  }: Props = $props();
</script>

<div
  class="grid grid-cols-1 items-stretch gap-2 {columns}"
  role="radiogroup"
  aria-label={label}
  aria-disabled={disabled}
>
  {#each options as option (option.value)}
    {@const active = value === option.value}
    <button
      type="button"
      role="radio"
      aria-checked={active}
      {disabled}
      onclick={() => {
        if (!active) void onchange(option.value);
      }}
      class="group flex h-full flex-col rounded-xl border p-3 text-left transition-[background-color,border-color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/55 disabled:cursor-not-allowed disabled:opacity-55 {active
        ? 'border-[var(--color-accent)]/60 bg-[var(--color-surface-3)]'
        : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)] hover:bg-[var(--color-surface-3)]'}"
    >
      <span class="flex items-start justify-between gap-2">
        <span class="text-[13px] font-semibold leading-tight text-[var(--color-text-primary)]"
          >{option.label}</span
        >
        <span
          class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 {active
            ? 'border-[var(--color-accent)]'
            : 'border-[var(--color-border-bright)] group-hover:border-[var(--color-text-muted)]'}"
          aria-hidden="true"
        >
          <span
            class="h-2 w-2 rounded-full bg-[var(--color-accent)] transition-transform duration-150 ease-out {active
              ? 'scale-100'
              : 'scale-0'}"
          ></span>
        </span>
      </span>
      {#if option.description}
        <span class="mt-1.5 block text-[11px] leading-relaxed text-[var(--color-text-muted)]"
          >{option.description}</span
        >
      {/if}
    </button>
  {/each}
</div>
