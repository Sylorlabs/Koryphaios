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
