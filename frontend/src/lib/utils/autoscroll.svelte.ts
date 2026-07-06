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
//   - On user scroll, flips `follow` off once the user moves more than
//     `threshold` px above the bottom. The threshold is the *only* place
//     `follow` is ever set to false; programmatic scroll cannot toggle it.
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

export interface AutoScrollHandle {
  /** Reactive: whether the view should stay pinned to the bottom. */
  readonly follow: boolean;
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
   *  "Jump to bottom" button. */
  jumpToBottom: (behavior?: ScrollBehavior) => void;
  /** Manually set follow mode (e.g. when the user wants to pause). */
  setFollow: (v: boolean) => void;
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
  let programmaticScroll = false;
  let rafId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let currentEl: HTMLDivElement | null = null;

  function getEl(): HTMLDivElement | undefined {
    return getContainer();
  }

  function getDistanceFromBottom(): number {
    const el = getEl();
    if (!el) return Number.POSITIVE_INFINITY;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  function scrollToBottomNow(behavior: ScrollBehavior = 'instant') {
    const el = getEl();
    if (!el) return;
    // Only raise the guard if this assignment will actually move the
    // scroll position — otherwise no 'scroll' event fires to consume (and
    // clear) it, and the guard would incorrectly swallow the *next* real
    // user scroll event.
    if (el.scrollTop !== el.scrollHeight) {
      programmaticScroll = true;
    }
    if (behavior === 'instant') {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }

  // Upward intent (wheel up / touch drag) releases follow IMMEDIATELY — before
  // the resulting scroll — so auto-pin can never fight the user or stutter.
  function onWheel(e: WheelEvent) {
    if (e.deltaY < 0 && follow) untrack(() => { follow = false; });
  }
  let touchStartY = 0;
  function onTouchStart(e: TouchEvent) {
    touchStartY = e.touches[0]?.clientY ?? 0;
  }
  function onTouchMove(e: TouchEvent) {
    const y = e.touches[0]?.clientY ?? 0;
    if (y > touchStartY + 4 && follow) untrack(() => { follow = false; }); // finger down = content up = scrolling up
  }

  function onUserScroll() {
    // Consume the guard here rather than on a timer: a timer can race with
    // a delayed 'scroll' event under heavy DOM churn (streaming tool
    // output), leaving the guard down before the corresponding event
    // arrives — which then gets misread as user-driven scroll-away and
    // spuriously breaks follow mode mid-stream.
    if (programmaticScroll) {
      programmaticScroll = false;
      return;
    }
    // untrack: this handler runs in response to a real DOM event, not
    // inside an effect. Reading `follow` here is a state READ, which is
    // fine — but we use untrack defensively to make it explicit.
    untrack(() => {
      const dist = getDistanceFromBottom();
      const wasFollowing = follow;
      const shouldDisengage = dist > threshold;
      // Re-engaging requires genuinely reaching the bottom (small epsilon),
      // not just being back within the generous disengage threshold — see
      // REENGAGE_EPSILON above.
      const shouldReengage = dist <= REENGAGE_EPSILON;
      if (wasFollowing && shouldDisengage) {
        follow = false;
      } else if (!wasFollowing && shouldReengage) {
        // User scrolled back to the bottom — re-engage and clear the
        // unseen counter.
        follow = true;
        if (unseenCount > 0) unseenCount = 0;
      }
    });
  }

  // Pins `el` to its bottom, raising the programmatic-scroll guard only when
  // the assignment actually moves scrollTop. The guard is consumed (cleared)
  // by the resulting 'scroll' event in onUserScroll — never by a timer — so
  // it can't race a delayed event and can't outlive the scroll it was meant
  // to cover.
  function pinToBottom(el: HTMLDivElement) {
    if (el.scrollTop !== el.scrollHeight) {
      programmaticScroll = true;
    }
    // Setting scrollTop directly (instead of scrollTo) skips smooth
    // scrolling entirely — important for per-token updates which fire
    // at 30-100Hz and would jank with a smooth animation.
    el.scrollTop = el.scrollHeight;
  }

  function requestPin() {
    // untrack: `follow` is read here, but we don't want the calling
    // effect to re-run when `follow` changes — only when the consumer's
    // own state (e.g. feed length) changes.
    untrack(() => {
      if (!follow) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const el = getEl();
        if (!el || !follow) return;
        pinToBottom(el);
      });
    });
  }

  function notifyNewEntry() {
    untrack(() => {
      if (!follow) unseenCount++;
    });
  }

  function jumpToBottom(behavior: ScrollBehavior = 'smooth') {
    follow = true;
    unseenCount = 0;
    scrollToBottomNow(behavior);
  }

  function setFollow(v: boolean) {
    follow = v;
    if (v && unseenCount > 0) unseenCount = 0;
  }

  // ---- Observer wiring --------------------------------------------------
  function attach() {
    const el = getEl();
    if (!el) return;
    if (el === currentEl) return; // already attached
    // Detach from the previous element first
    detach();

    currentEl = el;
    el.addEventListener('scroll', onUserScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });

    // Watch the container's size so that streaming tokens (which grow the
    // last row, which in turn grows the inner content height) re-pin the
    // view to the bottom when `follow` is on. The observer only ever
    // *re-pins*; it never toggles `follow`, so it cannot fight the user.
    resizeObserver = new ResizeObserver(() => {
      untrack(() => {
        if (!follow) return;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!follow) return;
          const target = getEl();
          if (!target) return;
          pinToBottom(target);
        });
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
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (!follow) return;
            const target = getEl();
            if (!target) return;
            pinToBottom(target);
          });
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
    }
    currentEl = null;
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
  }

  return {
    get follow() {
      return follow;
    },
    get unseenCount() {
      return unseenCount;
    },
    requestPin,
    notifyNewEntry,
    jumpToBottom,
    setFollow,
    getDistanceFromBottom,
    attach,
    destroy: detach,
  };
}
