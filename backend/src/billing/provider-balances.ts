// Live account balances — only four providers expose one to a normal API key
// (verified July 2026): OpenRouter, DeepSeek, Moonshot/Kimi, DeepInfra.
// Everything else requires admin/management keys or has no endpoint at all,
// so we report exactly what is real and nothing more.

export interface ProviderBalance {
  provider: string;
  /** USD available; null when the provider reported something unparseable. */
  availableUsd: number | null;
  /** Lifetime/period usage USD when the endpoint reports it (OpenRouter). */
  usedUsd?: number;
  detail?: string;
  fetchedAt: number;
}

const cache = new Map<string, { at: number; value: ProviderBalance | null }>();
const CACHE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 6_000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

type Fetcher = (apiKey: string) => Promise<ProviderBalance>;

const FETCHERS: Record<string, Fetcher> = {
  // GET /api/v1/credits → { data: { total_credits, total_usage } }
  openrouter: async (key) => {
    const j = (await getJson('https://openrouter.ai/api/v1/credits', {
      Authorization: `Bearer ${key}`,
    })) as { data?: { total_credits?: number; total_usage?: number } };
    const credits = j.data?.total_credits;
    const usage = j.data?.total_usage;
    return {
      provider: 'openrouter',
      availableUsd: credits != null && usage != null ? credits - usage : null,
      usedUsd: usage,
      fetchedAt: Date.now(),
    };
  },
  // GET /user/balance → { balance_infos: [{ currency, total_balance }] }
  deepseek: async (key) => {
    const j = (await getJson('https://api.deepseek.com/user/balance', {
      Authorization: `Bearer ${key}`,
    })) as { balance_infos?: Array<{ currency?: string; total_balance?: string }> };
    const usd = j.balance_infos?.find((b) => b.currency === 'USD') ?? j.balance_infos?.[0];
    const v = usd?.total_balance != null ? Number(usd.total_balance) : NaN;
    return {
      provider: 'deepseek',
      availableUsd: Number.isFinite(v) ? v : null,
      detail: usd?.currency,
      fetchedAt: Date.now(),
    };
  },
  // GET /v1/users/me/balance → { data: { available_balance } }
  moonshot: async (key) => {
    const j = (await getJson('https://api.moonshot.ai/v1/users/me/balance', {
      Authorization: `Bearer ${key}`,
    })) as { data?: { available_balance?: number } };
    const v = j.data?.available_balance;
    return {
      provider: 'moonshot',
      availableUsd: typeof v === 'number' ? v : null,
      fetchedAt: Date.now(),
    };
  },
  // GET /v1/me?checklist=true → { checklist: { stripe_balance } } (negative = funds)
  deepinfra: async (key) => {
    const j = (await getJson('https://api.deepinfra.com/v1/me?checklist=true', {
      Authorization: `Bearer ${key}`,
    })) as { checklist?: { stripe_balance?: number } };
    const raw = j.checklist?.stripe_balance;
    return {
      provider: 'deepinfra',
      availableUsd: typeof raw === 'number' ? Math.max(0, -raw) : null,
      fetchedAt: Date.now(),
    };
  },
};

export const BALANCE_CAPABLE_PROVIDERS = Object.keys(FETCHERS);

/** Fetch live balances for the providers we have keys for. Failures are per-
 *  provider (a dead endpoint never breaks the billing view). */
export async function getProviderBalances(
  keys: Record<string, string | undefined>,
  opts?: { forceRefresh?: boolean },
): Promise<ProviderBalance[]> {
  const jobs = Object.entries(FETCHERS)
    .filter(([name]) => keys[name])
    .map(async ([name, fetcher]) => {
      const hit = cache.get(name);
      if (!opts?.forceRefresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
      try {
        const value = await fetcher(keys[name]!);
        cache.set(name, { at: Date.now(), value });
        return value;
      } catch {
        cache.set(name, { at: Date.now(), value: null });
        return null;
      }
    });
  return (await Promise.all(jobs)).filter((b): b is ProviderBalance => b != null);
}
