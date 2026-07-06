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
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

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
    // `gemini` was previously emitted by the legacy CLI-log reader even though
    // it is a model family, not a configured provider. Do not resurrect those
    // stale rows; current Google usage is recorded as google, vertexai, or
    // antigravity (custom provider ids remain supported).
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
    const [cliUsage, balances] = await Promise.all([
      getCliUsageReports({
        githubToken: (configs as Record<string, { authToken?: string }>).copilot?.authToken,
        forceRefresh,
      }),
      getProviderBalances(keys, { forceRefresh }),
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
      reconciliation,
    };
  },
);
