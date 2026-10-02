/**
 * Per-chat approval/agent-mode/critic overrides.
 *
 * These three controls used to live only in `koryphaios.json`, so flipping
 * "YOLO" or the critic toggle in one chat silently changed every other chat in
 * the project. They are now stored on the session (see `sessions.metadata`),
 * but the turn pipeline resolves settings synchronously deep inside tool
 * execution, so the durable values are mirrored into this in-process cache and
 * keyed by session id.
 *
 * The cache is a read-through mirror, never the source of truth: every write
 * goes to the session row first, and `syncSessionAgentOverrides` refreshes the
 * mirror from a freshly loaded session. A missing entry means "this chat has no
 * overrides — use the project defaults".
 */

import type { SessionAgentOverrides } from '@koryphaios/shared';

const overridesBySession = new Map<string, SessionAgentOverrides>();

export function getSessionAgentOverrides(sessionId: string | undefined): SessionAgentOverrides {
  if (!sessionId) return {};
  return overridesBySession.get(sessionId) ?? {};
}

/** Replace the mirror for one chat. An empty patch drops the entry so the chat
 *  falls back to the project-wide agent settings. */
export function setSessionAgentOverrides(
  sessionId: string,
  overrides: SessionAgentOverrides | undefined,
): void {
  if (!sessionId) return;
  if (!overrides || Object.keys(overrides).length === 0) {
    overridesBySession.delete(sessionId);
    return;
  }
  overridesBySession.set(sessionId, { ...overrides });
}

/** Refresh the mirror from a session projection loaded elsewhere (turn
 *  admission, restart handoff, PATCH response). Identical to {@link
 *  setSessionAgentOverrides} — named for the read-through call sites. */
export { setSessionAgentOverrides as syncSessionAgentOverrides };

export function clearSessionAgentOverrides(sessionId: string): void {
  if (sessionId) overridesBySession.delete(sessionId);
}

/** Test/reset seam: drop every mirrored override. */
export function resetSessionAgentOverridesCache(): void {
  overridesBySession.clear();
}
