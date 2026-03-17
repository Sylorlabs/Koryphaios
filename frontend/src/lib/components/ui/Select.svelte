<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    value?: string;
    disabled?: boolean;
    class?: string;
    id?: string;
    children?: Snippet;
    onchange?: (e: Event) => void;
  }

  let {
    value = $bindable(''),
    disabled = false,
    class: className = '',
    id,
    children,
    onchange,
  }: Props = $props();
</script>

<select
  {id}
  bind:value
  {disabled}
  {onchange}
  class="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 {className}"
>
  {#if children}
    {@render children()}
  {/if}
</select>
