<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    direction?: 'horizontal' | 'vertical';
    initialSize?: number;
    minSize?: number;
    maxSize?: number;
    children?: import('svelte').Snippet;
    first?: import('svelte').Snippet;
    second?: import('svelte').Snippet;
  }

  let {
    direction = 'horizontal',
    initialSize = 50,
    minSize = 20,
    maxSize = 80,
    first,
    second,
  }: Props = $props();

  let container: HTMLDivElement;
  let firstPane: HTMLDivElement;
  let isResizing = $state(false);
  let size = $state(50);

  $effect(() => {
    size = initialSize;
  });

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isResizing || !container) return;

    const rect = container.getBoundingClientRect();

    if (direction === 'horizontal') {
      const newSize = ((e.clientX - rect.left) / rect.width) * 100;
      size = Math.min(maxSize, Math.max(minSize, newSize));
    } else {
      const newSize = ((e.clientY - rect.top) / rect.height) * 100;
      size = Math.min(maxSize, Math.max(minSize, newSize));
    }
  }

  function handleMouseUp() {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  onMount(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  });
</script>

<div
  bind:this={container}
  class="split-pane {direction === 'horizontal' ? 'split-pane-horizontal' : 'split-pane-vertical'}"
>
  <div
    bind:this={firstPane}
    class="pane"
    style="{direction === 'horizontal' ? `width: ${size}%` : `height: ${size}%`}"
  >
    {#if first}
      {@render first()}
    {/if}
  </div>

  <button
    type="button"
    class="pane-resizer pane-resizer-{direction} {isResizing ? 'active' : ''}"
    style="padding: 0; border: 0; background: transparent;"
    onmousedown={handleMouseDown}
    aria-label="Resize panel"
  ></button>

  <div
    class="pane"
    style="{direction === 'horizontal' ? `width: ${100 - size}%` : `height: ${100 - size}%`}"
  >
    {#if second}
      {@render second()}
    {/if}
  </div>
</div>
