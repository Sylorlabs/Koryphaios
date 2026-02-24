/**
 * CreditAccountant module for Koryphaios backend.
 *
 * - Usage recording: from provider stream usage_update events (logical equivalent of
 *   parsing x-anthropic-usage and OpenAI usage JSON body).
 * - 2026 multiplier logic: map models to 2026 costs; persist totals to sylorlabs.db.
 * - Polling: every 15 min reconcile with OpenAI credit_grants and GitHub Copilot metrics.
 * - API: expose local estimate vs cloud reality and highlight drift > 5%.
 */

import { computeCost2026 } from "./models";
import {
  initCreditDb,
  getCreditDb,
  recordUsage as dbRecordUsage,
  getLocalTotals,
  getLatestCloudSnapshots,
} from "./db";
import { startCreditPolling, stopCreditPolling, type PollingConfig } from "./polling";

const DRIFT_THRESHOLD_PERCENT = 5;

export { getModelCost2026, computeCost2026 } from "./models";
export { initCreditDb, getLocalTotals, getLatestCloudSnapshots } from "./db";
export { startCreditPolling, stopCreditPolling, type PollingConfig } from "./polling";
export { createUsageInterceptingFetch } from "./usage-interceptor";

/**
 * Record token usage and cost to sylorlabs.db.
 * Call this when a usage_update event is received (header/body interceptor equivalent).
 */
export function recordUsage(
  model: string,
  provider: string,
  tokensIn: number,
  tokensOut: number
): void {
  const costUsd = computeCost2026(model, tokensIn ?? 0, tokensOut ?? 0);
  dbRecordUsage(model, provider, tokensIn ?? 0, tokensOut ?? 0, costUsd);
}

/**
 * Initialize the CreditAccountant: DB and optional polling.
 */
export function initCreditAccountant(dataDir: string, pollingConfig?: PollingConfig): void {
  initCreditDb(dataDir);
  if (pollingConfig && (pollingConfig.openaiApiKey || (pollingConfig.githubEnterpriseId && pollingConfig.githubToken))) {
    startCreditPolling(pollingConfig);
  }
}

/**
 * Reconciliation payload for API/UI: local estimate, cloud snapshots, drift.
 */
export function getReconciliation(): {
  localEstimate: { totalCostUsd: number; tokensIn: number; tokensOut: number; byModel: Array<{ model: string; costUsd: number; tokensIn: number; tokensOut: number }> };
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
  const openai = cloud.find((c) => c.source === "openai");
  if (openai && openai.totalUsedUsd != null && openai.totalUsedUsd > 0 && local.totalCostUsd >= 0) {
    driftPercent = Math.abs(local.totalCostUsd - openai.totalUsedUsd) / openai.totalUsedUsd * 100;
  }

  return {
    localEstimate: local,
    cloudReality: cloud,
    driftPercent,
    highlightDrift: driftPercent != null && driftPercent > DRIFT_THRESHOLD_PERCENT,
  };
}
