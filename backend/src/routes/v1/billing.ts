import { Elysia } from 'elysia';
import { getLocalTotalsByProvider, getReconciliation } from '../../credit-accountant';
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
    const remainingCents = Math.max(
      0,
      Math.round((latestCloud?.totalAvailableUsd ?? 0) * 100),
    );

    return {
      ok: true,
      totalSpendCents,
      remainingCents,
      byProvider,
      reconciliation,
    };
  },
);
