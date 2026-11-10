// @vitest-environment happy-dom
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from './VirtualList.svelte';

type ObserverRecord = { callback: ResizeObserverCallback; elements: Element[] };
let observers: ObserverRecord[] = [];
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

class ResizeObserverStub {
  private record: ObserverRecord;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, elements: [] };
    observers.push(this.record);
  }
  observe(element: Element) { this.record.elements.push(element); }
  unobserve() {}
  disconnect() {}
}

function observerFor(element: Element): ObserverRecord {
  const record = observers.find((candidate) => candidate.elements.includes(element));
  if (!record) throw new Error('no ResizeObserver is watching this element');
  return record;
}

function measure(element: Element, height: number) {
  observerFor(element).callback(
    [{ target: element, borderBoxSize: [{ blockSize: height }], contentRect: { height } }] as unknown as ResizeObserverEntry[],
    {} as ResizeObserver,
  );
}

function rows() {
  return Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}` }));
}

describe('VirtualList opening behavior', () => {
  beforeEach(() => {
    observers = [];
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens at the current bottom without a deferred landing loop', () => {
    const { container } = render(VirtualList, {
      props: { items: rows(), estimateHeight: () => 100, follow: true, resetKey: 'open-1' },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    expect(scroller.scrollTop).toBe(4000);
    expect(frames.size).toBe(0);
  });

  it('absorbs a measurement into the bottom in the same flush, with no landing loop', async () => {
    const { container } = render(VirtualList, {
      props: { items: rows(), estimateHeight: () => 100, follow: true, resetKey: 'measure-1' },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    const firstRow = container.querySelector('.virtual-list-item');
    expect(firstRow).toBeTruthy();

    measure(firstRow!, 300);
    await tick();
    expect(frames.size).toBe(1); // measurement commit only
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
    await tick();

    // The measured row is 200px taller than its estimate, so the real bottom
    // moved by 200px. The view is already there in the same flush: the reader
    // never watches the transcript settle downwards, and no deferred frames
    // are left queued behind the landing.
    expect(scroller.scrollTop).toBe(4200);
    expect(frames.size).toBe(0);
  });

  it("restores a parked reader's position when auto-scroll was off", async () => {
    const props = { items: rows(), estimateHeight: () => 100, follow: false, resetKey: 'parked-1' };
    const first = render(VirtualList, { props });
    const scroller = first.container.querySelector('.virtual-list') as HTMLDivElement;
    scroller.scrollTop = 1200;
    first.unmount();

    // The parent's `follow` prop is still true for the first flush of the
    // reopen (it learns about the restore through onRestoreState), so this
    // also proves the stale prop cannot pin over the restored position.
    const restoredFollow = vi.fn();
    const second = render(VirtualList, {
      props: { ...props, follow: true, onRestoreState: restoredFollow },
    });
    const restored = second.container.querySelector('.virtual-list') as HTMLDivElement;
    await tick();

    expect(restoredFollow).toHaveBeenCalledWith({ follow: false });
    expect(restored.scrollTop).toBe(1200);
  });

  it('reopens following when the saved position was already at the bottom', async () => {
    const props = {
      items: rows(),
      estimateHeight: () => 100,
      follow: false,
      resetKey: 'bottom-parked-1',
    };
    const first = render(VirtualList, { props });
    const scroller = first.container.querySelector('.virtual-list') as HTMLDivElement;
    // A chat left a hair above the bottom with follow off: restoring this looks
    // anchored while nothing follows the agent, so it must reopen following.
    scroller.scrollTop = 3996;
    first.unmount();

    const restoredFollow = vi.fn();
    const second = render(VirtualList, {
      props: { ...props, follow: true, onRestoreState: restoredFollow },
    });
    const reopened = second.container.querySelector('.virtual-list') as HTMLDivElement;
    await tick();

    expect(restoredFollow).toHaveBeenCalledWith({ follow: true });
    expect(reopened.scrollTop).toBe(4000);
  });

  it('opens at the bottom when the reader had been following', () => {
    const props = { items: rows(), estimateHeight: () => 100, follow: true, resetKey: 'followed-1' };
    const first = render(VirtualList, { props });
    const scroller = first.container.querySelector('.virtual-list') as HTMLDivElement;
    scroller.scrollTop = 900;
    first.unmount();

    const second = render(VirtualList, { props });
    const reopened = second.container.querySelector('.virtual-list') as HTMLDivElement;
    expect(reopened.scrollTop).toBe(4000);
  });

  it('reports the landing after the opening frames settle, exactly once', async () => {
    const onLanded = vi.fn();
    render(VirtualList, {
      props: { items: rows(), estimateHeight: () => 100, follow: true, resetKey: 'landed-1', onLanded },
    });
    // The caller must not drop its cover on the same tick as the mount: rows
    // are still laid out from estimates at this point.
    expect(onLanded).not.toHaveBeenCalled();

    for (let i = 0; i < 8 && onLanded.mock.calls.length === 0; i++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
      await tick();
    }
    expect(onLanded).toHaveBeenCalledTimes(1);

    // The report is terminal: no landing loop is left queued behind it.
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
    await tick();
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('keeps the reader on the same row when an older page is prepended', async () => {
    const items = rows();
    const { container, rerender } = render(VirtualList, {
      props: { items, estimateHeight: () => 100, follow: false, resetKey: 'prepend-1' },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    // Parked on row-12 (top 1200), the position that triggers an older page.
    scroller.scrollTop = 1200;
    scroller.dispatchEvent(new Event('scroll'));
    await tick();

    await rerender({
      items: [{ id: 'older-0' }, { id: 'older-1' }, { id: 'older-2' }, ...items],
      estimateHeight: () => 100,
      follow: false,
      resetKey: 'prepend-1',
    });
    await tick();

    // Three 100px rows were inserted above the anchor. Without the correction
    // the DOM keeps scrollTop at 1200 and the reader is thrown three rows back.
    expect(scroller.scrollTop).toBe(1500);
  });
});
