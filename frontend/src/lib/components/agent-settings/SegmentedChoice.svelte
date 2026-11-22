<script lang="ts">
  /**
   * Compact single-select row used for the Agent behavior essentials. One line
   * of options; the selected option's explanation is shown underneath so the
   * choice stays understandable without a wall of cards.
   */
  export interface SegmentedOption {
    value: string;
    label: string;
    description?: string;
  }

  interface Props {
    label: string;
    value: string;
    options: SegmentedOption[];
    onchange: (value: string) => void | Promise<unknown>;
    disabled?: boolean;
    /** Hide the selected option's description line. */
    hideDescription?: boolean;
  }

  let { label, value, options, onchange, disabled = false, hideDescription = false }: Props =
    $props();

  let selected = $derived(options.find((option) => option.value === value));
</script>

<div class="segmented-choice">
  <div class="segmented-track" role="radiogroup" aria-label={label} aria-disabled={disabled}>
    {#each options as option (option.value)}
      {@const active = value === option.value}
      <button
        type="button"
        role="radio"
        aria-checked={active}
        title={option.description}
        {disabled}
        class="segmented-option"
        class:active
        onclick={() => {
          if (!active) void onchange(option.value);
        }}>{option.label}</button
      >
    {/each}
  </div>
  {#if !hideDescription && selected?.description}
    <p class="segmented-hint">{selected.description}</p>
  {/if}
</div>

<style>
  .segmented-choice {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.4rem;
  }
  .segmented-track {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.125rem;
    align-self: flex-start;
    border-radius: 0.6rem;
    background: var(--color-surface-3);
    padding: 0.125rem;
  }
  .segmented-option {
    border-radius: 0.45rem;
    padding: 0.3rem 0.7rem;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out;
  }
  .segmented-option:hover:not(:disabled):not(.active) {
    background: color-mix(in srgb, var(--color-surface-1) 60%, transparent);
    color: var(--color-text-secondary);
  }
  .segmented-option.active {
    background: var(--color-surface-1);
    color: var(--color-text-primary);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent);
  }
  .segmented-option:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
  .segmented-option:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .segmented-hint {
    margin: 0;
    max-width: 30rem;
    font-size: 11px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
</style>
