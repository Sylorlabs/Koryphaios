<script lang="ts">
  interface Props {
    checked: boolean;
    size?: 'sm' | 'md' | 'lg';
  }

  let { checked, size = 'md' }: Props = $props();

  const sizeClasses = {
    sm: 'w-8 h-4',
    md: 'w-11 h-6',
    lg: 'w-14 h-8'
  };

  const thumbClasses = {
    sm: 'w-3 h-3 translate-x-0.5',
    md: 'w-5 h-5 translate-x-0.5',
    lg: 'w-6 h-6 translate-x-1'
  };

  const thumbCheckedClasses = {
    sm: 'translate-x-4',
    md: 'translate-x-5',
    lg: 'translate-x-6'
  };
</script>

<div
  class="relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out {sizeClasses[size]} {checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-surface-4)]'}"
  aria-checked={checked}
  role="switch"
>
  <span
    class="inline-block bg-white rounded-full shadow-sm transition-transform duration-200 ease-in-out {thumbClasses[size]} {checked ? thumbCheckedClasses[size] : ''}"
  ></span>
</div>
