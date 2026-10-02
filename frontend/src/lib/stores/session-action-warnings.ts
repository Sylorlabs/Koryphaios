/**
 * Device-local memory for the session archive/delete warning screens.
 *
 * Both warnings explain that the action stops the session's agent tree. That is
 * worth reading once and noise afterwards, so each screen offers a "Don't show
 * again" switch. Suppression is tracked per action on purpose: dismissing the
 * reversible archive warning must never silently dismiss the destructive delete
 * warning.
 *
 * The flag is only written when the user confirms, so cancelling out of a
 * warning does not count as accepting it.
 */

import type { SessionLifecycleAction } from '$lib/utils/session-lifecycle-warning';

const STORAGE_KEY = 'koryphaios-session-action-warnings-v1';

const ACTIONS: SessionLifecycleAction[] = ['archive', 'delete'];

type SuppressedWarnings = Partial<Record<SessionLifecycleAction, boolean>>;

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function readWarnings(storage: Storage | undefined = safeStorage()): SuppressedWarnings {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    const next: SuppressedWarnings = {};
    for (const action of ACTIONS) {
      if (value[action] === true) next[action] = true;
    }
    return next;
  } catch {
    return {};
  }
}

function writeWarnings(
  next: SuppressedWarnings,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Local persistence is a convenience. A blocked or full store must not make
    // archiving or deleting sessions impossible.
  }
}

/** True when the user has already accepted this warning and asked not to see it again. */
export function isSessionActionWarningSuppressed(
  action: SessionLifecycleAction,
  storage?: Storage,
): boolean {
  return readWarnings(storage)[action] === true;
}

/** Records the "Don't show again" choice made on a warning screen. */
export function suppressSessionActionWarning(
  action: SessionLifecycleAction,
  storage?: Storage,
): void {
  writeWarnings({ ...readWarnings(storage), [action]: true }, storage);
}

/** Brings a suppressed warning back. Used by tests and any future reset affordance. */
export function restoreSessionActionWarning(
  action: SessionLifecycleAction,
  storage?: Storage,
): void {
  const next = readWarnings(storage);
  delete next[action];
  writeWarnings(next, storage);
}
