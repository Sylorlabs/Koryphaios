import { Elysia } from 'elysia';
import {
  getLocalTotalsByProvider,
  getReconciliation,
  getSubscriptionStatuses,
} from '../../credit-accountant';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { MODEL_CATALOG } from '../../providers/models';
import { PROVIDER_AUTH_MODE } from '../../providers/constants';
import type { ProviderName } from '@koryphaios/shared';

export const billingRoutes = new Elysia({ prefix: '/api/billing' })
  // Central pricing hub: per-provider model pricing from the single source of truth
  // (the model catalog / ModelDefs). Subscription/CLI providers are flat-rate (no per-token cost).
  .get('/pricing', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const byProvider = new Map<
      string,
      Array<{ id: string; name: string; inputPerM: number | null; outputPerM: number | null; cachedInputPerM: number | null }>
    >();
    for (const m of Object.values(MODEL_CATALOG)) {
      const list = byProvider.get(m.provider) ?? [];
      list.push({
        id: m.id,
        name: m.name,
        inputPerM: m.costPerMInputTokens ?? null,
        outputPerM: m.costPerMOutputTokens ?? null,
        cachedInputPerM: m.costPerMInputCached ?? null,
      });
      byProvider.set(m.provider, list);
    }
    const providers = [...byProvider.entries()]
      .map(([name, models]) => {
        const authMode = PROVIDER_AUTH_MODE[name as ProviderName];
        // Subscription = CLI/auth-only providers OR providers whose models carry no per-token price.
        const metered = models.some((x) => (x.inputPerM ?? 0) > 0 || (x.outputPerM ?? 0) > 0);
        return {
          name,
          subscription: authMode === 'auth_only' || !metered,
          models: models.sort((a, b) => (b.inputPerM ?? 0) - (a.inputPerM ?? 0)),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, providers };
  })
  .get(
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
