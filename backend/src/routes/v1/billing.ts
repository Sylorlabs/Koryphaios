import { Elysia } from 'elysia';
import {
  getLocalTotalsByProvider,
  getReconciliation,
  getSubscriptionStatuses,
} from '../../credit-accountant';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const billingRoutes = new Elysia({ prefix: '/api/billing' }).get(
  '/credits',
  async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const reconciliation = getReconciliation();
    const byProvider = getLocalTotalsByProvider().map((entry) => ({
      name: entry.provider,
      spendCents: Math.round(entry.costUsd * 100),
      tokensIn: entry.tokensIn,
      tokensOut: entry.tokensOut,
    }));
    const latestCloud = reconciliation.cloudReality.find((entry) => entry.totalAvailableUsd != null);
    const totalSpendCents = Math.round(reconciliation.localEstimate.totalCostUsd * 100);
    // Dollar balance only applies to metered (API-key) providers; null when no cloud
    // snapshot exists so the UI can distinguish "unknown" from a real $0.00 balance.
    const remainingCents =
      latestCloud?.totalAvailableUsd != null
        ? Math.max(0, Math.round(latestCloud.totalAvailableUsd * 100))
        : null;

    // Subscription providers (Claude Code, etc.) are flat-rate — report quota windows
    // (rate-limit reset times) instead of a meaningless dollar balance.
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
      totalSpendCents,
      remainingCents,
      byProvider,
      subscriptions,
      reconciliation,
    };
  },
);
