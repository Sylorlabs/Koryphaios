import { statSync } from 'node:fs';
import { join } from 'node:path';
import { withFreebuffAuthToken } from './freebuff-credentials';
import type { FreebuffAccountSnapshot } from '@koryphaios/shared';
export type { FreebuffAccountSnapshot } from '@koryphaios/shared';

/** Freebuff native 0.2.16 reads these fields from GET /api/v1/freebuff/session.
 * This is an account read, never session admission, heartbeat, grant claim,
 * inference, or an SDK API-key request. The returned allowance is normalized to
 * provider-reported hours, never USD.
 */
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function text(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export function parseFreebuffAccountSnapshot(value: unknown, now: number): FreebuffAccountSnapshot {
  if (!record(value)) throw new Error('Invalid Freebuff account response');
  const result: FreebuffAccountSnapshot = {
    source: 'freebuff-account',
    status: 'fresh',
    updatedAt: now,
  };
  if (record(value.subscription)) {
    const plan = value.subscription.tierName;
    if (
      typeof plan === 'string' &&
      plan.length > 0 &&
      plan.length <= 100 &&
      !/[\x00-\x1f\x7f]/.test(plan)
    )
      result.planType = plan;
  }
  // The native endpoint has historically named this object `freebucks`, while
  // the values are the account's hour allowance. Accept an explicit `hours`
  // object too so the parser follows the provider's newer response shape.
  const fb = value.hours ?? value.freebucks;
  if (fb === undefined || fb === null) {
    result.status = 'unavailable';
    result.note = 'Freebuff did not report an hour balance for this account.';
    return result;
  }
  if (
    !record(fb) ||
    !record(fb.daily) ||
    !amount(fb.daily.remaining) ||
    !amount(fb.daily.limit) ||
    !record(fb.wallet) ||
    !amount(fb.wallet.balance)
  ) {
    throw new Error('Invalid Freebuff balance response');
  }
  if (fb.balance !== undefined && !amount(fb.balance)) {
    throw new Error('Invalid Freebuff balance response');
  }
  let prices: Record<string, number> | undefined;
  if (fb.prices !== undefined) {
    if (!record(fb.prices) || Object.keys(fb.prices).length > 512) {
      throw new Error('Invalid Freebuff model prices response');
    }
    const parsedPrices: Record<string, number> = {};
    for (const [modelId, price] of Object.entries(fb.prices)) {
      if (!text(modelId, 256) || !amount(price)) {
        throw new Error('Invalid Freebuff model prices response');
      }
      parsedPrices[modelId] = price;
    }
    prices = parsedPrices;
  }
  const reset = typeof fb.daily.resetAt === 'string' ? Date.parse(fb.daily.resetAt) : NaN;
  const claimableGrantHours = amount(fb.claimableGrantHours)
    ? fb.claimableGrantHours
    : amount(fb.claimableGrantFreebucks)
      ? fb.claimableGrantFreebucks
      : undefined;
  result.hours = {
    // Do not trust or hardcode a nominal daily allowance. The live total is
    // the provider's remaining daily allowance plus the wallet reserve.
    balance: fb.daily.remaining + fb.wallet.balance,
    daily: {
      remaining: fb.daily.remaining,
      limit: fb.daily.limit,
      resetsAt: Number.isFinite(reset) ? reset : null,
    },
    wallet: { balance: fb.wallet.balance },
    ...(prices ? { prices } : {}),
    ...(claimableGrantHours !== undefined ? { claimableGrantHours } : {}),
    ...(typeof fb.quotaExempt === 'boolean' ? { quotaExempt: fb.quotaExempt } : {}),
  };
  return result;
}

const cache = new Map<
  string,
  {
    revision: string;
    attemptedAt: number;
    value: FreebuffAccountSnapshot;
    inFlight?: Promise<FreebuffAccountSnapshot>;
  }
>();
export const FREEBUFF_ACCOUNT_TTL_MS = 30_000;
export interface FreebuffAccountDependencies {
  fetch: typeof fetch;
  withToken: typeof withFreebuffAuthToken;
  now: () => number;
}

export async function getFreebuffAccountSnapshot(
  profileDir: string,
  force = false,
  dependencies: FreebuffAccountDependencies = {
    fetch,
    withToken: withFreebuffAuthToken,
    now: Date.now,
  },
): Promise<FreebuffAccountSnapshot> {
  let revision: string;
  try {
    const stat = statSync(join(profileDir, 'credentials.json'));
    revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    cache.delete(profileDir);
    return {
      source: 'freebuff-account',
      status: 'unavailable',
      note: 'Freebuff CLI login is required. Run "freebuff login" and refresh billing.',
    };
  }
  const previous = cache.get(profileDir);
  const existing = previous?.revision === revision ? previous : undefined;
  if (existing?.inFlight) return existing.inFlight;
  if (!force && existing && dependencies.now() - existing.attemptedAt < FREEBUFF_ACCOUNT_TTL_MS)
    return existing.value;
  const state = existing ?? {
    revision,
    attemptedAt: 0,
    value: { source: 'freebuff-account' as const, status: 'unavailable' as const },
  };
  state.attemptedAt = dependencies.now();
  const signal = AbortSignal.timeout(65_000); // Includes the bounded OS consent lookup.
  state.inFlight = dependencies
    .withToken(
      profileDir,
      async (token) => {
        const response = await dependencies.fetch(
          'https://www.codebuff.com/api/v1/freebuff/session',
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-fb-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            redirect: 'error',
          },
        );
        if (!response.ok) throw new Error('Freebuff account request failed');
        return parseFreebuffAccountSnapshot(await response.json(), dependencies.now());
      },
      signal,
    )
    .then((value) => {
      state.value = value;
      return value;
    })
    .catch(() => {
      // Never forward fetch/child errors, response bodies, headers, or tokens.
      state.value = {
        ...state.value,
        status: state.value.hours ? 'stale' : 'unavailable',
        note: 'Freebuff hour refresh failed. Check the CLI login and Keychain access, then refresh billing.',
      };
      return state.value;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
  cache.set(profileDir, state);
  return state.inFlight;
}

export function resetFreebuffAccountCacheForTests(): void {
  cache.clear();
}
