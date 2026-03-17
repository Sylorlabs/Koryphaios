<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
    variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'info' | 'accent' | 'warning';
    size?: 'default' | 'sm';
    class?: string;
  }

  let {
    children,
    variant = 'default',
    size = 'default',
    class: className = '',
  }: Props = $props();

  const variantClasses = {
    default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
    secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
    destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
    outline: 'text-foreground',
    info: 'border-transparent bg-blue-500 text-white hover:bg-blue-500/80',
    accent: 'border-transparent bg-accent text-accent-foreground hover:bg-accent/80',
    warning: 'border-transparent bg-yellow-500 text-white hover:bg-yellow-500/80',
  };

  const sizeClasses = {
    default: 'px-2.5 py-0.5 text-xs',
    sm: 'px-1.5 py-0.5 text-[10px]',
  };
</script>

<span class="inline-flex items-center rounded-full border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 {variantClasses[variant]} {sizeClasses[size]} {className}">
  {#if children}
    {@render children()}
  {/if}
</span>
