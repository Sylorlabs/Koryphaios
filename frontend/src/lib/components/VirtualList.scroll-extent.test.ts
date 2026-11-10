// @vitest-environment happy-dom
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from './VirtualList.svelte';

// The scrollable extent of a virtualized transcript is the one thing a reader
// scrolling through a long chat feels directly, and the obvious way to build one
// — pad the rendered rows above and below so the container has some height —
// makes the extent a function of *which rows happen to be rendered*. Rows are
// rendered from estimates, so the extent moved while the reader scrolled: the
// scrollbar resized under them and the browser kept re-clamping their offset.
//
// Measured on an 800px viewport, that put the bottom 1760px of a chat
// permanently out of reach and swung the extent through 48 different values
// totalling 4525px over a two-second flick upward.
//
// The contract these tests pin down is that the element holding the rendered
// rows is sized to the transcript's own height. Then the extent is a function of
// the content and nothing else, and the last message is reachable by scrolling.

type ObserverRecord = { callback: ResizeObserverCallback; elements: Element[] };
let observers: ObserverRecord[] = [];
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

async function advanceFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
  await tick();
}

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

const VIEWPORT = 800;
const ROWS = 400;
/** The flat estimate a transcript is opened from. */
const ESTIMATE = 120;
/** How far the reader travels between samples. Coarse enough to keep the test
 *  quick, fine enough that a padding-derived extent still wobbles within one
 *  walk — the extent is sampled at every step. */
const WALK_STEP = 750;
const SETTLED_STEP = 500;
/** The height rows settle on once measured. Deliberately far from the estimate:
 *  that gap is what a window-derived extent turns into movement. */
const REAL = 300;

async function setup(rowCount = ROWS) {
  const items = Array.from({ length: rowCount }, (_, index) => ({ id: `row-${index}` }));
  const { container } = render(VirtualList, {
    props: { items, estimateHeight: () => ESTIMATE },
  });

  const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
  const holder = container.querySelector('.virtual-list-content') as HTMLDivElement;
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT, configurable: true });
  observerFor(scroller).callback(
    [{ target: scroller, contentRect: { height: VIEWPORT } }] as unknown as ResizeObserverEntry[],
    {} as ResizeObserver,
  );
  await advanceFrame();

  return { container, scroller, holder };
}

/** The scrollable extent the browser would give this element: the browser lets
 *  the reader scroll to (extent - viewport).
 *
 *  Reads both ways of building a virtual scroll, so that reverting to the
 *  padding-derived spacer fails on the *numbers* — how far short the bottom of
 *  the chat is — rather than on a missing style. */
function extent(holder: HTMLElement): number {
  const style = holder.style;
  const explicit = parseFloat(style.height);
  if (!Number.isNaN(explicit)) return explicit;
  // Padding-derived: the spacer contributes no height of its own, so the box is
  // the padding around the rendered rows, floored at the viewport by
  // `min-height: 100%`.
  const padding = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0');
  return Math.max(VIEWPORT, padding);
}

function scrollTo(scroller: HTMLElement, offset: number) {
  scroller.scrollTop = offset;
  scroller.dispatchEvent(new Event('scroll'));
}

/** Report every row currently on screen as measured, the way the observer does
 *  as a screenful of rows scrolls into view, and return the extent afterwards.
 *  Rows that a correction has already scrolled out from under us are skipped —
 *  a detached row's measurement is not one the component can act on. */
async function measureVisible(container: HTMLElement, scroller: HTMLElement, holder: HTMLElement) {
  const entries: ResizeObserverEntry[] = [];
  for (const row of Array.from(container.querySelectorAll('.virtual-list-item'))) {
    if (!row.isConnected) continue;
    entries.push({
      target: row,
      borderBoxSize: [{ blockSize: REAL }],
      contentRect: { height: REAL },
    } as unknown as ResizeObserverEntry);
  }
  // Browsers deliver a screenful of row sizes together. Awaiting a separate
  // frame for every row made a full walk take thousands of frames and time out.
  if (entries.length) observerFor(entries[0].target).callback(entries, {} as ResizeObserver);
  await advanceFrame();
  return extent(holder);
}

/** Walk the whole transcript measuring as we go, and sample the extent at every
 *  step. */
async function walk(
  container: HTMLElement,
  scroller: HTMLElement,
  holder: HTMLElement,
): Promise<number[]> {
  const samples: number[] = [];
  for (let offset = 0; offset <= ROWS * REAL; offset += WALK_STEP) {
    scrollTo(scroller, offset);
    await tick();
    samples.push(await measureVisible(container, scroller, holder));
  }
  return samples;
}

describe('VirtualList scroll extent', () => {
  beforeEach(() => {
    observers = [];
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the whole transcript, not the part on screen', async () => {
    const { container, holder } = await setup();

    // Only a fraction of the rows is rendered, but the extent covers all of
    // them — which is what lets a reader scroll to the end of a chat instead of
    // to the bottom of whatever happened to be on screen.
    expect(container.querySelectorAll('.virtual-list-item').length).toBeLessThan(ROWS);
    expect(extent(holder)).toBe(ROWS * ESTIMATE);
  });

  it('ends at the transcript height once every row has been measured', async () => {
    const { container, scroller, holder } = await setup();
    await walk(container, scroller, holder);

    expect(extent(holder)).toBe(ROWS * REAL);
    // And so the last message is reachable: the browser allows scrolling to
    // (extent - viewport), which is the transcript's own last pixel.
    expect(extent(holder) - VIEWPORT).toBe(ROWS * REAL - VIEWPORT);
  });

  it('only grows as rows settle from their estimates, never wobbles', async () => {
    // Every row's estimate is below its real height here, so the transcript can
    // only get taller as rows are measured. A window-derived extent has no such
    // property: it rises and falls with the window, and every fall is the
    // browser clamping a scroll offset the reader had already reached.
    const { container, scroller, holder } = await setup();
    const samples = await walk(container, scroller, holder);

    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples.at(-1)).toBe(ROWS * REAL);
  });

  it('does not change at all once the window moves over measured rows', async () => {
    // With every row measured, the transcript's height is settled and only the
    // window moves. This is the case a padding-derived extent cannot pass.
    const { container, scroller, holder } = await setup();
    await walk(container, scroller, holder);
    const settled = extent(holder);
    expect(settled).toBe(ROWS * REAL);

    const seen = new Set<number>();
    for (let offset = 0; offset <= ROWS * REAL; offset += SETTLED_STEP) {
      scrollTo(scroller, offset);
      await tick();
      seen.add(extent(holder));
      // Remounted rows report their sizes again in a real browser. Cached
      // measurements must leave both the extent and the reader's offset alone.
      seen.add(await measureVisible(container, scroller, holder));
      expect(scroller.scrollTop).toBe(offset);
    }

    expect([...seen]).toEqual([settled]);
  });
});
