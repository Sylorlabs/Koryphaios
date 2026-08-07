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
