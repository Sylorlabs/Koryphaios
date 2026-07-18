import { Elysia } from 'elysia';
import {
  getLocalTotalsByProvider,
  getReconciliation,
  getSubscriptionStatuses,
} from '../../credit-accountant';
import { getLocalTotals } from '../../credit-accountant/db';
import { getCliUsageReports } from '../../billing/cli-usage';
import { getProviderBalances } from '../../billing/provider-balances';
import { getContext } from '../../context';
import { resolvePricing, SUBSCRIPTION_PROVIDERS } from '../../pricing';
import { warmModelsDevCache } from '../../providers/models-dev';
import { discoverCliAccounts } from '../../providers/cli-accounts';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { createUserCredentialsService, type UserCredential } from '../../services';

const LOCAL_USER_ID = 'local-user';
const credentialsService = createUserCredentialsService();

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
    // Prices come from the live models.dev catalog — make sure it is loaded
    // before computing anything (bounded to ~5s; falls back to static catalog).
    await warmModelsDevCache();

    const reconciliation = getReconciliation();
    const totals = getLocalTotals();
    // `gemini` was previously emitted by an obsolete provider path even though
    // it is a model family, not a configured provider. Do not resurrect those
    // stale rows; Google providers are google, aistudio, vertexai, and jules.
    const providerTotals = getLocalTotalsByProvider().filter((entry) => entry.provider !== 'gemini');
    const byProvider = providerTotals.map((entry) => ({
      name: entry.provider,
      spendCents: Math.round(entry.costUsd * 100),
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
      subscription: SUBSCRIPTION_PROVIDERS.has(entry.provider),
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

    const latestCloud = reconciliation.cloudReality.find((entry) => entry.totalAvailableUsd != null);
    const remainingCents =
      latestCloud?.totalAvailableUsd != null
        ? Math.max(0, Math.round(latestCloud.totalAvailableUsd * 100))
        : null;

    // Live balances for the providers that expose one to a normal API key.
    const configs = getContext().providers.getConfigs();
    const keys: Record<string, string | undefined> = {};
    for (const [name, cfg] of Object.entries(configs)) keys[name] = (cfg as { apiKey?: string }).apiKey;
    const [cliUsage, balances, savedCredentials] = await Promise.all([
      getCliUsageReports({
        githubToken: (configs as Record<string, { authToken?: string }>).copilot?.authToken,
        forceRefresh,
      }),
      getProviderBalances(keys, { forceRefresh }),
      credentialsService.list(LOCAL_USER_ID, { isActive: true }),
    ]);
    const subscriptionInferenceCents = Math.round(
      cliUsage.reduce((sum, report) => {
        const month = report.windows.find((window) => window.period === 'month');
        return sum + (month?.inferenceValueUsd ?? 0);
      }, 0) * 100,
    );

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
      subscriptionInferenceCents,
      allSpendCents: Math.round(meteredSpendUsd * 100) + subscriptionInferenceCents,
      remainingCents,
      byProvider,
      byModel,
      subscriptions,
      // Real local usage parsed from each CLI's own session logs: token
      // windows (hour/day/week/month), quota % + resets, inference value.
      cliUsage,
      balances,
      accounts: withDetectedCliAccounts(configuredAccounts(savedCredentials)),
      reconciliation,
    };
  },
);
