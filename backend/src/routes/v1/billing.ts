import { Elysia } from 'elysia';
import {
  getLocalTotalsByProvider,
  getReconciliation,
  getSubscriptionStatuses,
  getKoryAccountUsage,
} from '../../credit-accountant';
import { getLocalTotals } from '../../credit-accountant/db';
import { getCliUsageReports } from '../../billing/cli-usage';
import { getProviderBalances } from '../../billing/provider-balances';
import type { ProviderBalance } from '../../billing/provider-balances';
import { getContext } from '../../context';
import { resolvePricing, SUBSCRIPTION_PROVIDERS } from '../../pricing';
import { refreshModelsDevCache } from '../../providers/models-dev';
import { discoverCliAccounts } from '../../providers/cli-accounts';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { createUserCredentialsService, type UserCredential } from '../../services';
import { serverLog } from '../../logger';

const LOCAL_USER_ID = 'local-user';
const credentialsService = createUserCredentialsService();
// The settings drawer must be useful immediately. Local CLI logs can be large
// and balance endpoints are outside our control, so do not let either make a
// navigation request hang indefinitely. Their work continues and is picked up
// by the next short client poll.
const LIVE_BILLING_BUDGET_MS = 2_400;

function withinBillingBudget<T>(work: Promise<T>, fallback: T): Promise<{ value: T; refreshing: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ value: T; refreshing: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback, refreshing: true }), LIVE_BILLING_BUDGET_MS);
  });
  return Promise.race([
    work.then((value) => ({ value, refreshing: false })),
    budget,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * The dashboard headline is deliberately derived from the same live provider
 * probes shown below it.  The previous implementation only used a separately
 * polled OpenAI snapshot, so a successfully fetched OpenRouter (or other
 * supported provider) balance still appeared as "Not reported".
 */
export function summarizeProviderBalances(balances: ProviderBalance[]) {
  const reported = balances.filter((balance) => balance.availableUsd != null);
  return {
    availableCents: reported.length
      ? Math.max(0, Math.round(reported.reduce((sum, balance) => sum + balance.availableUsd!, 0) * 100))
      : null,
    providers: reported.map((balance) => balance.provider),
  };
}

function credentialMetadata(credential: UserCredential): { accountId?: string; label?: string } {
  if (credential.metadata && typeof credential.metadata === 'object') {
    return credential.metadata as { accountId?: string; label?: string };
  }
  if (typeof credential.metadata === 'string') {
    try {
      return JSON.parse(credential.metadata) as { accountId?: string; label?: string };
    } catch {
      return {};
    }
  }
  return {};
}

export function configuredAccounts(credentials: UserCredential[]) {
  const accounts = new Map<string, {
    id: string;
    provider: string;
    label: string;
    credentialTypes: Set<string>;
    createdAt: number;
    lastUsedAt?: number;
  }>();
  for (const credential of credentials.filter((entry) => entry.isActive)) {
    const metadata = credentialMetadata(credential);
    const id = metadata.accountId ?? credential.id;
    const key = `${credential.provider}:${id}`;
    const existing = accounts.get(key) ?? {
      id,
      provider: credential.provider,
      label: metadata.label?.trim() || `${credential.provider} account`,
      credentialTypes: new Set<string>(),
      createdAt: credential.createdAt,
    };
    existing.credentialTypes.add(credential.type);
    existing.createdAt = Math.min(existing.createdAt, credential.createdAt);
    if (credential.lastUsedAt != null) {
      existing.lastUsedAt = Math.max(existing.lastUsedAt ?? 0, credential.lastUsedAt);
    }
    accounts.set(key, existing);
  }
  return [...accounts.values()]
    .map((account) => ({
      ...account,
      credentialTypes: [...account.credentialTypes].sort(),
      subscription: SUBSCRIPTION_PROVIDERS.has(account.provider),
      usageAttribution: 'provider' as const,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function withDetectedCliAccounts(
  accounts: ReturnType<typeof configuredAccounts>,
  detected = discoverCliAccounts(),
) {
  const counts = new Map<string, number>();
  for (const account of detected) counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
  const existing = new Set(accounts.map((account) => `${account.provider}:${account.id}`));
  const cliAccounts = detected
    // A single implicit CLI login is normal provider configuration, not a
    // useful Billing "accounts" section. Surface autodetection here only when
    // the user genuinely has multiple identities to distinguish.
    .filter((account) => (counts.get(account.provider) ?? 0) > 1)
    .filter((account) => !existing.has(`${account.provider}:${account.id}`))
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      credentialTypes: ['cliProfile'],
      createdAt: 0,
      lastUsedAt: undefined,
      subscription: SUBSCRIPTION_PROVIDERS.has(account.provider),
      usageAttribution: 'provider' as const,
      source: account.source,
      email: account.email,
      plan: account.plan,
      health: account.health,
      profileDir: account.profileDir,
    }));
  return [...accounts, ...cliAccounts];
}

export const billingRoutes = new Elysia({ prefix: '/api/billing' }).get(
  '/credits',
  async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
    const safeResult = async <T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        serverLog.error({ err }, `Billing route failed while collecting ${name}`);
        return fallback;
      }
    };
    // Pricing reads the last known catalog synchronously. Refresh it for a
    // later visit, rather than blocking Billing on an unrelated network call.
    refreshModelsDevCache();

    const reconciliation = await safeResult('reconciliation', async () => getReconciliation(), {
      localEstimate: { totalCostUsd: 0, tokensIn: 0, tokensOut: 0, byModel: [] },
      cloudReality: [],
      driftPercent: null,
      highlightDrift: false,
    });
    const totals = await safeResult('totals', async () => getLocalTotals(), {
      totalCostUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      byModel: [],
    });
    // `gemini` was previously emitted by an obsolete provider path even though
    // it is a model family, not a configured provider. Do not resurrect those
    // stale rows; Google providers are google, aistudio, vertexai, and jules.
    const providerTotals = (await safeResult(
      'providerTotals',
      async () => getLocalTotalsByProvider(),
      [],
    )).filter((entry) => entry.provider !== 'gemini');
    const byProvider = providerTotals
      .filter((entry) => !SUBSCRIPTION_PROVIDERS.has(entry.provider))
      .map((entry) => ({
      name: entry.provider,
      spendCents: Math.round(entry.costUsd * 100),
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
    }));
    const meteredSpendUsd = providerTotals
      .filter((entry) => !SUBSCRIPTION_PROVIDERS.has(entry.provider))
      .reduce((sum, entry) => sum + entry.costUsd, 0);
    const byModel = totals.byModel.map((m) => ({
      model: m.model,
      spendCents: Math.round(m.costUsd * 100),
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      // cost 0 with real tokens = we had no verified price when it was recorded
      unpriced: m.costUsd === 0 && (m.tokensIn > 0 || m.tokensOut > 0) && resolvePricing('', m.model) == null,
    }));

    // Live balances for the providers that expose one to a normal API key.
    const configs = await safeResult('providerConfig', async () => getContext().providers.getConfigs(), {});
    const keys: Record<string, string | undefined> = {};
    for (const [name, cfg] of Object.entries(configs)) keys[name] = (cfg as { apiKey?: string }).apiKey;
    const cliUsageWork = safeResult(
      'cliUsage',
      () => getCliUsageReports({
        githubToken: (configs as Record<string, { authToken?: string }>).copilot?.authToken,
        forceRefresh,
      }),
      [],
    );
    const balanceWork = safeResult('providerBalances', () => getProviderBalances(keys, { forceRefresh }), []);
    const [cliUsageResult, balancesResult, savedCredentials, koryAccountUsage] = await Promise.all([
      withinBillingBudget(cliUsageWork, []),
      withinBillingBudget(balanceWork, []),
      safeResult('savedCredentials', () => credentialsService.list(LOCAL_USER_ID, { isActive: true }), []),
      safeResult('koryAccountUsage', async () => getKoryAccountUsage(), []),
    ]);
    const cliUsage = cliUsageResult.value;
    const balances = balancesResult.value;
    const providerBalance = summarizeProviderBalances(balances);
    const subscriptions = getSubscriptionStatuses().map((s) => ({
      provider: s.provider,
      status: s.status,
      rateLimitType: s.rateLimitType,
      resetsAt: s.resetsAt,
      resetsAtMs: s.resetsAt != null ? s.resetsAt * 1000 : undefined,
      updatedAt: s.updatedAt,
    }));

    return {
      ok: true,
      totalSpendCents: Math.round(meteredSpendUsd * 100),
      // This is an aggregate only across providers that returned a current,
      // queryable API-key balance on this request. Subscription OAuth/CLI
      // accounts are intentionally excluded: they do not publish a reliable
      // dollar balance through these credentials.
      remainingCents: providerBalance.availableCents,
      balanceProviders: providerBalance.providers,
      byProvider,
      byModel,
      subscriptions,
      // Real local usage parsed from each CLI's own session logs: token
      // windows (hour/day/week/month) and quota % + resets. Subscription
      // tokens are never converted into a made-up dollar charge.
      cliUsage,
      balances,
      // Koryphaios-owned, future-only attribution. This never reads or writes
      // external CLI histories and is the only safe per-account usage source
      // when a user shares CODEX_HOME session storage.
      koryAccountUsage,
      accounts: withDetectedCliAccounts(configuredAccounts(savedCredentials)),
      reconciliation,
      // Signals the desktop client to make a lightweight follow-up request.
      // This keeps initial navigation under three seconds without pretending
      // an unfinished provider probe is a current balance.
      refreshing: cliUsageResult.refreshing || balancesResult.refreshing,
    };
  },
);
