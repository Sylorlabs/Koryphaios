/** Automatic compaction retry + cooldown policy.
 *
 *  Auto-compact used to be fire-and-forget: one `setTimeout(..., 0)` with no
 *  retry, no error surfacing, and no backoff — so a failing compactor
 *  re-triggered on every subsequent turn, spamming `JSON Parse error`
 *  banners while `session_compactions` stayed empty. This module holds the
 *  pure policy (delays, cooldown, retryability) so the manager stays thin
 *  and the policy is unit-testable without timers.
 * */

/** Initial attempt plus this many retries. */
export const AUTO_COMPACT_MAX_ATTEMPTS = 3;
export const AUTO_COMPACT_RETRY_BASE_DELAY_MS = 2_000;
export const AUTO_COMPACT_RETRY_MAX_DELAY_MS = 8_000;
/** While a recent automatic compaction is still failing, do not re-trigger
 *  on every turn. */
export const AUTO_COMPACT_COOLDOWN_MS = 5 * 60_000;

/** Exponential backoff for retry `retryIndex` (0-based: delay before the
 *  first retry). Capped so a stuck compactor never sleeps excessively. */
export function autoCompactRetryDelayMs(retryIndex: number): number {
  const index = Math.max(0, Math.floor(retryIndex));
  return Math.min(AUTO_COMPACT_RETRY_BASE_DELAY_MS * 2 ** index, AUTO_COMPACT_RETRY_MAX_DELAY_MS);
}

export function isAutoCompactCoolingDown(
  lastFailureAt: number | undefined,
  now: number = Date.now(),
): boolean {
  return (
    typeof lastFailureAt === 'number' &&
    Number.isFinite(lastFailureAt) &&
    now - lastFailureAt < AUTO_COMPACT_COOLDOWN_MS
  );
}

/** Cancellation is final — retrying an aborted compaction just races the
 *  newer turn. Everything else (parse failures, provider errors, races with
 *  a still-running session) is worth the bounded retries. */
export function isAutoCompactRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return true;
}

export interface AutoCompactRetryOutcome<T> {
  ok: boolean;
  attempts: number;
  result?: T;
  error?: unknown;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run an automatic compaction with bounded retries. Resolves (never
 *  rejects) with the outcome so the fire-and-forget scheduler cannot
 *  produce an unhandled rejection. */
export async function withAutoCompactRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AutoCompactRetryOutcome<T>> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? AUTO_COMPACT_MAX_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  let lastError: unknown;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const result = await operation();
      return { ok: true, attempts, result };
    } catch (error) {
      lastError = error;
      if (attempts >= maxAttempts || !isAutoCompactRetryable(error)) {
        return { ok: false, attempts, error };
      }
      await sleep(autoCompactRetryDelayMs(attempts - 1));
    }
  }
  return { ok: false, attempts, error: lastError };
}
