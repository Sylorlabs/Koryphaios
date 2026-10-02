<script lang="ts">
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import { slide } from 'svelte/transition';

  let {
    open = false,
    label,
    meta = '',
    icon = undefined,
    children,
  } = $props<{
    open?: boolean;
    label: string;
    meta?: string;
    icon?: unknown;
    children: import('svelte').Snippet;
  }>();
</script>

<section class="feed-expandable border border-[var(--color-border)] bg-[var(--color-surface-1)]">
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-2)]"
    aria-expanded={open}
  >
    {#if open}
      <ChevronDown size={13} />
    {:else}
      <ChevronRight size={13} />
    {/if}
    {#if icon}{@render icon()}{/if}
    <span class="font-medium text-[var(--color-text-primary)]">{label}</span>
    {#if meta}<span class="ml-auto text-[var(--color-text-muted)]">{meta}</span>{/if}
  </button>
  {#if open}
    <div transition:slide={{ duration: 160 }} class="border-t border-[var(--color-border)]">
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .feed-expandable {
    border-radius: 3px;
    overflow: hidden;
  }
</style>
