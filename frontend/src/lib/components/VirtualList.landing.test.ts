// @vitest-environment happy-dom
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from './VirtualList.svelte';

// Opening a chat must show the chat, not the first message followed by a slide
// down to the last one. That takes two things this file pins down: the bottom
// offset has to be written in the same tick the rows are rendered (a pin inside
// a rAF is applied only after the browser has already painted the frame it was
// scheduled from), and the row measurements have to outlive the component so a
// chat the reader has already opened is laid out exactly rather than re-derived
// from estimates.

type ObserverRecord = { callback: ResizeObserverCallback; elements: Element[] };
let observers: ObserverRecord[] = [];

class ResizeObserverStub {
  private record: ObserverRecord;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, elements: [] };
    observers.push(this.record);
  }
  observe(element: Element) {
    this.record.elements.push(element);
  }
  unobserve() {}
  disconnect() {}
}

function observerFor(element: Element): ObserverRecord {
  const record = observers.find((candidate) => candidate.elements.includes(element));
  if (!record) throw new Error('no ResizeObserver is watching this element');
  return record;
}

/** Report a measured height for a row, the way the real observer would. */
function measure(element: Element, height: number) {
  observerFor(element).callback(
    [
      {
        target: element,
        borderBoxSize: [{ blockSize: height }],
        contentRect: { height },
      },
    ] as unknown as ResizeObserverEntry[],
    {} as ResizeObserver,
  );
}

function sizeElement(element: HTMLElement, clientHeight: number, scrollHeight: () => number) {
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(element, 'scrollHeight', { get: scrollHeight, configurable: true });
}

const ROWS = 40;
const ESTIMATE = 100;
const REAL = 300;

function rows() {
  return Array.from({ length: ROWS }, (_, index) => ({ id: `row-${index}` }));
}

/** The height the browser would give the scroll container: the lowest rendered
 *  row's bottom edge, where a row's height is its measurement when it has one
 *  and its estimate until it does. */
function domBottom(scroller: HTMLElement, measured: Map<Element, number>): number {
  let lowest = 0;
  for (const row of Array.from(scroller.querySelectorAll('.virtual-list-item'))) {
    const top = parseFloat((row as HTMLElement).style.top);
    lowest = Math.max(lowest, top + (measured.get(row) ?? ESTIMATE));
  }
  return lowest;
}

function reportHeight(
  measured: Map<Element, number>,
  element: Element,
  height: number,
) {
  measured.set(element, height);
  measure(element, height);
}

/** Drive a cold open the way a browser would: every frame the window draws a
 *  screenful of rows, the observer reports their real heights, and the list
 *  re-pins. Returns the offset the transcript settled on. */
async function settle(
  container: HTMLElement,
  scroller: HTMLElement,
  measured: Map<Element, number>,
  onLandingChange: { mock: { calls: unknown[][] } },
  maxFrames = 60,
): Promise<number> {
  for (let frame = 0; frame < maxFrames; frame++) {
    for (const row of Array.from(container.querySelectorAll('.virtual-list-item'))) {
      reportHeight(measured, row, REAL);
    }
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    const landing = onLandingChange.mock.calls.at(-1)?.[0];
    if (landing === false && frame > 0) return scroller.scrollTop;
  }
  return scroller.scrollTop;
}

describe('VirtualList opening at the bottom', () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is already at the bottom in the first frame it renders', () => {
    const { container } = render(VirtualList, {
      props: { items: rows(), estimateHeight: () => ESTIMATE, follow: true, resetKey: 'sync-1' },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;

    // No rAF, no tick, no waiting: the transcript mounts at the bottom. A pin
    // deferred to the next animation frame leaves this at 0, which is the
    // reader looking at the top of their own conversation for one paint.
    expect(scroller.scrollTop).toBe(ROWS * ESTIMATE);

    // ...and the window drawn for that frame is the end of the transcript, not
    // its beginning. (Overscan renders a few rows above the viewport, so this
    // is "near the end" rather than "the last row".)
    const rendered = Array.from(container.querySelectorAll('.virtual-list-item')) as HTMLElement[];
    expect(parseFloat(rendered[0].style.top)).toBeGreaterThan((ROWS / 2) * ESTIMATE);
    expect(parseFloat(rendered[rendered.length - 1].style.top)).toBe((ROWS - 1) * ESTIMATE);
  });

  it('lands on the real bottom, not the estimated one, once rows measure', async () => {
    const { container } = render(VirtualList, {
      props: { items: rows(), estimateHeight: () => ESTIMATE, follow: true, resetKey: 'settle-1' },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    const measured = new Map<Element, number>();
    sizeElement(scroller, 600, () => domBottom(scroller, measured));

    for (const row of Array.from(container.querySelectorAll('.virtual-list-item'))) {
      reportHeight(measured, row, REAL);
    }
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // Every row is three times its estimate, so the estimated bottom (4000) is
    // 8000px short of the real one. The landing has to walk the difference.
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThanOrEqual(1);
  });

  it('reuses a transcript\'s measurements when it is opened again', async () => {
    const measured = new Map<Element, number>();
    const onLandingChange = vi.fn();
    const first = render(VirtualList, {
      props: {
        items: rows(),
        estimateHeight: () => ESTIMATE,
        follow: true,
        resetKey: 'warm-1',
        onLandingChange,
      },
    });
    const firstScroller = first.container.querySelector('.virtual-list') as HTMLDivElement;
    sizeElement(firstScroller, 600, () => domBottom(firstScroller, measured));

    // A cold open has to walk down the transcript as each screenful of rows
    // reports its real height.
    const settledAt = await settle(first.container, firstScroller, measured, onLandingChange);
    expect(settledAt).toBeGreaterThan(ROWS * ESTIMATE);
    first.unmount();

    const second = render(VirtualList, {
      props: {
        items: rows(),
        estimateHeight: () => ESTIMATE,
        follow: true,
        resetKey: 'warm-1',
        onLandingChange: undefined,
      },
    });
    const secondScroller = second.container.querySelector('.virtual-list') as HTMLDivElement;
    sizeElement(secondScroller, 600, () => domBottom(secondScroller, measured));

    // Reopening the same chat starts from the heights the last open measured,
    // so it lands on the same bottom in its very first frame instead of
    // rediscovering it row by row.
    expect(secondScroller.scrollTop).toBe(settledAt);
  });

  it('holds the transcript back until it has landed, then reveals it', async () => {
    const onLandingChange = vi.fn();
    const { container, rerender } = render(VirtualList, {
      props: {
        items: rows(),
        estimateHeight: () => ESTIMATE,
        follow: true,
        resetKey: 'reveal-1',
        onLandingChange,
      },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    // A bottom the pins cannot reach yet: the view has to keep correcting it.
    const measured = new Map<Element, number>();
    sizeElement(scroller, 600, () => domBottom(scroller, measured) + 5000);
    onLandingChange.mockClear();

    await rerender({ resetKey: 'reveal-2' });
    expect(onLandingChange).toHaveBeenLastCalledWith(true);

    // The reader is given the transcript back the moment they touch it, rather
    // than having to wait out a landing they are trying to scroll through.
    scroller.dispatchEvent(new Event('wheel'));
    await tick();
    expect(onLandingChange).toHaveBeenLastCalledWith(false);
  });

  it('reveals the transcript once the landing reaches the bottom', async () => {
    const onLandingChange = vi.fn();
    const measured = new Map<Element, number>();
    const { container, rerender } = render(VirtualList, {
      props: {
        items: rows(),
        estimateHeight: () => ESTIMATE,
        follow: true,
        resetKey: 'reveal-3',
        onLandingChange,
      },
    });
    const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
    // The container keeps reporting a taller scrollHeight than the rows the
    // window has drawn so far, so no single pin can reach the bottom.
    let lagging = 300;
    sizeElement(scroller, 600, () => domBottom(scroller, measured) + lagging);
    onLandingChange.mockClear();

    await rerender({ resetKey: 'reveal-4' });
    expect(onLandingChange).toHaveBeenLastCalledWith(true);

    // Each frame draws and measures more of the transcript, closing the gap
    // until the pin finally reaches the real bottom.
    for (let frame = 0; frame < 12 && lagging > 0; frame++) {
      for (const row of Array.from(container.querySelectorAll('.virtual-list-item'))) {
        reportHeight(measured, row, REAL);
      }
      lagging = Math.max(0, lagging - 200);
      await tick();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }

    expect(onLandingChange).toHaveBeenLastCalledWith(false);
  });
});
