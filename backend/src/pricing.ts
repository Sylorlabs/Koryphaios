// Resolve provider rates first. Only verified OpenRouter rates may value an equivalent.
import { getModelsDevPricing } from './providers/models-dev';
import { getCachedOpenRouterModelPricing } from './providers/openrouter-pricing';

export interface ResolvedPricing {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  source: 'models.dev' | 'provider-rate' | 'openrouter-equivalent';
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
  'freebuff',
]);

const providerRates = new Map<string, ResolvedPricing>();

/** Store only rates explicitly published by this provider's model endpoint. */
export function recordProviderModelPricing(provider: string, model: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const entry = raw as Record<string, unknown>;
  const pricing = entry.pricing as Record<string, unknown> | undefined;
  if (!pricing || typeof pricing !== 'object') return;
  const rate = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    if (typeof value === 'string' && !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
  };
  const input = rate(pricing.prompt);
  const output = rate(pricing.completion);
  if (input === undefined || output === undefined) return;
  providerRates.set(`${provider}::${model}`, {
    inPerM: input,
    outPerM: output,
    cacheReadPerM: rate(pricing.input_cache_read),
    cacheWritePerM: rate(pricing.input_cache_write),
    source: 'provider-rate',
  });
}

/** Resolve the serving provider's price, then an explicitly attributed equivalent. */
export function resolvePricing(provider: string, model: string): ResolvedPricing | null {
  const remote = providerRates.get(`${provider}::${model}`);
  if (remote) return remote;
  const live = getModelsDevPricing(provider, model);
  if (live) return { ...live, source: 'models.dev' };
  const official = getCachedOpenRouterModelPricing(model);
  if (official && official.completion !== undefined) {
    return {
      inPerM: official.prompt * 1_000_000,
      outPerM: official.completion * 1_000_000,
      cacheReadPerM:
        official.inputCacheRead === undefined ? undefined : official.inputCacheRead * 1_000_000,
      cacheWritePerM:
        official.inputCacheWrite === undefined ? undefined : official.inputCacheWrite * 1_000_000,
      source: provider === 'openrouter' ? 'provider-rate' : 'openrouter-equivalent',
    };
  }
  const equivalent = getModelsDevPricing('openrouter', model);
  return equivalent ? { ...equivalent, source: 'openrouter-equivalent' } : null;
}

/** Cost in USD from an already-resolved price. */
export function costFromPricing(
  p: ResolvedPricing,
  tokensIn: number,
  tokensOut: number,
  cacheUsage?: { cacheReadTokens?: number; cacheWriteTokens?: number },
): { costUsd: number; source: ResolvedPricing['source'] } {
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
  return costFromPricing(p, tokensIn, tokensOut, cacheUsage);
}
