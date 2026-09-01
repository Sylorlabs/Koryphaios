import { providerLog } from '../logger';
import { withOpenRouterAttribution } from './api-endpoints';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface OpenRouterTokenRates {
  prompt: number;
  completion?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
}

export interface OpenRouterPricingOverride extends OpenRouterTokenRates {
  minPromptTokens: number;
}

export interface OpenRouterModelPricing extends OpenRouterTokenRates {
  id: string;
  canonicalSlug?: string;
  contextLength?: number;
  overrides: OpenRouterPricingOverride[];
}

export interface OpenRouterPricingCatalog {
  fetchedAt: number;
  models: Map<string, OpenRouterModelPricing>;
}

export interface OpenRouterInputQuote {
  officialModelId: string;
  freshInputUsd: number;
  cacheReadInputUsd?: number;
  cacheWriteInputUsd?: number;
  minimumInputUsd: number;
  maximumInputUsd: number;
  promptUsdPerMillion: number;
  completionUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  hasThresholdOverrides: boolean;
}

export interface OpenRouterUsageQuote extends OpenRouterInputQuote {
  outputUsd?: number;
  cacheReadAdjustedValueUsd?: number;
  freshValueUsd: number;
  minimumValueUsd: number;
  maximumValueUsd: number;
  coversOutput: boolean;
}

interface RawOpenRouterPricing extends Record<string, unknown> {
  prompt?: unknown;
  completion?: unknown;
  input_cache_read?: unknown;
  input_cache_write?: unknown;
  overrides?: unknown;
}

let cachedCatalog: OpenRouterPricingCatalog | null = null;
let inFlight: Promise<OpenRouterPricingCatalog | null> | null = null;

function nonNegativePrice(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseRates(raw: RawOpenRouterPricing): OpenRouterTokenRates | null {
  const prompt = nonNegativePrice(raw.prompt);
  if (prompt === undefined) return null;
  const completion = nonNegativePrice(raw.completion);
  const inputCacheRead = nonNegativePrice(raw.input_cache_read);
  const inputCacheWrite = nonNegativePrice(raw.input_cache_write);
  return {
    prompt,
    ...(completion !== undefined ? { completion } : {}),
    ...(inputCacheRead !== undefined ? { inputCacheRead } : {}),
    ...(inputCacheWrite !== undefined ? { inputCacheWrite } : {}),
  };
}

export function parseOpenRouterPricingCatalog(
  payload: unknown,
  fetchedAt = Date.now(),
): OpenRouterPricingCatalog {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const rows = Array.isArray(root.data) ? root.data : [];
  const models = new Map<string, OpenRouterModelPricing>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id.trim()) continue;
    const pricing =
      raw.pricing && typeof raw.pricing === 'object' ? (raw.pricing as RawOpenRouterPricing) : null;
    if (!pricing) continue;
    const base = parseRates(pricing);
    if (!base) continue;

    const overrides: OpenRouterPricingOverride[] = [];
    for (const candidate of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
      if (!candidate || typeof candidate !== 'object') continue;
      const override = candidate as RawOpenRouterPricing;
      const minPromptTokens = positiveInteger(override.min_prompt_tokens);
      const overrideRates = parseRates({ ...pricing, ...override, overrides: undefined });
      if (minPromptTokens === undefined || !overrideRates) continue;
      overrides.push({ minPromptTokens, ...overrideRates });
    }
    overrides.sort((a, b) => a.minPromptTokens - b.minPromptTokens);

    const contextLength = positiveInteger(raw.context_length);
    const canonicalSlug =
      typeof raw.canonical_slug === 'string' && raw.canonical_slug.trim()
        ? raw.canonical_slug
        : undefined;
    models.set(raw.id, {
      id: raw.id,
      ...base,
      ...(canonicalSlug ? { canonicalSlug } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
      overrides,
    });
  }

  return { fetchedAt, models };
}

/**
 * Resolve a Freebuff picker ID to an official OpenRouter row. Exact IDs win.
 * A provider-prefix mismatch is accepted only when the trailing model slug has
 * exactly one official match, so new aliases can work without an unsafe table.
 */
export function resolveOpenRouterModelPricing(
  catalog: OpenRouterPricingCatalog,
  requestedModelId: string,
  providerHint?: string,
): OpenRouterModelPricing | null {
  const exact = catalog.models.get(requestedModelId);
  if (exact) return exact;
  const slash = requestedModelId.indexOf('/');
  const namespace = openRouterNamespace(providerHint);
  if (slash >= 0 && slash < requestedModelId.length - 1) {
    const suffix = requestedModelId.slice(slash);
    const matches = [...catalog.models.values()].filter(
      (model) =>
        model.id.endsWith(suffix) &&
        (!namespace || model.id.replace(/^~/, '').split('/')[0] === namespace),
    );
    if (matches.length === 1) return matches[0]!;
  }

  const signature = modelSignature(requestedModelId);
  if (!signature) return null;
  const selectUnique = (allMatches: OpenRouterModelPricing[]): OpenRouterModelPricing | null => {
    const namespaced = namespace
      ? allMatches.filter((model) => model.id.replace(/^~/, '').split('/')[0] === namespace)
      : allMatches;
    if (namespaced.length === 1) return namespaced[0]!;
    // A stale/misleading provider hint must not hide a globally unique official
    // model identity (common with multi-vendor CLIs such as Copilot and Cline).
    return namespace && allMatches.length === 1 ? allMatches[0]! : null;
  };
  const idMatch = selectUnique(
    [...catalog.models.values()].filter((model) => modelSignature(model.id) === signature),
  );
  if (idMatch) return idMatch;
  return selectUnique(
    [...catalog.models.values()].filter(
      (model) => model.canonicalSlug && modelSignature(model.canonicalSlug) === signature,
    ),
  );
}

function openRouterNamespace(provider: string | undefined): string | null {
  if (!provider) return null;
  const normalized = provider.toLowerCase().replace(/^~/, '');
  return (
    {
      xai: 'x-ai',
      zai: 'z-ai',
      moonshot: 'moonshotai',
      kimicode: 'moonshotai',
      gemini: 'google',
      aistudio: 'google',
      vertexai: 'google',
    }[normalized] ?? normalized
  );
}

function modelSignature(modelId: string): string {
  const withoutProvider = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  const withoutDate = withoutProvider
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
  return withoutDate
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join('|');
}

function ratesForPromptTokens(
  model: OpenRouterModelPricing,
  promptTokens: number,
): OpenRouterTokenRates {
  let selected: OpenRouterTokenRates = model;
  for (const override of model.overrides) {
    if (promptTokens >= override.minPromptTokens) selected = override;
  }
  return selected;
}

/**
 * Price each upstream request separately so OpenRouter prompt-size overrides
 * are honored. Freebuff does not log cached-token counts, so this returns the
 * official all-cache-read, fresh-input, and cache-write scenarios separately.
 */
export function quoteOpenRouterInput(
  model: OpenRouterModelPricing,
  promptTokenRequests: number[],
): OpenRouterInputQuote {
  let freshInputUsd = 0;
  let cacheReadInputUsd = 0;
  let cacheWriteInputUsd = 0;
  let hasCacheReadRate = true;
  let hasCacheWriteRate = true;

  for (const rawTokens of promptTokenRequests) {
    const tokens = Number.isSafeInteger(rawTokens) && rawTokens > 0 ? rawTokens : 0;
    if (tokens === 0) continue;
    const rates = ratesForPromptTokens(model, tokens);
    freshInputUsd += tokens * rates.prompt;
    if (rates.inputCacheRead === undefined) hasCacheReadRate = false;
    else cacheReadInputUsd += tokens * rates.inputCacheRead;
    if (rates.inputCacheWrite === undefined) hasCacheWriteRate = false;
    else cacheWriteInputUsd += tokens * rates.inputCacheWrite;
  }

  const scenarios = [freshInputUsd];
  if (hasCacheReadRate) scenarios.push(cacheReadInputUsd);
  if (hasCacheWriteRate) scenarios.push(cacheWriteInputUsd);
  return {
    officialModelId: model.id,
    freshInputUsd,
    ...(hasCacheReadRate ? { cacheReadInputUsd } : {}),
    ...(hasCacheWriteRate ? { cacheWriteInputUsd } : {}),
    minimumInputUsd: Math.min(...scenarios),
    maximumInputUsd: Math.max(...scenarios),
    promptUsdPerMillion: model.prompt * 1_000_000,
    ...(model.completion !== undefined
      ? { completionUsdPerMillion: model.completion * 1_000_000 }
      : {}),
    ...(model.inputCacheRead !== undefined
      ? { cacheReadUsdPerMillion: model.inputCacheRead * 1_000_000 }
      : {}),
    ...(model.inputCacheWrite !== undefined
      ? { cacheWriteUsdPerMillion: model.inputCacheWrite * 1_000_000 }
      : {}),
    hasThresholdOverrides: model.overrides.length > 0,
  };
}

export function quoteOpenRouterUsage(
  model: OpenRouterModelPricing,
  requests: Array<{ tokensIn: number; tokensOut: number; cacheReadTokens?: number }>,
): OpenRouterUsageQuote {
  const input = quoteOpenRouterInput(
    model,
    requests.map((request) => request.tokensIn),
  );
  let outputUsd = 0;
  let coversOutput = true;
  let cacheReadAdjustedInputUsd = 0;
  let coversObservedCacheReads = true;
  for (const request of requests) {
    const tokensIn =
      Number.isSafeInteger(request.tokensIn) && request.tokensIn > 0 ? request.tokensIn : 0;
    const tokensOut =
      Number.isSafeInteger(request.tokensOut) && request.tokensOut > 0 ? request.tokensOut : 0;
    if (tokensOut === 0) continue;
    const rates = ratesForPromptTokens(model, tokensIn);
    if (request.cacheReadTokens === undefined) {
      coversObservedCacheReads = false;
    } else {
      const cacheReadTokens = Math.min(
        tokensIn,
        Number.isSafeInteger(request.cacheReadTokens) && request.cacheReadTokens > 0
          ? request.cacheReadTokens
          : 0,
      );
      const freshTokens = tokensIn - cacheReadTokens;
      cacheReadAdjustedInputUsd += freshTokens * rates.prompt;
      if (cacheReadTokens > 0 && rates.inputCacheRead === undefined) {
        coversObservedCacheReads = false;
      } else {
        cacheReadAdjustedInputUsd += cacheReadTokens * (rates.inputCacheRead ?? rates.prompt);
      }
    }
    if (rates.completion === undefined) coversOutput = false;
    else outputUsd += tokensOut * rates.completion;
  }
  const coveredOutputUsd = coversOutput ? outputUsd : 0;
  return {
    ...input,
    ...(coversOutput ? { outputUsd } : {}),
    ...(coversObservedCacheReads
      ? { cacheReadAdjustedValueUsd: cacheReadAdjustedInputUsd + coveredOutputUsd }
      : {}),
    freshValueUsd: input.freshInputUsd + coveredOutputUsd,
    minimumValueUsd: input.minimumInputUsd + coveredOutputUsd,
    maximumValueUsd: input.maximumInputUsd + coveredOutputUsd,
    coversOutput,
  };
}

export async function getOpenRouterPricingCatalog(): Promise<OpenRouterPricingCatalog | null> {
  if (cachedCatalog && Date.now() - cachedCatalog.fetchedAt < CACHE_TTL_MS) return cachedCatalog;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json', ...withOpenRouterAttribution() },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`OpenRouter /models returned ${response.status}`);
      const parsed = parseOpenRouterPricingCatalog(await response.json());
      if (parsed.models.size === 0) throw new Error('OpenRouter /models returned no priced models');
      cachedCatalog = parsed;
      return parsed;
    } catch (err: unknown) {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'OpenRouter pricing refresh failed; retaining last verified catalog',
      );
      return cachedCatalog;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function __resetOpenRouterPricingForTesting(): void {
  cachedCatalog = null;
  inFlight = null;
}
