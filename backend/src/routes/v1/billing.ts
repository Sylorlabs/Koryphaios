import { Elysia } from 'elysia';
import {
  getReconciliation,
  getSubscriptionStatuses,
  getKoryAccountUsage,
  getUsageCostBreakdown,
  getUsageEventsSince,
  repriceUnknownUsage,
} from '../../credit-accountant';
import {
  summarizeBillingSpend,
  summarizeSessionCosts,
  summarizeUsageAnalytics,
} from '../../billing/cost-summary';
import { getCliUsageReports } from '../../billing/cli-usage';
import type { CliUsageReport } from '../../billing/cli-usage';
import { getProviderBalances } from '../../billing/provider-balances';
import type { ProviderBalance } from '../../billing/provider-balances';
import { getContext } from '../../context';
import { SUBSCRIPTION_PROVIDERS } from '../../pricing';
import { refreshModelsDevCache } from '../../providers/models-dev';
import { discoverCliAccounts } from '../../providers/cli-accounts';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { createUserCredentialsService, type UserCredential } from '../../services';
import { serverLog } from '../../logger';
import { AuthenticationError } from '../../errors/types';

const LOCAL_USER_ID = 'local-user';
const credentialsService = createUserCredentialsService();
const LIVE_BILLING_BUDGET_MS = 2_400;
const LIVE_SOURCE_FRESH_MS = 15_000;
const LIVE_SOURCE_FAILURE_BACKOFF_MS = 10_000;
const LIVE_SOURCE_ATTEMPTS = 2;

interface LiveSourceState<T> {
  value: T;
  updatedAt?: number;
  lastAttemptAt?: number;
  lastFailureAt?: number;
  inFlight?: Promise<T>;
}

const cliUsageState: LiveSourceState<CliUsageReport[]> = { value: [] };
const balanceState: LiveSourceState<ProviderBalance[]> = { value: [] };

function withinBillingBudget<T>(
  work: Promise<T>,
  fallback: T,
): Promise<{ value: T; refreshing: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ value: T; refreshing: boolean }>((resolve) => {
    timer = setTimeout(
      () => resolve({ value: fallback, refreshing: true }),
      LIVE_BILLING_BUDGET_MS,
    );
    timer.unref?.();
  });
  return Promise.race([work.then((value) => ({ value, refreshing: false })), budget]).finally(
    () => {
      if (timer) clearTimeout(timer);
    },
  );
}

async function retryLiveSource<T>(name: string, loader: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LIVE_SOURCE_ATTEMPTS; attempt += 1) {
    try {
      return await loader();
    } catch (err: unknown) {
      lastError = err;
      serverLog.warn(
        { err, source: name, attempt },
        `Billing live source attempt ${attempt} failed`,
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${name} refresh failed`);
}

function beginLiveRefresh<T>(
  name: string,
  state: LiveSourceState<T>,
  loader: () => Promise<T>,
  forceRefresh: boolean,
): Promise<T> | null {
  if (state.inFlight) return state.inFlight;
  const now = Date.now();
  if (!forceRefresh && state.updatedAt && now - state.updatedAt < LIVE_SOURCE_FRESH_MS) return null;
  if (
    !forceRefresh &&
    state.lastFailureAt &&
    now - state.lastFailureAt < LIVE_SOURCE_FAILURE_BACKOFF_MS
  ) {
    return null;
  }

  state.lastAttemptAt = now;
  const work = retryLiveSource(name, loader)
    .then((value) => {
      state.value = value;
      state.updatedAt = Date.now();
      state.lastFailureAt = undefined;
      return value;
    })
    .catch((err: unknown) => {
      state.lastFailureAt = Date.now();
      serverLog.error({ err, source: name }, 'Billing live source refresh exhausted retries');
      return state.value;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
  state.inFlight = work;
  return work;
}

function liveSourceHealth<T>(state: LiveSourceState<T>, refreshing: boolean) {
  const now = Date.now();
  const status = refreshing
    ? 'refreshing'
    : state.updatedAt && now - state.updatedAt < LIVE_SOURCE_FRESH_MS
      ? 'fresh'
      : state.updatedAt
        ? 'stale'
        : state.lastFailureAt
          ? 'error'
          : 'idle';
  return {
    status,
    updatedAt: state.updatedAt ?? null,
    lastAttemptAt: state.lastAttemptAt ?? null,
    lastFailureAt: state.lastFailureAt ?? null,
  };
}

async function readLiveSource<T>(
  name: string,
  state: LiveSourceState<T>,
  loader: () => Promise<T>,
  forceRefresh: boolean,
) {
  const work = beginLiveRefresh(name, state, loader, forceRefresh);
  if (!work) {
    return { value: state.value, refreshing: false, health: liveSourceHealth(state, false) };
  }
  const result = await withinBillingBudget(work, state.value);
  return { ...result, health: liveSourceHealth(state, result.refreshing) };
}

async function safeBillingResult<T>(
  name: string,
  work: () => Promise<T> | T,
  fallback: T,
): Promise<T> {
  try {
    return await work();
  } catch (err: unknown) {
    serverLog.error({ err }, `Billing route failed while collecting ${name}`);
    return fallback;
  }
}

function excludedProviders(request: Request): Set<string> {
  return new Set(
    new URL(request.url).searchParams
      .getAll('excludeProvider')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  );
}

function providerAllowed(provider: string, excluded: Set<string>): boolean {
  return !excluded.has(provider.trim().toLowerCase());
}

/**
 * The dashboard headline is deliberately derived from the same live provider
 * probes shown below it. A failed refresh keeps the last known good values.
 */
export function summarizeProviderBalances(balances: ProviderBalance[]) {
  const reported = balances.filter((balance) => balance.availableUsd != null);
  return {
    availableCents: reported.length
      ? Math.max(
          0,
          Math.round(reported.reduce((sum, balance) => sum + balance.availableUsd!, 0) * 100),
        )
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
    } catch (err: unknown) {
      serverLog.debug({ err }, 'Credential metadata is not valid JSON, returning empty');
      return {};
    }
  }
  return {};
}

export function configuredAccounts(credentials: UserCredential[]) {
  const accounts = new Map<
    string,
    {
      id: string;
      provider: string;
      label: string;
      credentialTypes: Set<string>;
      createdAt: number;
      lastUsedAt?: number;
    }
  >();
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
  for (const account of detected)
    counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
  const existing = new Set(accounts.map((account) => `${account.provider}:${account.id}`));
  const cliAccounts = detected
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

function refreshPricingCatalogInBackground(): void {
  try {
    void Promise.resolve(refreshModelsDevCache())
      .then(() => {
        repriceUnknownUsage(1_000);
      })
      .catch((err: unknown) => {
        serverLog.debug({ err }, 'Could not refresh models.dev pricing');
      });
  } catch (err: unknown) {
    serverLog.debug({ err }, 'Could not schedule models.dev pricing refresh');
  }
}

export const billingRoutes = new Elysia({ prefix: '/api/billing' })
  .get('/session-costs', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const excluded = excludedProviders(request);
    await safeBillingResult('repricing', () => repriceUnknownUsage(1_000), {
      scanned: 0,
      repriced: 0,
    });
    refreshPricingCatalogInBackground();
    const rows = (
      await safeBillingResult('session-costs', () => getUsageCostBreakdown(), [])
    ).filter((row) => providerAllowed(row.provider, excluded));
    const detailed = summarizeSessionCosts(rows);
    const sessions = Object.fromEntries(
      Object.entries(detailed).map(([sessionId, summary]) => [
        sessionId,
        {
          spendUsd: summary.spendUsd,
          spendCents: summary.spendCents,
          hasKnownCost: summary.hasKnownCost,
          pricingIncomplete: summary.pricingIncomplete,
          hasMeteredUsage: summary.hasMeteredUsage,
          hasSubscriptionUsage: summary.hasSubscriptionUsage,
        },
      ]),
    );
    return { ok: true, sessions };
  })
  .get('/session/:sessionId', async ({ params, request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const excluded = excludedProviders(request);
    await safeBillingResult('repricing', () => repriceUnknownUsage(1_000), {
      scanned: 0,
      repriced: 0,
    });
    refreshPricingCatalogInBackground();
    const rows = (
      await safeBillingResult(
        'session-cost-detail',
        () => getUsageCostBreakdown(params.sessionId),
        [],
      )
    ).filter((row) => providerAllowed(row.provider, excluded));
    const summary = summarizeSessionCosts(rows)[params.sessionId] ?? null;
    return { ok: true, summary };
  })
  .get('/credits', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const requestUrl = new URL(request.url);
    const forceRefresh = requestUrl.searchParams.get('refresh') === '1';
    const excluded = excludedProviders(request);

    // Use the last known catalog synchronously, then refresh it for a later
    // pass. Unknown historical rows are retried in bounded local batches.
    const repricing = await safeBillingResult('repricing', () => repriceUnknownUsage(1_000), {
      scanned: 0,
      repriced: 0,
    });
    refreshPricingCatalogInBackground();

    const reconciliation = await safeBillingResult('reconciliation', () => getReconciliation(), {
      localEstimate: { totalCostUsd: 0, tokensIn: 0, tokensOut: 0, byModel: [] },
      cloudReality: [],
      driftPercent: null,
      highlightDrift: false,
    });
    const allUsageRows = await safeBillingResult(
      'usage-cost-breakdown',
      () => getUsageCostBreakdown(),
      [],
    );
    const visibleUsageRows = allUsageRows.filter((row) => providerAllowed(row.provider, excluded));
    const spend = summarizeBillingSpend(visibleUsageRows);

    const now = Date.now();
    const ninetyOneDaysAgo = now - 91 * 24 * 60 * 60 * 1_000;
    const rawUsageEvents = await safeBillingResult(
      'usage-events-since',
      () => getUsageEventsSince(ninetyOneDaysAgo),
      [],
    );
    const visibleUsageEvents = rawUsageEvents.filter((row) =>
      providerAllowed(row.provider, excluded),
    );
    const analytics = summarizeUsageAnalytics(visibleUsageEvents, now);

    const configs = await safeBillingResult(
      'providerConfig',
      () => getContext().providers.getConfigs(),
      {},
    );
    const keys: Record<string, string | undefined> = {};
    for (const [name, cfg] of Object.entries(configs)) {
      if (providerAllowed(name, excluded)) keys[name] = (cfg as { apiKey?: string }).apiKey;
    }

    const cliUsageResultPromise = readLiveSource(
      'cliUsage',
      cliUsageState,
      () =>
        getCliUsageReports({
          githubToken: (configs as Record<string, { authToken?: string }>).copilot?.authToken,
          forceRefresh,
        }),
      forceRefresh,
    );
    const balancesResultPromise = readLiveSource(
      'providerBalances',
      balanceState,
      () => getProviderBalances(keys, { forceRefresh }),
      forceRefresh,
    );

    const providerStates = new Map(
      getContext()
        .providers.getStatus()
        .map((provider) => [provider.name, provider] as const),
    );
    const detectedCliAccounts = discoverCliAccounts().map((account) => {
      const providerState = providerStates.get(account.provider);
      return {
        ...account,
        connectionState:
          providerState?.connectionState === 'verified'
            ? ('connected' as const)
            : providerState?.connectionState === 'failed'
              ? ('failed' as const)
              : ('detected' as const),
      };
    });

    const [cliUsageResult, balancesResult, savedCredentials, koryAccountUsage] = await Promise.all([
      cliUsageResultPromise,
      balancesResultPromise,
      safeBillingResult(
        'savedCredentials',
        () => credentialsService.list(LOCAL_USER_ID, { isActive: true }),
        [],
      ),
      safeBillingResult('koryAccountUsage', () => getKoryAccountUsage(), []),
    ]);

    const rawCliUsage = cliUsageResult.value;
    const rawBalances = balancesResult.value;
    const cliUsage = rawCliUsage.filter((entry) => providerAllowed(entry.provider, excluded));
    const balances = rawBalances.filter((entry) => providerAllowed(entry.provider, excluded));
    const providerBalance = summarizeProviderBalances(balances);
    const subscriptions = getSubscriptionStatuses()
      .filter((status) => providerAllowed(status.provider, excluded))
      .map((status) => ({
        provider: status.provider,
        status: status.status,
        rateLimitType: status.rateLimitType,
        resetsAt: status.resetsAt,
        resetsAtMs: status.resetsAt != null ? status.resetsAt * 1000 : undefined,
        updatedAt: status.updatedAt,
      }));

    const availableBillingProviders = [
      ...new Set([
        ...allUsageRows.map((row) => row.provider),
        ...Object.keys(configs),
        ...rawCliUsage.map((entry) => entry.provider),
        ...rawBalances.map((entry) => entry.provider),
        ...detectedCliAccounts.map((entry) => entry.provider),
      ]),
    ]
      .filter((provider) => provider && provider !== 'gemini')
      .sort((a, b) => a.localeCompare(b));

    return {
      ok: true,
      totalSpendUsd: spend.totalSpendUsd,
      totalSpendCents: spend.totalSpendCents,
      hasKnownSpend: spend.hasKnownSpend,
      pricingIncomplete: spend.pricingIncomplete,
      remainingCents: providerBalance.availableCents,
      balanceProviders: providerBalance.providers,
      byProvider: spend.byProvider,
      byModel: spend.byModel,
      analytics,
      subscriptions,
      cliUsage,
      balances,
      koryAccountUsage,
      accounts: withDetectedCliAccounts(configuredAccounts(savedCredentials), detectedCliAccounts),
      detectedCliAccounts,
      reconciliation,
      availableBillingProviders,
      repricing,
      sourceHealth: {
        cliUsage: cliUsageResult.health,
        providerBalances: balancesResult.health,
      },
      refreshing: cliUsageResult.refreshing || balancesResult.refreshing,
    };
  });
