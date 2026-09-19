// Live account balances — only providers that expose a balance to a normal
// API key are probed (verified July–Sept 2026): OpenRouter, DeepSeek,
// Moonshot/Kimi, DeepInfra, SiliconFlow, Novita, Vultr, DigitalOcean.
// Everything else has no key-based endpoint: OpenAI needs a session or admin
// key, xAI needs a management key + team id, Fireworks balance is an internal
// gRPC method, Together billing needs org scope, Anthropic/Google/Groq/Cohere/
// Mistral expose nothing, voice providers report characters (not USD), and
// cloud/enterprise providers need separate IAM. Failures are per-provider and
// resolve to null, so an unsupported provider never breaks the billing view.

export interface ProviderBalance {
  provider: string;
  /** USD available; null when the provider reported something unparseable. */
  availableUsd: number | null;
  /** Lifetime/period usage USD when the endpoint reports it (OpenRouter). */
  usedUsd?: number;
  detail?: string;
  fetchedAt: number;
}

const cache = new Map<string, { at: number; value: ProviderBalance }>();
const inFlight = new Map<string, Promise<ProviderBalance | null>>();
const failures = new Map<string, { at: number; error: string }>();
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 15_000;
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
  // GET /v1/user/info → { data: { totalBalance: "88.88" } } (USD string)
  siliconflow: async (key) => {
    const j = (await getJson('https://api.siliconflow.cn/v1/user/info', {
      Authorization: `Bearer ${key}`,
    })) as { data?: { totalBalance?: string; balance?: string } };
    const raw = j.data?.totalBalance ?? j.data?.balance;
    const v = raw != null ? Number(raw) : NaN;
    return {
      provider: 'siliconflow',
      availableUsd: Number.isFinite(v) ? v : null,
      fetchedAt: Date.now(),
    };
  },
  // GET /openapi/v1/billing/balance/detail → { availableBalance: "1000000" }
  // (unit is 1/10000 USD, so 10000 = $1.00)
  'novita-ai': async (key) => {
    const j = (await getJson('https://api.novita.ai/openapi/v1/billing/balance/detail', {
      Authorization: `Bearer ${key}`,
    })) as { availableBalance?: string };
    const v = j.availableBalance != null ? Number(j.availableBalance) / 10_000 : NaN;
    return {
      provider: 'novita-ai',
      availableUsd: Number.isFinite(v) ? v : null,
      fetchedAt: Date.now(),
    };
  },
  // GET /v2/account → { account: { balance, pending_charges } }
  // (negative balance = credit; pending charges are unbilled usage)
  vultr: async (key) => {
    const j = (await getJson('https://api.vultr.com/v2/account', {
      Authorization: `Bearer ${key}`,
    })) as { account?: { balance?: number; pending_charges?: number } };
    const balance = j.account?.balance;
    const pending = j.account?.pending_charges ?? 0;
    return {
      provider: 'vultr',
      availableUsd: typeof balance === 'number' ? Math.max(0, -balance - pending) : null,
      detail: typeof balance === 'number' ? `pending $${pending.toFixed(2)}` : undefined,
      fetchedAt: Date.now(),
    };
  },
  // GET /v2/customers/my/balance → { account_balance: "12.23", month_to_date_usage }
  digitalocean: async (key) => {
    const j = (await getJson('https://api.digitalocean.com/v2/customers/my/balance', {
      Authorization: `Bearer ${key}`,
    })) as { account_balance?: string; month_to_date_usage?: string };
    const v = j.account_balance != null ? Number(j.account_balance) : NaN;
    const used = j.month_to_date_usage != null ? Number(j.month_to_date_usage) : NaN;
    return {
      provider: 'digitalocean',
      availableUsd: Number.isFinite(v) ? Math.max(0, v) : null,
      ...(Number.isFinite(used) ? { usedUsd: used } : {}),
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
      const now = Date.now();
      const hit = cache.get(name);
      if (!opts?.forceRefresh && hit && now - hit.at < CACHE_TTL_MS) return hit.value;

      const failure = failures.get(name);
      if (!opts?.forceRefresh && failure && now - failure.at < FAILURE_BACKOFF_MS) {
        return hit?.value ?? null;
      }

      let request = inFlight.get(name);
      if (!request) {
        request = fetcher(keys[name]!)
          .then((value) => {
            cache.set(name, { at: Date.now(), value });
            failures.delete(name);
            return value;
          })
          .catch((err: unknown) => {
            failures.set(name, {
              at: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            });
            return cache.get(name)?.value ?? null;
          })
          .finally(() => {
            inFlight.delete(name);
          });
        inFlight.set(name, request);
      }
      return request;
    });
  return (await Promise.all(jobs)).filter((b): b is ProviderBalance => b != null);
}
