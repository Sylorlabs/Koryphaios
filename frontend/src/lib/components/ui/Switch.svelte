<script lang="ts">
  interface Props {
    checked?: boolean;
    disabled?: boolean;
    class?: string;
    id?: string;
    ariaLabel?: string;
    onCheckedChange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(false),
    disabled = false,
    class: className = '',
    id,
    ariaLabel = 'Toggle setting',
    onCheckedChange,
  }: Props = $props();

  function handleChange(e: Event) {
    const target = e.target as HTMLInputElement;
    checked = target.checked;
    onCheckedChange?.(checked);
  }
</script>

<button
  {id}
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {disabled}
  class="peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 {checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-4)]'} {className}"
  data-state={checked ? 'checked' : 'unchecked'}
  onclick={() => {
    if (!disabled) {
      checked = !checked;
      onCheckedChange?.(checked);
    }
  }}
>
  <span
    class="pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
    data-state={checked ? 'checked' : 'unchecked'}
  ></span>
</button>
