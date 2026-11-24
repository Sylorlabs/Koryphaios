/**
 * CreditAccountant module for Koryphaios backend.
 *
 * - Usage recording: from provider stream usage_update events (logical equivalent of
 *   parsing x-anthropic-usage and OpenAI usage JSON body).
 * - 2026 multiplier logic: map models to 2026 costs; persist totals to sylorlabs.db.
 * - Polling: every 15 min reconcile with OpenAI credit_grants and GitHub Copilot metrics.
 * - API: expose local estimate vs cloud reality and highlight drift > 5%.
 */

import { computeCostUsd, SUBSCRIPTION_PROVIDERS } from '../pricing';
import {
  initCreditDb,
  getCreditDb,
  recordUsage as dbRecordUsage,
  getLocalTotals,
  getLocalTotalsByProvider,
  getLatestCloudSnapshots,
  getKoryAccountUsage,
  getUsageSamplesByProvider,
  getPromptCacheUsageSummary,
  getUsageCostBreakdown,
  getUsageEventsSince,
  getUnknownCostUsage,
  setUsageKnownCost,
  type CreditUsageEventRow,
} from './db';
import type { RunRevisionRef } from '@koryphaios/shared';
import {
  startCreditPolling,
  stopCreditPolling,
  markCreditUsage,
  type PollingConfig,
} from './polling';

const DRIFT_THRESHOLD_PERCENT = 5;

export { getModelCost2026, computeCost2026 } from './models';
export {
  initCreditDb,
  getLocalTotals,
  getLocalTotalsByProvider,
  getLatestCloudSnapshots,
  getKoryAccountUsage,
  getUsageSamplesByProvider,
  getPromptCacheUsageSummary,
  getUsageCostBreakdown,
  getUsageEventsSince,
  getCreditDbPath,
  type CreditUsageEventRow,
} from './db';
export {
  startCreditPolling,
  stopCreditPolling,
  markCreditUsage,
  type PollingConfig,
} from './polling';
export { createUsageInterceptingFetch } from './usage-interceptor';

/**
 * Record token usage and cost to sylorlabs.db.
 * Call this when a usage_update event is received (header/body interceptor equivalent).
 */
export function recordUsage(
  model: string,
  provider: string,
  tokensIn: number,
  tokensOut: number,
  attribution?: { accountId?: string; sessionId?: string; runRef?: RunRevisionRef },
  cacheUsage?: {
    reportedCostUsd?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    ttftMs?: number;
    latencyMs?: number;
  },
): void {
  if (!model.trim() || !provider.trim() || (tokensIn <= 0 && tokensOut <= 0)) return;
  // Real prices: models.dev live catalog → static ModelDef catalog. Unpriced
  // models record cost 0 and are surfaced as "unpriced" by the billing route.
  // Subscription/auth harness usage is real usage but not metered API spend.
  const priced = SUBSCRIPTION_PROVIDERS.has(provider)
    ? null
    : computeCostUsd(provider, model, tokensIn ?? 0, tokensOut ?? 0, cacheUsage);
  const costUsd = priced?.costUsd ?? 0;
  // Subscription usage is classified, but never counted as metered per-turn spend.
  const costKnown = SUBSCRIPTION_PROVIDERS.has(provider) || priced != null;
  const baseline = SUBSCRIPTION_PROVIDERS.has(provider)
    ? null
    : computeCostUsd(provider, model, tokensIn ?? 0, tokensOut ?? 0);
  const cacheSavingsUsd = baseline && priced ? baseline.costUsd - priced.costUsd : 0;
  dbRecordUsage(model, provider, tokensIn ?? 0, tokensOut ?? 0, costUsd, attribution, {
    costKnown,
    cacheReadTokens: cacheUsage?.cacheReadTokens,
    cacheWriteTokens: cacheUsage?.cacheWriteTokens,
    cacheSavingsUsd,
    ttftMs: cacheUsage?.ttftMs,
    latencyMs: cacheUsage?.latencyMs,
  });
  markCreditUsage();
}

/** Retry a bounded batch of historical rows after pricing catalogs improve. */
export function repriceUnknownUsage(limit = 1_000): { scanned: number; repriced: number } {
  const rows = getUnknownCostUsage(limit);
  let repriced = 0;
  for (const row of rows) {
    if (SUBSCRIPTION_PROVIDERS.has(row.provider)) {
      setUsageKnownCost(row.id, 0, 0);
      repriced += 1;
      continue;
    }
    const priced = computeCostUsd(row.provider, row.model, row.tokensIn, row.tokensOut, {
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    });
    if (!priced) continue;
    const baseline = computeCostUsd(row.provider, row.model, row.tokensIn, row.tokensOut);
    const cacheSavingsUsd = baseline ? Math.max(0, baseline.costUsd - priced.costUsd) : 0;
    setUsageKnownCost(row.id, priced.costUsd, cacheSavingsUsd);
    repriced += 1;
  }
  return { scanned: rows.length, repriced };
}

/**
 * Initialize the CreditAccountant: DB and optional polling.
 */
export function initCreditAccountant(dataDir: string, pollingConfig?: PollingConfig): void {
  initCreditDb(dataDir);
  if (
    pollingConfig &&
    (pollingConfig.openaiApiKey || (pollingConfig.githubEnterpriseId && pollingConfig.githubToken))
  ) {
    startCreditPolling(pollingConfig);
  }
}

// ─── Subscription quota tracking ──────────────────────────────────────────────
// Subscription providers (Claude Code, Codex, Copilot, …) are flat-rate: there is
// no per-token dollar "remaining balance" to report. Instead they expose rate-limit
// windows. We keep the latest window in memory so the billing route can surface real
// quota status for these providers instead of meaningless $0 balances.

export interface SubscriptionStatus {
  provider: string;
  /** e.g. "allowed" | "allowed_warning" | "rejected" */
  status?: string;
  /** e.g. "five_hour" */
  rateLimitType?: string;
  /** epoch seconds when the current window resets */
  resetsAt?: number;
  /** epoch ms when this status was last observed */
  updatedAt: number;
}

const subscriptionStatuses = new Map<string, SubscriptionStatus>();

/** Record a Claude Code rate-limit window observed from the CLI harness stream. */
export function recordClaudeCodeRateLimit(info: {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
}): void {
  subscriptionStatuses.set('claude', {
    provider: 'claude',
    status: info.status,
    rateLimitType: info.rateLimitType,
    resetsAt: info.resetsAt,
    updatedAt: Date.now(),
  });
}

/** Latest known subscription quota windows, for the billing/subscription route. */
export function getSubscriptionStatuses(): SubscriptionStatus[] {
  return [...subscriptionStatuses.values()];
}

/**
 * Reconciliation payload for API/UI: local estimate, cloud snapshots, drift.
 */
export function getReconciliation(): {
  localEstimate: {
    totalCostUsd: number;
    tokensIn: number;
    tokensOut: number;
    byModel: Array<{ model: string; costUsd: number; tokensIn: number; tokensOut: number }>;
  };
  cloudReality: Array<{
    source: string;
    ts: number;
    totalUsedUsd: number | null;
    totalGrantedUsd: number | null;
    totalAvailableUsd: number | null;
    payload: string;
  }>;
  driftPercent: number | null;
  highlightDrift: boolean;
} {
  const local = getLocalTotals();
  const cloud = getLatestCloudSnapshots();

  let driftPercent: number | null = null;
  const openai = cloud.find((c) => c.source === 'openai');
  if (openai && openai.totalUsedUsd != null && openai.totalUsedUsd > 0 && local.totalCostUsd >= 0) {
    driftPercent = (Math.abs(local.totalCostUsd - openai.totalUsedUsd) / openai.totalUsedUsd) * 100;
  }

  return {
    localEstimate: local,
    cloudReality: cloud,
    driftPercent,
    highlightDrift: driftPercent != null && driftPercent > DRIFT_THRESHOLD_PERCENT,
  };
}
