import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoScroll } from './autoscroll.svelte';
import { READER_RESIZE_EVENT } from './expand-anchor';

// happy-dom performs no layout, and the controller only needs a scroll
// container's geometry + event surface. A duck-typed fake keeps this test
// independent of the DOM implementation (and of layout support).
class FakeScroller extends EventTarget {
  scrollHeight: number;
  clientHeight: number;
  #scrollTop = 0;

  constructor(scrollHeight = 2000, clientHeight = 500) {
    super();
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
  }

  get scrollTop(): number {
    return this.#scrollTop;
  }

  // Clamp exactly like the browser: assigning past the end lands at the end.
  set scrollTop(value: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this.#scrollTop = Math.min(Math.max(0, value), max);
  }

  scrollTo(options: ScrollToOptions | number): void {
    this.scrollTop = typeof options === 'number' ? options : (options.top ?? 0);
  }

  distanceFromBottom(): number {
    return this.scrollHeight - this.scrollTop - this.clientHeight;
  }

  fireScroll(): void {
    this.dispatchEvent(new Event('scroll'));
  }

  /** A real reader gesture: browsers deliver a scroll event after input, never
   *  on their own. */
  wheelBy(deltaY: number): void {
    const event = new Event('wheel', { cancelable: true }) as Event & { deltaY: number };
    Object.defineProperty(event, 'deltaY', { value: deltaY });
    this.dispatchEvent(event);
  }

  scrollbarDrag(): void {
    this.dispatchEvent(new Event('pointerdown'));
  }

  asElement(): HTMLDivElement {
    return this as unknown as HTMLDivElement;
  }
}

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

/** rAF queue driven by hand so settle/re-pin behaviour is observable. */
function createRafStub() {
  const queue: FrameRequestCallback[] = [];
  let nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const index = queue.findIndex((_, i) => i === id - 1);
    if (index >= 0) queue.splice(index, 1);
  });
  return {
    flush(frames = 1) {
      for (let i = 0; i < frames; i++) queue.shift()?.(0);
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('createAutoScroll — sticky bottom', () => {
  let scroller: FakeScroller;
  let raf: ReturnType<typeof createRafStub>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub);
    vi.stubGlobal('MutationObserver', ObserverStub);
    raf = createRafStub();
    scroller = new FakeScroller();
  });

  afterEach(() => vi.unstubAllGlobals());

  function attach() {
    const ctl = createAutoScroll(() => scroller.asElement(), { threshold: 100 });
    ctl.attach();
    return ctl;
  }

  it('keeps following when the transcript is swapped before the pin’s scroll event is delivered', () => {
    const ctl = attach();

    // Land at the bottom of the chat that is currently open.
    ctl.jumpToBottom('instant');
    expect(ctl.follow).toBe(true);
    const pinnedOffset = scroller.scrollTop;

    // The reader opens another chat: the transcript is replaced before the
    // browser delivers the pin's own scroll event. The offset is unchanged but
    // the new content is far taller, so the distance now looks like a large
    // upward scroll.
    scroller.scrollHeight = 9000;
    expect(scroller.scrollTop).toBe(pinnedOffset);
    expect(scroller.distanceFromBottom()).toBeGreaterThan(100);

    scroller.fireScroll();

    // Regression: this used to disengage follow, stranding the freshly opened
    // chat at the previous chat's offset instead of its bottom.
    expect(ctl.follow).toBe(true);
  });

  it('still disengages when the reader genuinely scrolls up', () => {
    const ctl = attach();

    ctl.jumpToBottom('instant');
    scroller.fireScroll();
    expect(ctl.follow).toBe(true);

    scroller.wheelBy(-120);
    scroller.scrollTop = 200;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);
  });

  it('pauses bottom-follow through tool expansion and collapse until a real scroll gesture', () => {
    const ctl = attach();
    ctl.jumpToBottom('instant');
    ctl.requestPin();
    scroller.dispatchEvent(new Event(READER_RESIZE_EVENT));
    expect(ctl.follow).toBe(false);
    expect(raf.pending).toBe(0);
    const original = scroller.scrollTop;
    scroller.scrollHeight += 300;
    ctl.requestPin();
    raf.flush(4);
    expect(scroller.scrollTop).toBe(original);
    scroller.scrollHeight -= 300;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);
    scroller.wheelBy(100);
    scroller.scrollTop -= 20;
    scroller.fireScroll();
    scroller.wheelBy(100);
    scroller.scrollTop = scroller.scrollHeight;
    scroller.fireScroll();
    expect(ctl.follow).toBe(true);
  });

  it('re-engages when the reader returns to the bottom', () => {
    const ctl = attach();

    scroller.wheelBy(-120);
    scroller.scrollTop = 300;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);

    scroller.wheelBy(400);
    scroller.scrollTop = scroller.scrollHeight;
    scroller.fireScroll();
    expect(ctl.follow).toBe(true);
    expect(ctl.unseenCount).toBe(0);
  });

  it('does not let the pin marker swallow the next genuine scroll', () => {
    const ctl = attach();

    ctl.jumpToBottom('instant');
    scroller.fireScroll(); // the pin's own event — recognised and consumed
    expect(ctl.follow).toBe(true);

    scroller.wheelBy(-120);
    scroller.scrollTop = 100;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);
  });

  it('treats a scroll event that moved away from the pin as a reader gesture', () => {
    const ctl = attach();

    ctl.jumpToBottom('instant'); // records the pinned offset
    // A reader drags the scrollbar before the pin's event is delivered, so the
    // reported offset no longer matches the pin.
    scroller.scrollbarDrag();
    scroller.scrollTop = 400;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);
  });

  it('jumpToBottom re-enables follow and lands at the very bottom', () => {
    const ctl = attach();

    scroller.wheelBy(-120);
    scroller.scrollTop = 100;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);

    ctl.jumpToBottom('instant');
    expect(ctl.follow).toBe(true);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  });

  it('starts following a freshly attached container', () => {
    const ctl = attach();
    expect(ctl.follow).toBe(true);
    expect(ctl.unseenCount).toBe(0);
  });

  it('does not report content below when the transcript fits the viewport', () => {
    scroller = new FakeScroller(500, 500);
    const ctl = attach();

    expect(ctl.hasContentBelow).toBe(false);
    ctl.jumpToBottom('instant');
    expect(ctl.hasContentBelow).toBe(false);
  });
});

describe('createAutoScroll — a reopened chat lands on its latest message', () => {
  let scroller: FakeScroller;
  let raf: ReturnType<typeof createRafStub>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub);
    vi.stubGlobal('MutationObserver', ObserverStub);
    raf = createRafStub();
    scroller = new FakeScroller();
  });

  afterEach(() => vi.unstubAllGlobals());

  function attach() {
    const ctl = createAutoScroll(() => scroller.asElement(), { threshold: 100 });
    ctl.attach();
    return ctl;
  }

  it('keeps re-pinning while the reopened transcript is still measuring', () => {
    const ctl = attach();

    // The jump lands against a transcript whose rows are still estimated, so
    // the real bottom is well below where the first pin could reach.
    ctl.jumpToBottom('instant');
    expect(scroller.scrollTop).toBe(1500);
    expect(raf.pending).toBeGreaterThan(0);

    // Rows measure and the transcript grows: the next frames close the gap.
    scroller.scrollHeight = 20_000;
    raf.flush(2);
    expect(scroller.distanceFromBottom()).toBe(0);
  });

  it('stops settling as soon as the reader takes over', () => {
    const ctl = attach();
    ctl.jumpToBottom('instant');

    scroller.scrollHeight = 20_000;
    scroller.wheelBy(-120);
    expect(raf.pending).toBe(0);

    scroller.scrollTop = 0;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);

    // Growth after the reader took over must not drag the view back down.
    raf.flush(4);
    expect(scroller.scrollTop).toBe(0);
    expect(ctl.follow).toBe(false);
  });

  it('does not fight a reader who parks just above the bottom', () => {
    const ctl = attach();
    ctl.jumpToBottom('instant');
    raf.flush(2);

    // Well inside the old 100px disengage threshold, but a deliberate choice.
    scroller.wheelBy(-40);
    scroller.scrollTop = 1465;
    scroller.fireScroll();
    expect(ctl.follow).toBe(false);

    // Streaming continues to grow the content; the reader stays put.
    scroller.scrollHeight = 4000;
    ctl.requestPin();
    raf.flush(4);
    expect(scroller.scrollTop).toBe(1465);
  });

  it('re-pins instead of releasing follow when content outgrows a pin', () => {
    const ctl = attach();
    ctl.jumpToBottom('instant');
    raf.flush(2);

    // A streaming row grew the content between our pin and the scroll event
    // the browser delivers for it. No gesture produced that event, so it must
    // not be mistaken for the reader scrolling away.
    scroller.scrollHeight = 4000;
    scroller.fireScroll();
    expect(ctl.follow).toBe(true);

    raf.flush(2);
    expect(scroller.scrollTop).toBe(3500);
  });

  it('keeps following after a plain click inside the feed', () => {
    const ctl = attach();
    ctl.jumpToBottom('instant');
    raf.flush(2);

    // Expanding a reasoning panel is a click, not a scroll. Streaming
    // continues a moment later and the pin's own scroll event lands inside
    // the gesture window — the reader must not be credited with it.
    scroller.scrollbarDrag();
    scroller.scrollHeight = 4000;
    ctl.requestPin();
    raf.flush(2);
    scroller.fireScroll();

    expect(ctl.follow).toBe(true);
    expect(scroller.scrollTop).toBe(3500);
  });
});

describe('createAutoScroll — an opening chat is not a follow', () => {
  let scroller: FakeScroller;
  let raf: ReturnType<typeof createRafStub>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub);
    vi.stubGlobal('MutationObserver', ObserverStub);
    raf = createRafStub();
    scroller = new FakeScroller();
  });

  afterEach(() => vi.unstubAllGlobals());

  function attach() {
    const ctl = createAutoScroll(() => scroller.asElement(), { threshold: 100 });
    ctl.attach();
    return ctl;
  }

  it('writes nothing while suspended, so the list owns the opening position', () => {
    const ctl = attach();
    ctl.setSuspended(true);

    // The list has placed the transcript part-way down. Every growth signal a
    // loading chat produces must leave that offset alone.
    scroller.scrollTop = 400;
    const placed = scroller.scrollTop;
    ctl.requestPin();
    ctl.notifyNewEntry();
    raf.flush(20);

    expect(scroller.scrollTop).toBe(placed);
    expect(raf.pending).toBe(0);
  });

  it('drops a pin that was already queued when the chat opens', () => {
    const ctl = attach();
    ctl.requestPin();
    expect(raf.pending).toBe(1);

    ctl.setSuspended(true);
    expect(raf.pending).toBe(0);

    scroller.scrollTop = 250;
    raf.flush(20);
    expect(scroller.scrollTop).toBe(250);
  });

  it('follows the agent again once the open has landed', () => {
    const ctl = attach();
    ctl.setSuspended(true);
    scroller.scrollTop = 0;

    ctl.setSuspended(false);
    ctl.requestPin();
    raf.flush(1);

    // Following resumes: the view is at the bottom again.
    expect(scroller.distanceFromBottom()).toBe(0);
  });
});
