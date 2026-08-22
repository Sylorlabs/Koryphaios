<script lang="ts">
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

  async function resize(direction: ResizeDirection, event: PointerEvent) {
    if (event.button !== 0 || !('__TAURI_INTERNALS__' in window)) return;
    event.preventDefault();
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  }
</script>

{#each directions as handle (handle.direction)}
  <div
    class={`window-resize-handle ${handle.className}`}
    aria-hidden="true"
    onpointerdown={(event) => void resize(handle.direction, event)}
  ></div>
{/each}

<style>
  .window-resize-handle {
    position: fixed;
    z-index: 2147483647;
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
