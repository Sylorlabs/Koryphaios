<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
    content?: string;
    class?: string;
  }

  let {
    children,
    content = '',
    class: className = '',
  }: Props = $props();

  let show = $state(false);
  let tooltipEl: HTMLDivElement | undefined = $state();
</script>

<span class="relative inline-block">
  <span
    role="button"
    tabindex="0"
    onmouseenter={() => show = true}
    onmouseleave={() => show = false}
    onfocus={() => show = true}
    onblur={() => show = false}
  >
    {#if children}
      {@render children()}
    {/if}
  </span>
  
  {#if show && content}
    <div
      bind:this={tooltipEl}
      class="absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 {className}"
      role="tooltip"
    >
      {content}
    </div>
  {/if}
</span>
