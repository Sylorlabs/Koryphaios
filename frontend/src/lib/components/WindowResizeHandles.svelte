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

  // Handles only make sense inside the Tauri frameless window. In a plain
  // browser (dev server, demo build) they would be invisible dead zones that
  // swallow clicks along the viewport edges, so don't render them there.
  // `__TAURI_INTERNALS__` is injected before page scripts run, so this is
  // safe to check synchronously at component init.
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  // Resolve the Tauri window handle once, up front. Importing lazily inside
  // the pointerdown handler delayed `startResizeDragging` by a round trip,
  // which made every first grab feel dead.
  const tauriWindow: Promise<import('@tauri-apps/api/window').Window> | null = inTauri
    ? import('@tauri-apps/api/window').then((m) => m.getCurrentWindow())
    : null;

  let resizeActive = false;

  async function resize(direction: ResizeDirection, event: PointerEvent) {
    if (event.button !== 0 || !tauriWindow || resizeActive) return;
    // Must happen before any await, or the browser starts a text selection /
    // scroll alongside the native resize.
    event.preventDefault();
    resizeActive = true;
    try {
      const win = await tauriWindow;
      // If the pointer was released during the IPC round trip, a native
      // resize would start with no button held and never stop until the next
      // click — the classic "stuck resize". Bail instead.
      if (event.buttons & 1) {
        await win.startResizeDragging(direction);
      }
    } catch (err) {
      console.warn('Window resize drag failed:', err);
    } finally {
      resizeActive = false;
    }
  }
</script>

{#if tauriWindow}
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
