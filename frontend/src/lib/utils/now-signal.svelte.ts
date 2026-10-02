// Shared "now" clock — a single 30s interval that updates a reactive `now`
// value. Components that need a ticking clock for relative time displays
// (goal elapsed time, session age, etc.) subscribe via `useNow()` instead
// of each creating their own setInterval.
//
// The timer only runs while at least one component is subscribed. When the
// last subscriber unsubscribes (e.g. all goal displays unmount), the timer
// stops automatically.

import { browser } from '$app/environment';

let now = $state(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function start(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => (now = Date.now()), 30_000);
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

/** Subscribe to the shared clock. Returns the current timestamp and an
 *  unsubscribe function. The timer starts on first subscribe and stops on
 *  last unsubscribe. */
export function useNow(): { now: number; unsubscribe: () => void } {
  if (browser) {
    subscribers++;
    start();
  }
  return {
    get now() {
      return now;
    },
    unsubscribe: () => {
      subscribers--;
      if (subscribers <= 0) {
        subscribers = 0;
        stop();
      }
    },
  };
}

/** Get the current shared timestamp without subscribing. */
export function getNow(): number {
  return now;
}

// ─── Second-resolution clock ────────────────────────────────────────────────
// Goal Mode shows how long a goal has been going down to the second, which the
// 30s clock above is far too coarse for. This is a separate ref-counted 1s
// interval so only components that genuinely display seconds pay for it.

let secondNow = $state(Date.now());
let secondSubscribers = 0;
let secondTimer: ReturnType<typeof setInterval> | undefined;

function startSeconds(): void {
  if (secondTimer !== undefined) return;
  secondNow = Date.now();
  secondTimer = setInterval(() => (secondNow = Date.now()), 1_000);
}

function stopSeconds(): void {
  if (secondTimer === undefined) return;
  clearInterval(secondTimer);
  secondTimer = undefined;
}

/** Subscribe to the shared 1s clock. The timer runs only while subscribed. */
export function useSecondClock(): { now: number; unsubscribe: () => void } {
  if (browser) {
    secondSubscribers++;
    startSeconds();
  }
  return {
    get now() {
      return secondNow;
    },
    unsubscribe: () => {
      secondSubscribers--;
      if (secondSubscribers <= 0) {
        secondSubscribers = 0;
        stopSeconds();
      }
    },
  };
}
