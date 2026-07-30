<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description: string;
    children?: Snippet;
  }

  let { title, description, children }: Props = $props();
</script>

<div class="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h3>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {@render children?.()}
    </div>
  </div>
</div>
