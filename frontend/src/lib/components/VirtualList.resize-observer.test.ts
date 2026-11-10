// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from './VirtualList.svelte';

type ObserverRecord = { callback: ResizeObserverCallback; elements: Set<Element> };
let observers: ObserverRecord[];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let nextTranscript = 0;

class ResizeObserverStub {
  private record: ObserverRecord;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, elements: new Set() };
    observers.push(this.record);
  }
  observe(element: Element) {
    this.record.elements.add(element);
  }
  unobserve(element: Element) {
    this.record.elements.delete(element);
  }
  disconnect() {
    this.record.elements.clear();
  }
}

function report(element: Element, height: number) {
  const observer = observers.find((record) => record.elements.has(element));
  if (!observer) throw new Error('Element is not being observed');
  observer.callback(
    [
      { target: element, borderBoxSize: [{ blockSize: height }], contentRect: { height } },
    ] as unknown as ResizeObserverEntry[],
    {} as ResizeObserver,
  );
}

async function nextAnimationFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
  await tick();
}

function setup() {
  const items = Array.from({ length: 4 }, (_, index) => ({ id: `row-${index}` }));
  const view = render(VirtualList, {
    props: { items, estimateHeight: () => 100, resetKey: `resize-${nextTranscript++}` },
  });
  const scroller = view.container.querySelector('.virtual-list') as HTMLElement;
  const holder = view.container.querySelector('.virtual-list-content') as HTMLElement;
  const rows = [...view.container.querySelectorAll('.virtual-list-item')];
  return { ...view, items, scroller, holder, rows };
}

describe('VirtualList resize delivery', () => {
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
    cleanup();
    vi.unstubAllGlobals();
  });

  it('leaves layout untouched during delivery, then applies the latest row and viewport sizes together', async () => {
    const { holder, rows, scroller } = setup();
    report(rows[0], 200);
    report(rows[0], 350);
    report(rows[1], 250);
    report(scroller, 900);
    await tick();

    // Even a Svelte microtask flush inside the browser's resize-delivery step
    // must not resize the spacer or re-render the observed row window.
    expect(holder.style.height).toBe('400px');
    expect((rows[1].parentElement as HTMLElement).style.top).toBe('0px');
    expect((rows[1] as HTMLElement).style.top).toBe('');
    expect(frames.size).toBe(1);

    await nextAnimationFrame();
    expect(holder.style.height).toBe('900px');
    // Visible rows are in one normal-flow window. A changing row must move its
    // siblings in the browser's layout pass, without delayed absolute offsets.
    expect(rows[1].parentElement).toBe(rows[2].parentElement);
    expect((rows[1] as HTMLElement).style.position).not.toBe('absolute');
    expect((rows[2] as HTMLElement).style.top).toBe('');
    expect(frames.size).toBe(0);
  });

  it('drops measurements for rows removed before the frame commits', async () => {
    const { holder, rows, items, rerender } = setup();
    report(rows[0], 500);
    await rerender({ items: items.slice(1) });
    await nextAnimationFrame();

    expect(rows[0].isConnected).toBe(false);
    expect(holder.style.height).toBe('300px');
  });

  it('does not apply an old transcript measurement to a new transcript with the same row ids', async () => {
    const { holder, rows, rerender } = setup();
    report(rows[0], 500);
    await rerender({ resetKey: 'resize-second' });
    await nextAnimationFrame();

    expect(holder.style.height).toBe('400px');
  });

  it('cancels pending measurements and releases observed elements on unmount', async () => {
    const { rows, scroller, unmount } = setup();
    report(rows[0], 500);
    report(scroller, 600);
    expect(frames.size).toBe(1);

    unmount();
    expect(frames.size).toBe(0);
    expect(observers.every((record) => record.elements.size === 0)).toBe(true);
    await nextAnimationFrame();
  });
});
