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
import { getModelsForProvider, resolveModel } from './providers/models';

export interface ResolvedPricing {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
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
]);

/** Map CLI-harness models to the API model family for equivalent pricing. */
const CLI_MODEL_EQUIVALENTS: Array<{ match: RegExp; provider: string; model: string }> = [
  { match: /opus/i, provider: 'anthropic', model: 'claude-opus-4-6' },
  { match: /sonnet/i, provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { match: /haiku/i, provider: 'anthropic', model: 'claude-haiku-4-5' },
  { match: /gpt|codex|o[34]/i, provider: 'openai', model: 'gpt-5.2' },
  { match: /gemini.*pro/i, provider: 'google', model: 'gemini-3.1-pro' },
  { match: /gemini/i, provider: 'google', model: 'gemini-3-flash' },
  { match: /grok/i, provider: 'xai', model: 'grok-4' },
];

export function resolvePricing(provider: string, model: string): ResolvedPricing | null {
  // 1. Live catalog
  const live = getModelsDevPricing(provider, model);
  if (live) return { ...live, source: 'models.dev' };

  // 2. Static catalog
  const def =
    resolveModel(model) ??
    getModelsForProvider(provider as never).find((m) => m.apiModelId === model || m.id === model);
  if (def?.costPerMInputTokens != null && def?.costPerMOutputTokens != null) {
    const zero = def.costPerMInputTokens === 0 && def.costPerMOutputTokens === 0;
    // $0/$0 on a subscription provider means "flat rate", not "free" — fall
    // through to the API-equivalent pricing below.
    if (!(zero && SUBSCRIPTION_PROVIDERS.has(provider))) {
      return {
        inPerM: def.costPerMInputTokens,
        outPerM: def.costPerMOutputTokens,
        source: 'catalog',
      };
    }
  }

  // 3. CLI harness models: equivalent API pricing for "inference value".
  if (SUBSCRIPTION_PROVIDERS.has(provider)) {
    for (const eq of CLI_MODEL_EQUIVALENTS) {
      if (eq.match.test(model)) {
        const p = getModelsDevPricing(eq.provider, eq.model);
        if (p) return { ...p, source: 'models.dev' };
      }
    }
  }
  return null;
}

/** Cost in USD; null when the model has no verified price. */
export function computeCostUsd(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): { costUsd: number; source: ResolvedPricing['source'] } | null {
  const p = resolvePricing(provider, model);
  if (!p) return null;
  return {
    costUsd: (tokensIn / 1_000_000) * p.inPerM + (tokensOut / 1_000_000) * p.outPerM,
    source: p.source,
  };
}
