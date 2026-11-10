/**
 * First-launch walkthrough state.
 *
 * The walkthrough shows once, on the first launch of Koryphaios on this
 * device, and never again after the user finishes or skips it — unless they
 * explicitly replay it from Settings → Home screen. Persistence is local to
 * the device; it is a UI preference, not account state.
 */

export type OnboardingOutcome = 'completed' | 'skipped';

export interface OnboardingRecord {
  outcome: OnboardingOutcome;
  finishedAt: number;
  /** Walkthrough version the user saw; bump to re-show after major changes. */
  version: number;
}

export const ONBOARDING_VERSION = 1;
const STORAGE_KEY = 'koryphaios-onboarding-v1';
const REMOTE_REPLAY_STORAGE_KEY = 'koryphaios-onboarding-remote-replay-v1';

function readRecord(): OnboardingRecord | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingRecord>;
    if (
      (parsed.outcome === 'completed' || parsed.outcome === 'skipped') &&
      typeof parsed.finishedAt === 'number' &&
      typeof parsed.version === 'number'
    ) {
      return parsed as OnboardingRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function createOnboardingStore() {
  let record = $state<OnboardingRecord | null>(readRecord());
  // Explicit replay request from Settings. Distinct from "never seen" so a
  // replay can be cancelled without wiping the original completion record.
  let replayRequested = $state(false);
  let remoteReplayRevision = (() => {
    if (typeof localStorage === 'undefined') return 0;
    const stored = Number(localStorage.getItem(REMOTE_REPLAY_STORAGE_KEY) ?? 0);
    return Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  })();

  function persist(next: OnboardingRecord | null) {
    record = next;
    if (typeof localStorage === 'undefined') return;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  function finish(outcome: OnboardingOutcome) {
    replayRequested = false;
    persist({ outcome, finishedAt: Date.now(), version: ONBOARDING_VERSION });
  }

  function isFirstLaunch(): boolean {
    return record === null || record.version < ONBOARDING_VERSION;
  }

  return {
    get record() {
      return record;
    },
    /** True when the walkthrough has never been finished on this device. */
    get isFirstLaunch() {
      return isFirstLaunch();
    },
    /** True when the walkthrough should be on screen right now. */
    get shouldShow() {
      return replayRequested || isFirstLaunch();
    },
    get replayRequested() {
      return replayRequested;
    },
    complete() {
      finish('completed');
    },
    skip() {
      finish('skipped');
    },
    /** Re-open the walkthrough on demand (Settings → Home screen). */
    replay() {
      replayRequested = true;
    },
    applyRemoteReplay(revision: number, force = false) {
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (!force && revision <= remoteReplayRevision) return;
      remoteReplayRevision = Math.max(remoteReplayRevision, revision);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(REMOTE_REPLAY_STORAGE_KEY, String(remoteReplayRevision));
      }
      replayRequested = true;
    },
    /** Cancel a replay without touching the stored completion record. */
    dismissReplay() {
      replayRequested = false;
    },
    /** Test/reset helper: forget that the walkthrough was ever seen. */
    reset() {
      replayRequested = false;
      persist(null);
    },
  };
}

export const onboardingStore = createOnboardingStore();
