import { getSubscriptionStatuses, type SubscriptionStatus } from '../credit-accountant';
import { getCliUsageReports, type CliUsageReport } from './cli-usage';
import { getProviderBalances, type ProviderBalance } from './provider-balances';

export type ResourceBudgetState = 'available' | 'low' | 'exhausted' | 'rate_limited' | 'unknown';

export interface ResourceBudgetEntry {
  provider: string;
  accountId?: string;
  accountLabel?: string;
  kind: 'api_balance' | 'subscription_quota';
  state: ResourceBudgetState;
  availableUsd?: number;
  usedPercent?: number;
  resetsAt?: number;
  window?: string;
  planType?: string;
  source: 'provider_api' | 'provider_cli' | 'runtime_observation';
  authoritative: true;
  observedAt: number;
  detail?: string;
}

export interface ResourceBudgetSnapshot {
  generatedAt: number;
  entries: ResourceBudgetEntry[];
  limitations: string[];
  decisionPolicy: string;
}

export interface ResourceBudgetDependencies {
  getBalances?: (keys: Record<string, string | undefined>) => Promise<ProviderBalance[]>;
  getCliUsage?: (options: { githubToken?: string }) => Promise<CliUsageReport[]>;
  getSubscriptions?: () => SubscriptionStatus[];
  timeoutMs?: number;
}

const stateForQuota = (usedPercent: number): ResourceBudgetState =>
  usedPercent >= 100 ? 'exhausted' : usedPercent >= 90 ? 'low' : 'available';

const withDeadline = async <T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Build the secret-free resource view agents may use for capacity decisions. */
export async function collectResourceBudgetSnapshot(
  configs: Record<string, { apiKey?: string; authToken?: string }>,
  dependencies: ResourceBudgetDependencies = {},
): Promise<ResourceBudgetSnapshot> {
  const timeoutMs = dependencies.timeoutMs ?? 2_200;
  const keys = Object.fromEntries(
    Object.entries(configs).map(([provider, config]) => [provider, config.apiKey]),
  );
  const limitations: string[] = [];
  const [balances, cliUsage] = await Promise.all([
    withDeadline(
      (dependencies.getBalances ?? ((values) => getProviderBalances(values)))(keys),
      timeoutMs,
    ),
    withDeadline(
      (dependencies.getCliUsage ?? ((options) => getCliUsageReports(options)))({
        githubToken: configs.copilot?.authToken,
      }),
      timeoutMs,
    ),
  ]);
  if (!balances) limitations.push('API balance refresh exceeded the bounded collection window; no stale value was invented.');
  if (!cliUsage) limitations.push('CLI quota refresh exceeded the bounded collection window; no stale value was invented.');

  const entries: ResourceBudgetEntry[] = [];
  for (const balance of balances ?? []) {
    entries.push({
      provider: balance.provider,
      kind: 'api_balance',
      state: balance.availableUsd == null ? 'unknown' : balance.availableUsd <= 0 ? 'exhausted' : 'available',
      ...(balance.availableUsd == null ? {} : { availableUsd: balance.availableUsd }),
      source: 'provider_api',
      authoritative: true,
      observedAt: balance.fetchedAt,
      ...(balance.detail ? { detail: balance.detail } : {}),
    });
  }
  for (const report of cliUsage ?? []) {
    for (const quota of report.quotas) {
      entries.push({
        provider: report.provider,
        ...(report.accountId ? { accountId: report.accountId } : {}),
        ...(report.accountLabel ? { accountLabel: report.accountLabel } : {}),
        kind: 'subscription_quota',
        state: stateForQuota(quota.usedPercent),
        usedPercent: quota.usedPercent,
        ...(quota.resetsAt == null ? {} : { resetsAt: quota.resetsAt }),
        window: quota.label,
        ...(report.planType ? { planType: report.planType } : {}),
        source: 'provider_cli',
        authoritative: true,
        observedAt: report.updatedAt,
      });
    }
  }
  for (const status of (dependencies.getSubscriptions ?? getSubscriptionStatuses)()) {
    const normalized = status.status?.toLowerCase();
    entries.push({
      provider: status.provider,
      kind: 'subscription_quota',
      state: normalized === 'rejected' ? 'rate_limited' : normalized === 'allowed_warning' ? 'low' : normalized === 'allowed' ? 'available' : 'unknown',
      ...(status.resetsAt == null ? {} : { resetsAt: status.resetsAt * 1_000 }),
      ...(status.rateLimitType ? { window: status.rateLimitType } : {}),
      source: 'runtime_observation',
      authoritative: true,
      observedAt: status.updatedAt,
      ...(status.status ? { detail: status.status } : {}),
    });
  }

  limitations.push(
    'Only provider-reported API balances and quota windows are shown. Missing providers are unknown, not zero.',
    'Subscription dollar balances are not inferred from token usage or API-equivalent value.',
  );
  return {
    generatedAt: Date.now(),
    entries: entries.sort((left, right) => right.observedAt - left.observedAt),
    limitations,
    decisionPolicy: 'Treat only exhausted or rate_limited authoritative entries as unavailable. Treat missing or unknown data as unknown and preserve explicit user provider choices.',
  };
}
