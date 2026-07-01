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

const DEFAULT_THRESHOLD = 100;

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
    programmaticScroll = true;
    if (behavior === 'instant') {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
    // Release the guard on the next frame. The scroll event handler will
    // see the synthetic scroll, but because `programmaticScroll` is true
    // it will not flip `follow` off.
    requestAnimationFrame(() => {
      programmaticScroll = false;
    });
  }

  function onUserScroll() {
    if (programmaticScroll) return;
    // untrack: this handler runs in response to a real DOM event, not
    // inside an effect. Reading `follow` here is a state READ, which is
    // fine — but we use untrack defensively to make it explicit.
    untrack(() => {
      const dist = getDistanceFromBottom();
      const wasFollowing = follow;
      const shouldFollow = dist <= threshold;
      if (wasFollowing && !shouldFollow) {
        follow = false;
      } else if (!wasFollowing && shouldFollow) {
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
      if (!follow) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const el = getEl();
        if (!el || !follow) return;
        // Setting scrollTop directly (instead of scrollTo) skips smooth
        // scrolling entirely — important for per-token updates which fire
        // at 30-100Hz and would jank with a smooth animation.
        el.scrollTop = el.scrollHeight;
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
          target.scrollTop = target.scrollHeight;
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
            target.scrollTop = target.scrollHeight;
          });
        });
      });
      mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  function detach() {
    if (currentEl) {
      currentEl.removeEventListener('scroll', onUserScroll);
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
