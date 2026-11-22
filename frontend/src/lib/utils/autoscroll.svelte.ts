// Shared "sticky bottom" autoscroll logic for chat feeds.
//
// Why this exists:
//   The previous in-component logic (MutationObserver + ResizeObserver +
//   $effect on length) missed the per-token streaming case. Token
//   accumulation does not grow feed.length, so length-based effects never
//   re-fire while the model is streaming a single content/thinking block,
//   and the user has to scroll down manually for every operation.
//
// What this does:
//   - Tracks a single boolean `follow` (sticky-bottom) state.
//   - Only ever releases `follow` for a scroll the *reader* actually caused.
//     A `scroll` event is a blunt instrument: the browser also fires one for
//     every programmatic pin we make, and between the pin and the event the
//     content can grow (a streaming row, a row finishing its measurement, a
//     chart or image decoding), so the offset the event reports no longer
//     describes the reader's intent. A scroll therefore only counts as the
//     reader's when a gesture preceded it — wheel, touch, a scroll key, a
//     scrollbar drag — *and* the container ended up somewhere the last pin
//     did not put it. Everything else is a consequence of layout change, and
//     is re-pinned when we still want to be at the bottom. Getting this
//     wrong in either direction is what made the feed feel like it was
//     fighting the reader, and stranded a reopened chat at the top.
//   - Provides a `requestPin()` API that callers invoke when new content
//     arrives. If `follow` is on, it snaps to the bottom in the next
//     animation frame, reading scrollHeight after layout has settled.
//   - Attaches a ResizeObserver to the scroll container so that height
//     changes (streaming tokens resizing rows, items mounting, etc.) also
//     keep the view pinned when `follow` is on. The resize observer never
//     flips `follow` on or off — it only re-pins when already following.
//   - Tracks an `unseenCount` so callers can show "N new messages" badges
//     in the Jump-to-bottom pill.
//
// Usage:
//   In a Svelte 5 component:
//     let containerEl = $state<HTMLDivElement>();
//     const auto = createAutoScroll(() => containerEl, { threshold: 100 });
//     $effect(() => {
//       // On every relevant change, ask the controller to re-pin.
//       void filteredFeed.length;
//       auto.requestPin();
//     });

import { untrack } from 'svelte';
import { READER_RESIZE_EVENT } from './expand-anchor';

export interface AutoScrollOptions {
  /** Pixels from bottom that still count as "at the bottom". Default 100. */
  threshold?: number;
  /** When true, the action installs its own MutationObserver as a fallback
   *  for cases where the caller can't trigger `requestPin()` reliably.
   *  Default true. */
  observeMutations?: boolean;
}

const DEFAULT_THRESHOLD = 10;
// Distance (px) that still counts as "genuinely at the bottom" for
// re-engaging follow mode from a scroll event. This is intentionally much
// smaller than the (larger, tolerant-of-jitter) disengage threshold. Using
// the same value for both meant a user's small upward scroll (a few px)
// was immediately reversed by the very next scroll event, because that
// event's distance was still within the generous disengage threshold —
// making it feel like scrolling up was blocked entirely.
const REENGAGE_EPSILON = 4;
// How long after a reader gesture a scroll event is still attributed to that
// gesture. Momentum scrolling on macOS keeps firing wheel events for well
// after the last physical input, and touch scrolling emits the final scroll
// events after `touchend`, so the window has to outlast a single tick.
const READER_INPUT_WINDOW_MS = 600;
// Frames re-pinned after an explicit jump. A freshly opened transcript renders
// from estimated row heights and converges over several frames as rows
// measure; pinning once lands short of the real bottom and leaves the reader
// looking at the start of their own conversation.
const SETTLE_FRAMES = 12;

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface AutoScrollHandle {
  /** Reactive: whether the view should stay pinned to the bottom. */
  readonly follow: boolean;
  /** Reactive: whether there is scrollable content below the viewport. */
  readonly hasContentBelow: boolean;
  /** Reactive: number of "new" deltas that arrived while the user was
   *  scrolled away. Resets to 0 when the user returns to the bottom or
   *  calls jumpToBottom(). */
  readonly unseenCount: number;
  /** Call this whenever content grows (per-token or per-entry) so the
   *  view stays pinned to the bottom if `follow` is on. Does NOT touch
   *  the unseen counter. */
  requestPin: () => void;
  /** Call this when a *new entry* (not a per-token update) is added to
   *  the feed. Increments `unseenCount` if the user is scrolled away, so
   *  the caller can show a "N new" pill. */
  notifyNewEntry: () => void;
  /** Force the view to the bottom and re-enable follow mode. Used by the
   *  "Jump to bottom" button.
   *
   *  Defaults to `instant`. A smooth scroll animates through every offset
   *  between here and the bottom, which for a long transcript takes several
   *  seconds and fires a scroll event per frame — the exact "slow autoscroll
   *  down" a reader reports. Readers asked for the bottom, not a tour of the
   *  transcript to get there, and `pinToBottom` writes scrollTop directly so
   *  the motion is a single blip. */
  jumpToBottom: (behavior?: ScrollBehavior) => void;
  /** Manually set follow mode (e.g. when the user wants to pause). */
  setFollow: (v: boolean) => void;
  /** Suspend or resume every pin this controller performs.
   *
   *  A chat that is opening is positioned by the list that owns its measured
   *  extent, not by this controller. While suspended, `requestPin`,
   *  `notifyNewEntry` and the observers are inert, so nothing here can write
   *  `scrollTop` and fight the opening position. Autoscroll is for following a
   *  live agent, never for placing a transcript that is still loading. */
  setSuspended: (v: boolean) => void;
  /** Read the current distance from the bottom in pixels. */
  getDistanceFromBottom: () => number;
  /** Attach the scroll/observer listeners to the current container.
   *  Call this after the container ref binds, or whenever the container
   *  element changes (e.g. switching between empty-state and virtual
   *  list). */
  attach: () => void;
  /** Tear down observers. */
  destroy: () => void;
}

export function createAutoScroll(
  getContainer: () => HTMLDivElement | undefined,
  options: AutoScrollOptions = {},
): AutoScrollHandle {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const observeMutations = options.observeMutations ?? true;

  let follow = $state(true);
  let unseenCount = $state(0);
  let hasContentBelow = $state(false);
  let rafId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let currentEl: HTMLDivElement | null = null;
  // Offset the most recent programmatic pin landed on, read back after the
  // browser clamped it. Paired with the reader-gesture window below, it is
  // what separates "our pin's own scroll event" from "the reader moved": a
  // gesture alone is not enough (clicking anything inside the feed counts as
  // one, and the next pin's event would then read as a reader scroll), and the
  // offset alone is not enough either (layout churn moves it).
  let pinnedTop: number | null = null;
  // Monotonic timestamp of the most recent reader gesture on the container.
  // Number.NEGATIVE_INFINITY so "recent" is false until a gesture happens.
  let readerInputAt = Number.NEGATIVE_INFINITY;
  let settleFrames = 0;
  // True while a transcript is opening and the list owns the initial position.
  let suspended = false;

  function getEl(): HTMLDivElement | undefined {
    return getContainer();
  }

  function getDistanceFromBottom(): number {
    const el = getEl();
    if (!el) return Number.POSITIVE_INFINITY;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function updateContentBelow() {
    const el = getEl();
    hasContentBelow = !!el && getDistanceFromBottom() > 1;
  }

  // ─── Pinning ──────────────────────────────────────────────────────────────

  function pinToBottom(el: HTMLDivElement) {
    // Setting scrollTop directly (instead of scrollTo) skips smooth
    // scrolling entirely — important for per-token updates which fire
    // at 30-100Hz and would jank with a smooth animation.
    el.scrollTop = el.scrollHeight;
    // Read back: the browser clamps to the real max scrollTop, and that clamped
    // value is the one the resulting scroll event will report.
    pinnedTop = el.scrollTop;
  }

  /** Queue a pin for the next frame. Coalesces the several independent
   *  height-growth sources (streaming tokens, the VirtualList's own
   *  measurement pass, the observers below) into one write. */
  function schedulePin() {
    // A suspended controller must not queue a pin: the opening position belongs
    // to the list until it reports that it has landed.
    if (suspended) return;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!follow) return;
      const el = getEl();
      if (!el) return;
      pinToBottom(el);
      updateContentBelow();
      // Keep converging while an explicit jump is still settling: the
      // transcript's real bottom moves as rows finish measuring.
      if (settleFrames > 0) {
        settleFrames--;
        if (getDistanceFromBottom() > 1) schedulePin();
        else settleFrames = 0;
      }
    });
  }

  function scrollToBottomNow(behavior: ScrollBehavior = 'instant') {
    const el = getEl();
    if (!el) return;
    if (behavior === 'instant') {
      pinToBottom(el);
      updateContentBelow();
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
      // A smooth scroll walks through every offset on its way down, so there
      // is no single value to recognise its events by.
      pinnedTop = null;
    }
  }

  // ─── Reader intent ────────────────────────────────────────────────────────

  // Upward intent (wheel up / touch drag) releases follow IMMEDIATELY — before
  // the resulting scroll — so auto-pin can never fight the user or stutter.
  function onWheel(e: WheelEvent) {
    noteReaderInput();
    if (e.deltaY < 0 && follow)
      untrack(() => {
        follow = false;
      });
  }
  let touchStartY = 0;
  function onTouchStart(e: TouchEvent) {
    touchStartY = e.touches[0]?.clientY ?? 0;
  }
  function onTouchMove(e: TouchEvent) {
    noteReaderInput();
    const y = e.touches[0]?.clientY ?? 0;
    if (y > touchStartY + 4 && follow)
      untrack(() => {
        follow = false;
      }); // finger down = content up = scrolling up
  }
  // Scrolling without a wheel event: dragging the scrollbar (a pointer gesture
  // on the element itself) and the keyboard.
  function onPointerDown() {
    noteReaderInput();
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!SCROLL_KEYS.has(e.key)) return;
    noteReaderInput();
  }

  function noteReaderInput() {
    readerInputAt = monotonicNow();
    // The reader is in charge from here: drop any queued pin so nothing we
    // already scheduled lands on top of their gesture, and end the settle
    // loop started by a jump they have just overridden.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    settleFrames = 0;
  }

  function onReaderResize() {
    noteReaderInput();
    follow = false;
    // Subsequent scrolls are the disclosure changing layout, not a new scroll
    // gesture. In particular, collapsing must not re-enable bottom following.
    readerInputAt = Number.NEGATIVE_INFINITY;
    pinnedTop = null;
  }

  function onUserScroll() {
    untrack(() => {
      const el = getEl();
      if (!el) return;
      const dist = getDistanceFromBottom();
      updateContentBelow();
      // A scroll counts as the reader's only when a gesture preceded it *and*
      // the container ended up somewhere our last pin did not put it.
      const readerDriven =
        monotonicNow() - readerInputAt <= READER_INPUT_WINDOW_MS &&
        (pinnedTop === null || el.scrollTop !== pinnedTop);
      const wasFollowing = follow;
      // Re-engaging requires genuinely reaching the bottom (small epsilon),
      // not just being back within the generous disengage threshold — see
      // REENGAGE_EPSILON above.
      const shouldReengage = dist <= REENGAGE_EPSILON;

      if (!readerDriven) {
        // No gesture produced this scroll, so it is a consequence of layout
        // change under a pin we already performed — content grew after the pin
        // landed. Never let it release follow; close the gap instead so the
        // view stays exactly where the reader last saw it.
        if (wasFollowing && dist > threshold) schedulePin();
        return;
      }

      if (wasFollowing && dist > REENGAGE_EPSILON) {
        // The reader moved the view and did not land on the bottom. Release
        // follow for *any* distance: honouring only the generous threshold
        // let a reader who deliberately parked 10px above the bottom get
        // yanked back by the next pin.
        follow = false;
      } else if (!wasFollowing && shouldReengage) {
        // User scrolled back to the bottom — re-engage and clear the
        // unseen counter.
        follow = true;
        if (unseenCount > 0) unseenCount = 0;
      }
    });
  }

  function requestPin() {
    // untrack: `follow` is read here, but we don't want the calling
    // effect to re-run when `follow` changes — only when the consumer's
    // own state (e.g. feed length) changes.
    untrack(() => {
      if (suspended) return;
      updateContentBelow();
      if (!follow) return;
      schedulePin();
    });
  }

  function notifyNewEntry() {
    untrack(() => {
      if (suspended) return;
      updateContentBelow();
      if (!follow) unseenCount++;
    });
  }

  function jumpToBottom(behavior: ScrollBehavior = 'instant') {
    follow = true;
    unseenCount = 0;
    scrollToBottomNow(behavior);
    if (behavior === 'instant') {
      // The transcript is still converging (rows measuring, markdown and
      // charts settling), so the true bottom is still moving. Re-pin for a
      // few frames so an opened chat lands on its latest message instead of
      // wherever the estimates happened to put the bottom.
      settleFrames = SETTLE_FRAMES;
      schedulePin();
    }
  }

  function setFollow(v: boolean) {
    follow = v;
    if (v && unseenCount > 0) unseenCount = 0;
  }

  function setSuspended(v: boolean) {
    suspended = v;
    if (!v) return;
    // Drop anything already queued so a pin scheduled before the open cannot
    // land on top of the list's first paint.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    settleFrames = 0;
    pinnedTop = null;
  }

  // ---- Observer wiring --------------------------------------------------
  function attach() {
    const el = getEl();
    if (!el) return;
    if (el === currentEl) return; // already attached
    // Detach from the previous element first
    detach();

    currentEl = el;
    updateContentBelow();
    el.addEventListener('scroll', onUserScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener(READER_RESIZE_EVENT, onReaderResize);

    // Watch the container's size so that streaming tokens (which grow the
    // last row, which in turn grows the inner content height) re-pin the
    // view to the bottom when `follow` is on. The observer only ever
    // *re-pins*; it never toggles `follow`, so it cannot fight the user.
    resizeObserver = new ResizeObserver(() => {
      untrack(() => {
        updateContentBelow();
        if (!follow) return;
        schedulePin();
      });
    });
    resizeObserver.observe(el);

    if (observeMutations) {
      // Catch-all: any DOM mutation inside the scroll container that
      // changes the content height will trigger a re-pin. This is the
      // belt-and-suspenders fallback for cases where the caller forgot
      // to call requestPin() (e.g. a new entry arrives that wasn't
      // accounted for in a $effect).
      mutationObserver = new MutationObserver(() => {
        untrack(() => {
          if (!follow) return;
          schedulePin();
        });
      });
      mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  function detach() {
    if (currentEl) {
      currentEl.removeEventListener('scroll', onUserScroll);
      currentEl.removeEventListener('wheel', onWheel);
      currentEl.removeEventListener('touchstart', onTouchStart);
      currentEl.removeEventListener('touchmove', onTouchMove);
      currentEl.removeEventListener('pointerdown', onPointerDown);
      currentEl.removeEventListener('keydown', onKeyDown);
      currentEl.removeEventListener(READER_RESIZE_EVENT, onReaderResize);
    }
    currentEl = null;
    pinnedTop = null;
    hasContentBelow = false;
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    settleFrames = 0;
  }

  return {
    get follow() {
      return follow;
    },
    get hasContentBelow() {
      return hasContentBelow;
    },
    get unseenCount() {
      return unseenCount;
    },
    requestPin,
    notifyNewEntry,
    setSuspended,
    jumpToBottom,
    setFollow,
    getDistanceFromBottom,
    attach,
    destroy: detach,
  };
}
