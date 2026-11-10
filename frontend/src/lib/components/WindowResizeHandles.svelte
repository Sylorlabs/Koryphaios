<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';

  type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

  const directions: Array<{ direction: ResizeDirection; className: string }> = [
    { direction: 'North', className: 'north' },
    { direction: 'East', className: 'east' },
    { direction: 'South', className: 'south' },
    { direction: 'West', className: 'west' },
    { direction: 'NorthEast', className: 'north-east' },
    { direction: 'NorthWest', className: 'north-west' },
    { direction: 'SouthEast', className: 'south-east' },
    { direction: 'SouthWest', className: 'south-west' },
  ];

  // Handles only make sense inside the Tauri frameless window. In a plain
  // browser (dev server, demo build) they would be invisible dead zones that
  // swallow clicks along the viewport edges, so don't render them there.
  // `__TAURI_INTERNALS__` is injected before page scripts run, so this is
  // safe to check synchronously at component init.
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  // No async import/await before starting the native gesture. PointerEvent.buttons
  // is a snapshot, not a live indication that the button is still held later.
  const tauriWindow = inTauri ? getCurrentWindow() : null;

  let resizeActive = false;
  let expanded = $state(false);
  let expansionRequest = 0;
  let disposed = false;

  async function refreshExpansion() {
    if (!tauriWindow || disposed) return;
    const request = ++expansionRequest;
    try {
      const value = await invoke<boolean>('is_window_expanded');
      if (!disposed && request === expansionRequest) expanded = value;
    } catch (err) {
      console.warn('Window expansion state check failed:', err);
    }
  }

  onMount(() => {
    void refreshExpansion();
    return () => { disposed = true; };
  });

  async function resize(direction: ResizeDirection, event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || !(event.buttons & 1) || !tauriWindow || expanded || resizeActive) return;
    // Must happen before any await, or the browser starts a text selection /
    // scroll alongside the native resize.
    event.preventDefault();
    event.stopPropagation();
    resizeActive = true;
    try {
      await tauriWindow.startResizeDragging(direction);
    } catch (err) {
      console.warn('Window resize drag failed:', err);
    } finally {
      resizeActive = false;
    }
  }
</script>

<!-- OS fullscreen/restore and titlebar double-clicks also change this state. -->
<svelte:window onresize={refreshExpansion} onfocus={refreshExpansion} />

{#if tauriWindow && !expanded}
  {#each directions as handle (handle.direction)}
    <div
      class={`window-resize-handle ${handle.className}`}
      aria-hidden="true"
      onpointerdown={(event) => void resize(handle.direction, event)}
    ></div>
  {/each}
{/if}

<style>
  .window-resize-handle {
    position: fixed;
    z-index: 2147483647;
    touch-action: none;
    user-select: none;
  }
  .north,
  .south {
    right: 8px;
    left: 8px;
    height: 6px;
    cursor: ns-resize;
  }
  .east,
  .west {
    top: 8px;
    bottom: 8px;
    width: 6px;
    cursor: ew-resize;
  }
  .north { top: 0; }
  .east { right: 0; }
  .south { bottom: 0; }
  .west { left: 0; }
  .north-east,
  .north-west,
  .south-east,
  .south-west {
    width: 10px;
    height: 10px;
  }
  .north-east { top: 0; right: 0; cursor: nesw-resize; }
  .north-west { top: 0; left: 0; cursor: nwse-resize; }
  .south-east { right: 0; bottom: 0; cursor: nwse-resize; }
  .south-west { bottom: 0; left: 0; cursor: nesw-resize; }
</style>
