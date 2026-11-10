import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WindowResizeHandles from './WindowResizeHandles.svelte';

const native = vi.hoisted(() => ({
  startResizeDragging: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

function press(element: Element, init: PointerEventInit = {}) {
  const event = new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    button: 0, buttons: 1, ...init,
  });
  element.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  native.invoke.mockResolvedValue(false);
  native.startResizeDragging.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('native window resize handles', () => {
  it('does not create edge dead zones in a browser', () => {
    vi.unstubAllGlobals();
    const { container } = render(WindowResizeHandles);
    expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['north', 'North'], ['east', 'East'], ['south', 'South'], ['west', 'West'],
    ['north-east', 'NorthEast'], ['north-west', 'NorthWest'],
    ['south-east', 'SouthEast'], ['south-west', 'SouthWest'],
  ])('starts %s resizing in the pointerdown turn, before release can race it', (edge, direction) => {
    const { container } = render(WindowResizeHandles);
    const event = press(container.querySelector(`.${edge}`)!);
    // No await: yielding here can hand a released gesture to the native window.
    expect(native.startResizeDragging).toHaveBeenCalledWith(direction);
    expect(event.defaultPrevented).toBe(true);
  });

  it('consumes a resize gesture instead of also handing it to document drag handlers', () => {
    const bubble = vi.fn();
    document.addEventListener('pointerdown', bubble);
    try {
      const { container } = render(WindowResizeHandles);
      press(container.querySelector('.south')!);
      expect(bubble).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('pointerdown', bubble);
    }
  });

  it.each([{ button: 2, buttons: 2 }, { isPrimary: false }, { buttons: 0 }])(
    'ignores non-resize input %j', async (input) => {
      const { container } = render(WindowResizeHandles);
      press(container.querySelector('.south')!, input);
      await tick();
      expect(native.startResizeDragging).not.toHaveBeenCalled();
    },
  );

  it('removes hitboxes when expanded and restores them after an OS resize or focus change', async () => {
    native.invoke.mockResolvedValue(true);
    const { container } = render(WindowResizeHandles);
    await waitFor(() => expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0));
    native.invoke.mockResolvedValue(false);
    await fireEvent.resize(window);
    await waitFor(() => expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(8));
    native.invoke.mockResolvedValue(true);
    await fireEvent.focus(window);
    await waitFor(() => expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0));
  });

  it('does not let a stale expansion query re-enable hitboxes', async () => {
    let resolveInitial!: (value: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveInitial = resolve; }));
    const { container } = render(WindowResizeHandles);
    await waitFor(() => expect(native.invoke).toHaveBeenCalled());
    native.invoke.mockResolvedValue(true);
    await fireEvent.resize(window);
    await waitFor(() => expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0));
    resolveInitial(false);
    await tick();
    expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0);
  });

  it('does not overlap native resize requests, then allows the next gesture', async () => {
    let finish!: () => void;
    native.startResizeDragging.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = render(WindowResizeHandles);
    press(container.querySelector('.south')!);
    press(container.querySelector('.east')!);
    expect(native.startResizeDragging).toHaveBeenCalledTimes(1);
    finish();
    await tick();
    press(container.querySelector('.east')!);
    expect(native.startResizeDragging).toHaveBeenCalledTimes(2);
  });

  it('stops querying expansion after unmount, including a pending initial query', async () => {
    let resolveInitial!: (value: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveInitial = resolve; }));
    const { container, unmount } = render(WindowResizeHandles);
    await waitFor(() => expect(native.invoke).toHaveBeenCalled());
    unmount();
    native.invoke.mockClear();
    resolveInitial(false);
    await fireEvent.resize(window);
    await fireEvent.focus(window);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.window-resize-handle')).toHaveLength(0);
  });

  it('allows another grab after a failed native resize', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    native.startResizeDragging.mockRejectedValueOnce(new Error('resize refused'));
    try {
      const { container } = render(WindowResizeHandles);
      press(container.querySelector('.south')!);
      await waitFor(() => expect(warning).toHaveBeenCalled());
      press(container.querySelector('.east')!);
      await waitFor(() => expect(native.startResizeDragging).toHaveBeenCalledTimes(2));
    } finally {
      warning.mockRestore();
    }
  });
});
