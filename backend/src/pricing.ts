// Pricing hub — the single place that answers "what does this model cost?".
//
// Resolution order:
//   1. models.dev live catalog (refreshed daily; covers every major provider)
//   2. the static ModelDef catalog's costPerM fields (curated in-repo)
//   3. null — unknown. Callers must surface "unpriced", never invent a number.
//
// CLI subscription providers (claude, codex, grok, cursor, copilot,
// antigravity, kilo) are flat-rate: the $ cost of a request is $0 out of
// pocket, but we still expose the EQUIVALENT API price ("inference value") so
// usage can show what the tokens would have cost.

import { getModelsDevPricing } from './providers/models-dev';

export interface ResolvedPricing {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  source: 'models.dev' | 'catalog';
}

/** Providers billed by subscription — no per-token dollar spend. */
export const SUBSCRIPTION_PROVIDERS = new Set([
  'claude',
  'codex',
  'copilot',
  'cursor',
  'grok',
  'antigravity',
  'kilocode',
  'jules',
  'freebuff',
]);

export function resolvePricing(provider: string, model: string): ResolvedPricing | null {
  // 1. Live catalog
  const live = getModelsDevPricing(provider, model);
  if (live) return { ...live, source: 'models.dev' };

  return null;
}

/** Cost in USD; null when the model has no verified price. */
export function computeCostUsd(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  cacheUsage?: { cacheReadTokens?: number; cacheWriteTokens?: number },
): { costUsd: number; source: ResolvedPricing['source'] } | null {
  const p = resolvePricing(provider, model);
  if (!p) return null;
  const cacheReadTokens = Math.max(0, cacheUsage?.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, cacheUsage?.cacheWriteTokens ?? 0);
  const freshInputTokens = Math.max(0, tokensIn - cacheReadTokens - cacheWriteTokens);
  return {
    costUsd:
      (freshInputTokens / 1_000_000) * p.inPerM +
      (cacheReadTokens / 1_000_000) * (p.cacheReadPerM ?? p.inPerM) +
      (cacheWriteTokens / 1_000_000) * (p.cacheWritePerM ?? p.inPerM) +
      (tokensOut / 1_000_000) * p.outPerM,
    source: p.source,
  };
}
