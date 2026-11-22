// Live account balances — only providers that expose a balance to a normal
// API key are probed (verified July–Sept 2026): OpenRouter, DeepSeek,
// Moonshot/Kimi, DeepInfra, SiliconFlow, Novita, Vultr, DigitalOcean.
// Token Harbor publishes no wallet endpoint, but it does report its live
// free-tier allowance on inference responses, so that one is read from the
// gateway's own X-TH-* headers rather than a fabricated quota.
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
  /** Provider-reported plan tier when it exposes one (Token Harbor). */
  plan?: string;
  /** 0–100 share of the provider's free allowance already consumed. */
  allowanceUsedPercent?: number;
  /** Unix-ms when the provider says the free allowance window resets. */
  allowanceResetsAt?: number;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Build one balance row from Coarena's two real account endpoints.
 *
 * `/credits` is a top-level object (`available_usd`, `held_usd`, `plan`), while
 * `/limits` wraps its payload in `data` and reports today's spend, the daily
 * allowance and the account's rate limits. Either endpoint may fail without
 * inventing the other one's numbers. `available_usd` is server-authoritative;
 * held funds are never subtracted from it a second time.
 */
export function coarenaBalanceFrom(credits: unknown, limits: unknown): ProviderBalance {
  const credit = asRecord(credits) ?? {};
  const limitsRoot = asRecord(limits);
  const limitData = asRecord(limitsRoot?.data) ?? limitsRoot ?? {};
  const today = asRecord(limitData.today) ?? {};

  const balance = asNumber(credit.balance_usd);
  const held = asNumber(credit.held_usd);
  const available =
    asNumber(credit.available_usd) ??
    (balance !== undefined && held !== undefined ? Math.max(0, balance - held) : balance);

  const used = asNumber(today.used_usd);
  const heldToday = asNumber(today.held_usd);
  const dailyLimit = asNumber(limitData.usd_per_day) ?? asNumber(credit.free_daily_usd);
  const left =
    asNumber(today.left_usd) ??
    (dailyLimit !== undefined && used !== undefined
      ? Math.max(0, dailyLimit - used - (heldToday ?? 0))
      : undefined);
  const effective = used !== undefined ? used + (heldToday ?? 0) : undefined;

  let allowanceUsedPercent: number | undefined;
  if (dailyLimit !== undefined) {
    if (dailyLimit === 0) allowanceUsedPercent = 100;
    else if (effective !== undefined) {
      allowanceUsedPercent = Math.min(100, Math.max(0, (effective / dailyLimit) * 100));
    }
  }

  const plan =
    typeof credit.plan === 'string' ? credit.plan : limitData.free === true ? 'free' : undefined;
  const resetsAt = asTimestampMs(today.resets_at);
  const rpm =
    asNumber(limitData.requests_per_minute_key) ?? asNumber(limitData.requests_per_minute_account);
  const concurrency = asNumber(limitData.concurrency);
  const detail = [
    dailyLimit !== undefined ? `$${dailyLimit.toFixed(2)}/day` : undefined,
    left !== undefined ? `$${left.toFixed(2)} left today` : undefined,
    rpm !== undefined ? `${rpm} req/min` : undefined,
    concurrency !== undefined ? `${concurrency} concurrent` : undefined,
  ].filter((part): part is string => !!part);

  // A free account has no purchased wallet, so `available_usd` is 0 while its
  // real entitlement is the daily allowance. Showing $0.00 would hide the
  // usage the user actually has; leave the wallet unknown so the billing card
  // renders the allowance percentage instead.
  const availableForDisplay =
    plan === 'free' && available === 0 && dailyLimit !== undefined ? null : available;

  return {
    provider: 'coarena',
    availableUsd: availableForDisplay ?? null,
    ...(used !== undefined ? { usedUsd: used } : {}),
    ...(plan ? { plan } : {}),
    ...(allowanceUsedPercent !== undefined ? { allowanceUsedPercent } : {}),
    ...(resetsAt !== undefined ? { allowanceResetsAt: resetsAt } : {}),
    ...(detail.length ? { detail: detail.join(' · ') } : {}),
    fetchedAt: Date.now(),
  };
}

/**
 * Build one balance row from CrowLLM's standard One API billing routes.
 *
 * The routes answered 401 unauthenticated, but their authenticated payloads
 * are not documented and were not live-verified. Parse only explicit fields:
 * a remaining/balance value is never inferred from a spend cap, and
 * `total_usage` is the One API cent value. If only a spend cap and usage are
 * available, report the percentage of that cap rather than pretending it is a
 * wallet balance.
 */
export function crowllmBalanceFrom(subscription: unknown, usage: unknown): ProviderBalance {
  const subRoot = asRecord(subscription);
  const sub = asRecord(subRoot?.data) ?? subRoot ?? {};
  const usageRoot = asRecord(usage);
  const usageData = asRecord(usageRoot?.data) ?? usageRoot ?? {};

  const explicitAvailable =
    asNumber(sub.available_usd) ??
    asNumber(sub.balance_usd) ??
    asNumber(sub.remaining_usd) ??
    asNumber(usageData.remaining_usd);

  const totalUsage = asNumber(usageData.total_usage);
  const totalUsageUsd = asNumber(usageData.total_usage_usd);
  const used =
    totalUsageUsd ??
    (totalUsage !== undefined ? totalUsage / 100 : undefined) ??
    asNumber(sub.used_usd);

  const hardLimit =
    asNumber(sub.hard_limit_usd) ??
    asNumber(sub.system_hard_limit_usd) ??
    asNumber(sub.soft_limit_usd);
  const plan = typeof sub.plan === 'string' && sub.plan.trim() ? sub.plan.trim() : undefined;

  let allowanceUsedPercent: number | undefined;
  if (hardLimit !== undefined && hardLimit > 0 && used !== undefined) {
    allowanceUsedPercent = Math.min(100, Math.max(0, (used / hardLimit) * 100));
  }

  const detail = [
    used !== undefined ? `$${used.toFixed(2)} used this period` : undefined,
    hardLimit !== undefined ? `$${hardLimit.toFixed(2)} spend cap` : undefined,
  ].filter((part): part is string => !!part);

  return {
    provider: 'crowllm',
    availableUsd: explicitAvailable ?? null,
    ...(used !== undefined ? { usedUsd: used } : {}),
    ...(plan ? { plan } : {}),
    ...(allowanceUsedPercent !== undefined ? { allowanceUsedPercent } : {}),
    ...(detail.length ? { detail: detail.join(' · ') } : {}),
    fetchedAt: Date.now(),
  };
}

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
  // Token Harbor has no key-based wallet endpoint. Its gateway does report the
  // live free allowance on every inference response, so read those headers
  // from a one-token :free call instead of inventing a quota. The free model id
  // is taken from the live catalog, never hardcoded, because the lineup rotates.
  tokenharbor: async (key) => {
    // One abort budget covers both requests, so a slow catalog cannot push the
    // billing probe past its own timeout.
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const catalogResponse = await fetch('https://tokenharbor.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (!catalogResponse.ok) throw new Error(`${catalogResponse.status}`);
    const catalog = (await catalogResponse.json()) as { data?: Array<{ id?: unknown }> };
    const freeModel = catalog.data?.find(
      (entry): entry is { id: string } =>
        typeof entry?.id === 'string' && entry.id.endsWith(':free'),
    )?.id;
    if (!freeModel) throw new Error('No free model published');

    const response = await fetch('https://tokenharbor.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: freeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal,
    });

    const plan = response.headers.get('x-th-plan')?.trim();
    const used = Number.parseFloat(response.headers.get('x-th-free-used-pct') ?? '');
    const reset = Date.parse(response.headers.get('x-th-free-resets') ?? '');
    const allowanceExhausted = response.status === 429 && Number.isFinite(used);
    if (!response.ok && !allowanceExhausted) throw new Error(`${response.status}`);
    await response.text();

    return {
      provider: 'tokenharbor',
      availableUsd: null,
      ...(plan ? { plan } : {}),
      ...(Number.isFinite(used) ? { allowanceUsedPercent: Math.min(100, Math.max(0, used)) } : {}),
      ...(Number.isFinite(reset) ? { allowanceResetsAt: reset } : {}),
      fetchedAt: Date.now(),
    };
  },
  // Coarena exposes both the wallet and today's allowance to a normal key:
  // GET /api/v1/credits → { plan, balance_usd, held_usd, available_usd, ... }
  // GET /api/v1/limits  → { data: { usd_per_day, today: { used_usd, ... } } }
  coarena: async (key) => {
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Koryphaios/1.0',
    };
    const credits = await getJson('https://coarena.ai/api/v1/credits', headers);
    // The wallet is the authoritative part; a limits failure must not hide a
    // real balance, and neither failure may manufacture a zero.
    const limits = await getJson('https://coarena.ai/api/v1/limits', headers).catch(
      () => undefined,
    );
    return coarenaBalanceFrom(credits, limits);
  },
  // CrowLLM exposes the standard One API billing routes. They answered 401
  // unauthenticated; only explicitly reported fields are used, and a failed
  // route never invents a zero wallet.
  crowllm: async (key) => {
    const headers = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Koryphaios/1.0',
    };
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    const date = (value: Date) => value.toISOString().slice(0, 10);
    const [subscription, usage] = await Promise.all([
      getJson('https://crowllm.com/v1/dashboard/billing/subscription', headers).catch(
        () => undefined,
      ),
      getJson(
        `https://crowllm.com/v1/dashboard/billing/usage?start_date=${date(start)}&end_date=${date(end)}`,
        headers,
      ).catch(() => undefined),
    ]);
    if (subscription === undefined && usage === undefined) {
      throw new Error('billing unavailable');
    }
    return crowllmBalanceFrom(subscription, usage);
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
