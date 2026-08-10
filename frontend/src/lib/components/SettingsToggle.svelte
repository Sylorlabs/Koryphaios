<script lang="ts">
  interface Props {
    checked?: boolean;
    onchange?: () => void;
    id?: string;
    disabled?: boolean;
    label?: string;
  }

  let {
    checked = false,
    onchange,
    id,
    disabled = false,
    label = 'Toggle setting',
  }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  {id}
  aria-label={label}
  aria-checked={checked}
  {disabled}
  onclick={() => onchange?.()}
  class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-1)] disabled:cursor-not-allowed disabled:opacity-50"
  style="border-color: {checked
    ? 'var(--color-accent)'
    : 'var(--color-border-bright)'}; background: {checked
    ? 'var(--color-accent)'
    : 'var(--color-surface-4)'};"
>
  <span
    aria-hidden="true"
    class="h-5 w-5 rounded-full bg-[var(--color-switch-thumb)] shadow-sm transition-transform duration-200"
    style="transform: translateX({checked ? '20px' : '1px'});"
  ></span>
</button>
