// @vitest-environment happy-dom
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from './VirtualList.svelte';
import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

// A transcript parked mid-chat: expanding a reasoning panel (or a tool's
// output) grows that row, and without compensation every message below it is
// pushed down and out of view, so the reader has to scroll down again to get
// back to what they were reading.

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

const ROW_HEIGHT = 100;
const VIEWPORT = 600;
/** Rows 0..5 are above the parked viewport, rows 5..10 inside it. */
const PARKED_AT = 500;

function observerFor(element: Element): ObserverRecord {
  const record = observers.find((candidate) => candidate.elements.includes(element));
  if (!record) throw new Error('no ResizeObserver is watching this element');
  return record;
}

/** Report a new measured height for a row, the way the real observer would. */
function measure(element: Element, height: number) {
  const entry = {
    target: element,
    borderBoxSize: [{ blockSize: height }],
    contentRect: { height },
  } as unknown as ResizeObserverEntry;
  observerFor(element).callback([entry], {} as ResizeObserver);
}

/** Ask the transcript to anchor the growth this row is about to take. */
function requestAnchor(row: Element) {
  row.dispatchEvent(new CustomEvent(EXPAND_ANCHOR_EVENT, { bubbles: true }));
}

async function setup(rowCount = 12) {
  const items = Array.from({ length: rowCount }, (_, index) => ({ id: `row-${index}` }));
  const { container } = render(VirtualList, {
    props: { items, estimateHeight: () => ROW_HEIGHT },
  });

  const scroller = container.querySelector('.virtual-list') as HTMLDivElement;
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', {
    get: () => rowCount * ROW_HEIGHT,
    configurable: true,
  });
  // The component reads its viewport height through its own ResizeObserver.
  observerFor(scroller).callback(
    [{ target: scroller, contentRect: { height: VIEWPORT } }] as unknown as ResizeObserverEntry[],
    {} as ResizeObserver,
  );
  // Park the reader mid-transcript, then let the window re-derive around it.
  scroller.scrollTop = PARKED_AT;
  scroller.dispatchEvent(new Event('scroll'));
  await tick();

  // Let every row settle on its estimate so the height cache holds real
  // numbers and reports no growth of its own.
  const rows = Array.from(container.querySelectorAll('.virtual-list-item'));
  for (const row of rows) measure(row, ROW_HEIGHT);
  await tick();

  return { scroller, rows };
}

describe('VirtualList expansion anchoring', () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the messages below an expanded block in place', async () => {
    const { scroller, rows } = await setup();
    // Row 6 sits inside the parked viewport, so expanding it would push
    // everything below it (rows 7..) off the bottom of the screen.
    requestAnchor(rows[6]);
    measure(rows[6], ROW_HEIGHT + 220);

    expect(scroller.scrollTop).toBe(PARKED_AT + 220);
  });

  it('leaves growth the reader did not ask for alone', async () => {
    // A streaming row, a chart decoding, markdown settling: none of it is the
    // reader's intent, so the view must not move under them.
    const { scroller, rows } = await setup();
    measure(rows[6], ROW_HEIGHT + 220);

    expect(scroller.scrollTop).toBe(PARKED_AT);
  });

  it('ignores an expansion that has scrolled out of view', async () => {
    const { scroller, rows } = await setup();
    // Row 11 starts at 1100, past the bottom of the [500, 1100] viewport.
    requestAnchor(rows[11]);
    measure(rows[11], ROW_HEIGHT + 220);

    expect(scroller.scrollTop).toBe(PARKED_AT);
  });

  it('stops anchoring once the reader scrolls the view themselves', async () => {
    const { scroller, rows } = await setup();
    requestAnchor(rows[6]);
    // The reader takes the viewport back before the panel finishes opening.
    scroller.scrollTop = PARKED_AT - 120;
    scroller.dispatchEvent(new Event('scroll'));
    measure(rows[6], ROW_HEIGHT + 220);

    expect(scroller.scrollTop).toBe(PARKED_AT - 120);
  });

  it('caps a huge expansion at one viewport', async () => {
    const { scroller, rows } = await setup();
    requestAnchor(rows[6]);
    // A multi-thousand-pixel tool output must not fling the reader thousands of
    // pixels away from where they were reading.
    measure(rows[6], ROW_HEIGHT + 5000);

    expect(scroller.scrollTop).toBe(PARKED_AT + VIEWPORT);
  });

  it('still corrects rows that settle above the viewport', async () => {
    const { scroller, rows } = await setup();
    // Row 1 is above the parked viewport: a rich response settling from its
    // estimate must not slide the transcript the reader is looking at.
    measure(rows[1], ROW_HEIGHT + 50);

    expect(scroller.scrollTop).toBe(PARKED_AT + 50);
  });
});
