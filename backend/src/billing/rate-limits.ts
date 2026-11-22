/**
 * Live rate-limit observations from provider responses.
 *
 * Gateways such as Logfare return their real remaining quota on inference
 * responses (`x-ratelimit-*`, `retry-after`) without exposing an account-wide
 * limits API to ordinary API keys. Recording those headers is the only
 * provider-reported, key-compatible signal; nothing here invents a limit.
 */
import type { ProviderRateLimitSnapshot, ProviderRateLimitWindow } from '@koryphaios/shared';

const latest = new Map<string, ProviderRateLimitSnapshot>();
const MAX_SNAPSHOTS = 200;

function read(headers: Headers, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

function integer(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function windowFrom(
  headers: Headers,
  limitNames: string[],
  remainingNames: string[],
  resetNames: string[],
): ProviderRateLimitWindow | undefined {
  const limit = integer(read(headers, ...limitNames));
  const remaining = integer(read(headers, ...remainingNames));
  const reset = read(headers, ...resetNames);
  if (limit == null && remaining == null && reset == null) return undefined;
  return {
    ...(limit == null ? {} : { limit }),
    ...(remaining == null ? {} : { remaining }),
    ...(reset == null ? {} : { reset }),
  };
}

function retryAfterSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return Math.max(0, Math.trunc(asNumber));
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, Math.ceil((asDate - Date.now()) / 1_000));
  return undefined;
}

/** Record the authoritative quota window a provider attached to one response. */
export function recordProviderRateLimit(
  provider: string,
  model: string | undefined,
  headers: Headers,
  status: number,
): void {
  const requests = windowFrom(
    headers,
    ['x-ratelimit-limit-requests', 'ratelimit-limit'],
    ['x-ratelimit-remaining-requests', 'ratelimit-remaining'],
    ['x-ratelimit-reset-requests', 'ratelimit-reset'],
  );
  const tokens = windowFrom(
    headers,
    ['x-ratelimit-limit-tokens', 'x-ratelimit-token-limit'],
    ['x-ratelimit-remaining-tokens', 'x-ratelimit-token-remaining'],
    ['x-ratelimit-reset-tokens', 'x-ratelimit-token-reset'],
  );
  const retry = retryAfterSeconds(read(headers, 'retry-after'));
  if (!requests && !tokens && retry == null && status !== 429) return;

  const key = `${provider}\u0000${model ?? '*'}`;
  latest.set(key, {
    provider,
    ...(model ? { model } : {}),
    capturedAt: Date.now(),
    status: status === 429 ? 'rate_limited' : 'ok',
    ...(retry == null ? {} : { retryAfterSeconds: retry }),
    ...(requests ? { requests } : {}),
    ...(tokens ? { tokens } : {}),
  });
  if (latest.size > MAX_SNAPSHOTS) {
    const oldest = [...latest.entries()].sort(
      ([, left], [, right]) => left.capturedAt - right.capturedAt,
    )[0];
    if (oldest) latest.delete(oldest[0]);
  }
}

export function getProviderRateLimitSnapshots(): ProviderRateLimitSnapshot[] {
  return [...latest.values()].sort((left, right) => right.capturedAt - left.capturedAt);
}

/** Tests need deterministic state without exporting the mutable map. */
export function clearProviderRateLimits(): void {
  latest.clear();
}
