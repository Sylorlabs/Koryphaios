<script lang="ts">
  interface Props {
    checked: boolean;
    label: string;
    description: string;
    onchange: () => void | Promise<void>;
    compact?: boolean;
  }

  let { checked, label, description, onchange, compact = false }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  onclick={onchange}
  class="group flex w-full items-start justify-between gap-4 rounded-xl border text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {compact ? 'p-3' : 'p-4'}"
  style="border-color: {checked ? 'color-mix(in srgb, var(--color-accent) 42%, var(--color-border))' : 'var(--color-border)'}; background: {checked ? 'color-mix(in srgb, var(--color-accent) 7%, var(--color-surface-2))' : 'var(--color-surface-2)'};"
>
  <span class="min-w-0">
    <span class="block text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
    <span class="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">{description}</span>
  </span>
  <span
    class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-all duration-200"
    style="border-color: {checked ? 'var(--color-accent)' : 'var(--color-border)'}; background: {checked ? 'var(--color-accent)' : 'var(--color-surface-4)'}; box-shadow: {checked ? '0 0 0 3px color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'none'};"
    aria-hidden="true"
  >
    <span
      class="h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
      style="transform: translateX({checked ? '22px' : '3px'});"
    ></span>
  </span>
</button>
