/**
 * Context-window metadata has a different lifetime from usage telemetry.
 * A usage event can legitimately omit a limit while model discovery is still
 * in flight; it must never erase a limit that the provider already verified.
 */
export type ContextWindowState = {
  max: number;
  known: boolean;
};

export function mergeVerifiedContextWindow(
  current: ContextWindowState,
  incoming: ContextWindowState,
): ContextWindowState {
  if (incoming.known && Number.isFinite(incoming.max) && incoming.max > 0) {
    return { max: incoming.max, known: true };
  }
  if (current.known && Number.isFinite(current.max) && current.max > 0) {
    return current;
  }
  return { max: 0, known: false };
}

/** Tiers offered for a session context budget, ascending. The provider-
 *  verified window itself is always an option; the ladder only adds tiers
 *  strictly below it so a budget can never exceed the verified window. */
export const CONTEXT_WINDOW_LADDER = [
  32768, 65536, 131072, 200000, 262144, 400000, 524288, 1000000, 2097152,
];

/** Build picker tiers from the verified window. Returns empty for an
 *  unverified or non-positive window — the picker must not appear when the
 *  backend never reported a real limit to clamp against. */
export function contextWindowOptions(verifiedWindow: number): number[] {
  if (!Number.isFinite(verifiedWindow) || verifiedWindow <= 0) return [];
  return Array.from(
    new Set([...CONTEXT_WINDOW_LADDER.filter((n) => n < verifiedWindow), verifiedWindow]),
  ).sort((a, b) => a - b);
}

/** Keep a persisted override only when it is a positive safe integer and it
 *  does not exceed the verified window. An unknown verified window fails
 *  closed to undefined rather than trusting a stale stored number. */
export function clampContextWindowOverride(
  value: number | undefined,
  verifiedWindow: number | undefined,
): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (typeof verifiedWindow === 'number' && verifiedWindow > 0 && value > verifiedWindow) {
    return undefined;
  }
  return value;
}

/** Human label for a tier. Whole thousands/millions shorten to K/M; anything
 *  else stays exact — an approximation must never misstate the budget. */
export function formatContextWindowOption(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}
