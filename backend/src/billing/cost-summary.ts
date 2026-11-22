import {
  costFromPricing,
  resolvePricing,
  SUBSCRIPTION_PROVIDERS,
  type ResolvedPricing,
} from '../pricing';
import type { CreditUsageEventRow, UsageCostBreakdownRow } from '../credit-accountant/db';

type PricingResolver = (provider: string, model: string) => ResolvedPricing | null;

/**
 * A pricing catalog miss scans the whole models.dev/OpenRouter catalogs, so
 * resolving the same (provider, model) once per call instead of once per
 * event turns a per-row catalog scan into a per-pair lookup. Misses are
 * cached too — an unpriced pair stays unpriced within a summary.
 */
export function createMemoizedPricing(resolve: PricingResolver = resolvePricing): PricingResolver {
  const cache = new Map<string, ResolvedPricing | null>();
  return (provider, model) => {
    const key = `${provider}::${model}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const resolved = resolve(provider, model);
    cache.set(key, resolved);
    return resolved;
  };
}

export interface BillingModelCostSummary {
  model: string;
  spendUsd: number | null;
  spendCents: number | null;
  tokensIn: number;
  tokensOut: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
  apiEquivalentUsd?: number | null;
  apiEquivalentPricingIncomplete?: boolean;
  apiProvider?: string;
}

export interface BillingProviderCostSummary {
  name: string;
  spendUsd: number | null;
  spendCents: number | null;
  tokensIn: number;
  tokensOut: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
  apiEquivalentUsd?: number | null;
  apiEquivalentPricingIncomplete?: boolean;
  models: BillingModelCostSummary[];
}

export interface BillingSpendSummary {
  totalSpendUsd: number;
  totalSpendCents: number;
  hasKnownSpend: boolean;
  pricingIncomplete: boolean;
  byProvider: BillingProviderCostSummary[];
  byModel: Array<{
    model: string;
    spendUsd: number;
    spendCents: number;
    tokensIn: number;
    tokensOut: number;
    hasKnownCost: boolean;
    pricingIncomplete: boolean;
  }>;
}

export interface SessionCostSummary {
  spendUsd: number;
  spendCents: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  hasMeteredUsage: boolean;
  hasSubscriptionUsage: boolean;
  providers: BillingProviderCostSummary[];
}

export type UsageWindowKey = '24h' | '7d' | '30d' | '90d';

export interface UsageAnalyticsSeriesBucket {
  ts: number;
  endTs: number;
  costUsd: number;
  apiEquivalentUsd: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export interface UsageAnalyticsProviderRow {
  name: string;
  sessionCount: number;
  spendUsd: number;
  apiEquivalentUsd: number | null;
  sharePercent: number;
  tokenSharePercent: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
}

export interface UsageAnalyticsModelRow {
  model: string;
  provider: string;
  spendUsd: number | null;
  apiEquivalentUsd: number | null;
  sharePercent: number;
  tokenSharePercent: number;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  hasKnownCost: boolean;
  pricingIncomplete: boolean;
  subscription: boolean;
}

export interface UsageWindowAnalytics {
  window: UsageWindowKey;
  granularity: 'hour' | 'day';
  startTs: number;
  endTs: number;
  totalSpendUsd: number;
  totalApiEquivalentUsd: number;
  hasKnownSpend: boolean;
  pricingIncomplete: boolean;
  sessionCount: number;
  totals: {
    processedTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheSavingsUsd: number;
  };
  costByType: {
    inputUsd: number;
    cacheReadUsd: number;
    outputUsd: number;
  };
  byProvider: UsageAnalyticsProviderRow[];
  byModel: UsageAnalyticsModelRow[];
  series: UsageAnalyticsSeriesBucket[];
}

export interface UsageAnalyticsSummary {
  generatedAt: number;
  windows: Record<UsageWindowKey, UsageWindowAnalytics>;
}

function cents(usd: number): number {
  return Math.round(usd * 100);
}

function inferApiProvider(subscriptionProvider: string, model: string): string | null {
  const id = model.trim().toLowerCase();
  if (id.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o\d|codex)/.test(id)) return 'openai';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('grok')) return 'xai';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('kimi') || id.startsWith('moonshot')) return 'moonshot';
  if (subscriptionProvider === 'claude') return 'anthropic';
  if (subscriptionProvider === 'codex') return 'openai';
  if (subscriptionProvider === 'grok') return 'xai';
  return null;
}

function sortedModels<T extends BillingModelCostSummary>(
  models: Map<string, T>,
): BillingModelCostSummary[] {
  return [...models.values()].sort((a, b) => {
    const aSpend = a.spendUsd ?? a.apiEquivalentUsd ?? -1;
    const bSpend = b.spendUsd ?? b.apiEquivalentUsd ?? -1;
    if (aSpend !== bSpend) return bSpend - aSpend;
    return a.model.localeCompare(b.model);
  });
}

function providerSummaries(
  rows: UsageCostBreakdownRow[],
  pricing: PricingResolver = createMemoizedPricing(),
): BillingProviderCostSummary[] {
  type ModelWorking = BillingModelCostSummary & {
    knownSpendUsd: number;
    knownEquivalentUsd: number;
  };
  type ProviderWorking = BillingProviderCostSummary & {
    knownSpendUsd: number;
    knownEquivalentUsd: number;
    modelMap: Map<string, ModelWorking>;
  };
  const providers = new Map<string, ProviderWorking>();

  for (const row of rows) {
    if (row.provider === 'gemini') continue;
    const subscription = SUBSCRIPTION_PROVIDERS.has(row.provider);
    let provider = providers.get(row.provider);
    if (!provider) {
      provider = {
        name: row.provider,
        spendUsd: subscription ? null : 0,
        spendCents: subscription ? null : 0,
        tokensIn: 0,
        tokensOut: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
        subscription,
        apiEquivalentUsd: subscription ? 0 : undefined,
        apiEquivalentPricingIncomplete: subscription ? false : undefined,
        models: [],
        knownSpendUsd: 0,
        knownEquivalentUsd: 0,
        modelMap: new Map(),
      };
      providers.set(row.provider, provider);
    }

    provider.tokensIn += row.tokensIn;
    provider.tokensOut += row.tokensOut;
    if (!subscription) {
      provider.knownSpendUsd += row.knownCostUsd;
      provider.hasKnownCost ||= row.knownRows > 0;
      provider.pricingIncomplete ||= row.unknownRows > 0;
    }

    let model = provider.modelMap.get(row.model);
    if (!model) {
      model = {
        model: row.model,
        spendUsd: subscription ? null : 0,
        spendCents: subscription ? null : 0,
        tokensIn: 0,
        tokensOut: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
        subscription,
        apiEquivalentUsd: subscription ? 0 : undefined,
        apiEquivalentPricingIncomplete: subscription ? false : undefined,
        knownSpendUsd: 0,
        knownEquivalentUsd: 0,
      };
      provider.modelMap.set(row.model, model);
    }
    model.tokensIn += row.tokensIn;
    model.tokensOut += row.tokensOut;

    if (!subscription) {
      model.knownSpendUsd += row.knownCostUsd;
      model.hasKnownCost ||= row.knownRows > 0;
      model.pricingIncomplete ||= row.unknownRows > 0;
      continue;
    }

    const apiProvider = inferApiProvider(row.provider, row.model);
    const resolvedPricing = apiProvider ? pricing(apiProvider, row.model) : null;
    const equivalent = resolvedPricing
      ? costFromPricing(resolvedPricing, row.tokensIn, row.tokensOut, {
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
        })
      : null;
    if (equivalent) {
      model.apiProvider = apiProvider ?? undefined;
      model.knownEquivalentUsd += equivalent.costUsd;
      provider.knownEquivalentUsd += equivalent.costUsd;
    } else {
      model.apiEquivalentPricingIncomplete = true;
      provider.apiEquivalentPricingIncomplete = true;
    }
  }

  return [...providers.values()]
    .map((provider) => {
      for (const model of provider.modelMap.values()) {
        if (model.subscription) {
          model.apiEquivalentUsd = model.knownEquivalentUsd;
        } else {
          model.spendUsd = model.knownSpendUsd;
          model.spendCents = cents(model.knownSpendUsd);
        }
      }
      if (provider.subscription) {
        provider.apiEquivalentUsd = provider.knownEquivalentUsd;
      } else {
        provider.spendUsd = provider.knownSpendUsd;
        provider.spendCents = cents(provider.knownSpendUsd);
      }
      provider.models = sortedModels(provider.modelMap);
      const {
        knownSpendUsd: _knownSpendUsd,
        knownEquivalentUsd: _knownEquivalentUsd,
        modelMap: _modelMap,
        ...publicProvider
      } = provider;
      publicProvider.models = publicProvider.models.map((model) => {
        const {
          knownSpendUsd: _modelKnownSpendUsd,
          knownEquivalentUsd: _modelKnownEquivalentUsd,
          ...publicModel
        } = model as ModelWorking;
        return publicModel;
      });
      return publicProvider;
    })
    .sort((a, b) => {
      if (a.subscription !== b.subscription) return a.subscription ? 1 : -1;
      const aSpend = a.spendUsd ?? a.apiEquivalentUsd ?? -1;
      const bSpend = b.spendUsd ?? b.apiEquivalentUsd ?? -1;
      if (aSpend !== bSpend) return bSpend - aSpend;
      return a.name.localeCompare(b.name);
    });
}

export function summarizeBillingSpend(
  rows: UsageCostBreakdownRow[],
  pricing: PricingResolver = createMemoizedPricing(),
): BillingSpendSummary {
  const providers = providerSummaries(rows, pricing).filter(
    (provider) => !provider.subscription,
  );
  const modelMap = new Map<
    string,
    {
      model: string;
      spendUsd: number;
      tokensIn: number;
      tokensOut: number;
      hasKnownCost: boolean;
      pricingIncomplete: boolean;
    }
  >();

  for (const provider of providers) {
    for (const model of provider.models) {
      const current = modelMap.get(model.model) ?? {
        model: model.model,
        spendUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
      };
      current.spendUsd += model.spendUsd ?? 0;
      current.tokensIn += model.tokensIn;
      current.tokensOut += model.tokensOut;
      current.hasKnownCost ||= model.hasKnownCost;
      current.pricingIncomplete ||= model.pricingIncomplete;
      modelMap.set(model.model, current);
    }
  }

  const totalSpendUsd = providers.reduce((sum, provider) => sum + (provider.spendUsd ?? 0), 0);
  const hasKnownSpend = providers.some((provider) => provider.hasKnownCost);
  return {
    totalSpendUsd,
    totalSpendCents: cents(totalSpendUsd),
    hasKnownSpend,
    pricingIncomplete: providers.some((provider) => provider.pricingIncomplete),
    byProvider: providers,
    byModel: [...modelMap.values()]
      .map((model) => ({
        model: model.model,
        spendUsd: model.spendUsd,
        spendCents: cents(model.spendUsd),
        tokensIn: model.tokensIn,
        tokensOut: model.tokensOut,
        hasKnownCost: model.hasKnownCost,
        pricingIncomplete: model.pricingIncomplete,
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd || a.model.localeCompare(b.model)),
  };
}

export function summarizeSessionCosts(
  rows: UsageCostBreakdownRow[],
): Record<string, SessionCostSummary> {
  const bySession = new Map<string, UsageCostBreakdownRow[]>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  const result: Record<string, SessionCostSummary> = {};
  const pricing = createMemoizedPricing();
  for (const [sessionId, sessionRows] of bySession) {
    const providers = providerSummaries(sessionRows, pricing);
    const metered = providers.filter((provider) => !provider.subscription);
    const spendUsd = metered.reduce((sum, provider) => sum + (provider.spendUsd ?? 0), 0);
    result[sessionId] = {
      spendUsd,
      spendCents: cents(spendUsd),
      hasKnownCost: metered.some((provider) => provider.hasKnownCost),
      pricingIncomplete: metered.some((provider) => provider.pricingIncomplete),
      hasMeteredUsage: metered.length > 0,
      hasSubscriptionUsage: providers.some((provider) => provider.subscription),
      providers,
    };
  }
  return result;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const WINDOW_CONFIGS: Array<{
  key: UsageWindowKey;
  granularity: 'hour' | 'day';
  bucketCount: number;
  bucketMs: number;
}> = [
  { key: '24h', granularity: 'hour', bucketCount: 24, bucketMs: HOUR_MS },
  { key: '7d', granularity: 'day', bucketCount: 7, bucketMs: DAY_MS },
  { key: '30d', granularity: 'day', bucketCount: 30, bucketMs: DAY_MS },
  { key: '90d', granularity: 'day', bucketCount: 90, bucketMs: DAY_MS },
];

function apportionEventCostByType(
  event: CreditUsageEventRow,
  resolvePrice: PricingResolver,
): {
  inputUsd: number;
  cacheReadUsd: number;
  outputUsd: number;
} {
  const totalCost = event.costKnown && !SUBSCRIPTION_PROVIDERS.has(event.provider) ? event.costUsd : 0;
  if (totalCost <= 0) return { inputUsd: 0, cacheReadUsd: 0, outputUsd: 0 };

  const pricing = resolvePrice(event.provider, event.model);
  const cacheReadTokens = Math.max(0, event.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, event.cacheWriteTokens ?? 0);
  const freshInputTokens = Math.max(0, event.tokensIn - cacheReadTokens - cacheWriteTokens);
  const outputTokens = Math.max(0, event.tokensOut);

  if (pricing) {
    const rawInput =
      (freshInputTokens / 1_000_000) * pricing.inPerM +
      (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerM ?? pricing.inPerM);
    const rawCacheRead =
      (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerM ?? pricing.inPerM);
    const rawOutput = (outputTokens / 1_000_000) * pricing.outPerM;
    const rawSum = rawInput + rawCacheRead + rawOutput;
    if (rawSum > 0) {
      const scale = totalCost / rawSum;
      return {
        inputUsd: rawInput * scale,
        cacheReadUsd: rawCacheRead * scale,
        outputUsd: rawOutput * scale,
      };
    }
  }

  // Fallback when pricing catalog isn't loaded for an already-priced row:
  // weight output 3x fresh input and cacheRead 0.1x fresh input so the split
  // reflects realistic LLM token economics and still sums to totalCost.
  const weightedInput = freshInputTokens + cacheWriteTokens;
  const weightedCache = cacheReadTokens * 0.1;
  const weightedOutput = outputTokens * 3;
  const weightSum = weightedInput + weightedCache + weightedOutput;
  if (weightSum <= 0) return { inputUsd: totalCost, cacheReadUsd: 0, outputUsd: 0 };
  return {
    inputUsd: totalCost * (weightedInput / weightSum),
    cacheReadUsd: totalCost * (weightedCache / weightSum),
    outputUsd: totalCost * (weightedOutput / weightSum),
  };
}

function buildWindowAnalytics(
  config: (typeof WINDOW_CONFIGS)[number],
  events: CreditUsageEventRow[],
  now: number,
  pricing: PricingResolver,
): UsageWindowAnalytics {
  const alignedEnd =
    config.granularity === 'hour'
      ? Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS
      : Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const startTs = alignedEnd - config.bucketCount * config.bucketMs;

  const buckets: Array<
    UsageAnalyticsSeriesBucket & {
      sessions: Set<string>;
    }
  > = Array.from({ length: config.bucketCount }, (_, index) => {
    const ts = startTs + index * config.bucketMs;
    return {
      ts,
      endTs: ts + config.bucketMs,
      costUsd: 0,
      apiEquivalentUsd: 0,
      tokens: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      sessionCount: 0,
      sessions: new Set<string>(),
    };
  });

  const windowSessions = new Set<string>();
  let totalSpendUsd = 0;
  let totalApiEquivalentUsd = 0;
  let hasKnownSpend = false;
  let pricingIncomplete = false;
  let processedTokens = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let cacheSavingsUsd = 0;
  let inputUsd = 0;
  let cacheReadUsd = 0;
  let outputUsd = 0;

  const providerMap = new Map<
    string,
    {
      name: string;
      sessions: Set<string>;
      spendUsd: number;
      apiEquivalentUsd: number;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      hasKnownCost: boolean;
      pricingIncomplete: boolean;
      subscription: boolean;
    }
  >();

  const modelMap = new Map<
    string,
    {
      model: string;
      provider: string;
      spendUsd: number;
      apiEquivalentUsd: number;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      hasKnownCost: boolean;
      pricingIncomplete: boolean;
      subscription: boolean;
    }
  >();

  for (const event of events) {
    if (event.provider === 'gemini') continue;
    if (event.ts < startTs || event.ts > now + config.bucketMs) continue;

    const subscription = SUBSCRIPTION_PROVIDERS.has(event.provider);
    const meteredCost = !subscription && event.costKnown ? Math.max(0, event.costUsd) : 0;
    const sessionKey = event.sessionId?.trim() || `turn-${event.ts}`;
    windowSessions.add(sessionKey);

    let equivalentCost = 0;
    if (subscription) {
      const apiProvider = inferApiProvider(event.provider, event.model);
      const resolvedPricing = apiProvider ? pricing(apiProvider, event.model) : null;
      const eq = resolvedPricing
        ? costFromPricing(resolvedPricing, event.tokensIn, event.tokensOut, {
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
          })
        : null;
      if (eq) equivalentCost = eq.costUsd;
    }

    totalSpendUsd += meteredCost;
    totalApiEquivalentUsd += equivalentCost;
    if (!subscription) {
      if (event.costKnown) hasKnownSpend = true;
      else pricingIncomplete = true;
    }

    const evTokensIn = Math.max(0, event.tokensIn);
    const evTokensOut = Math.max(0, event.tokensOut);
    const evCacheRead = Math.max(0, event.cacheReadTokens);
    const evCacheWrite = Math.max(0, event.cacheWriteTokens);
    const evUncachedIn = Math.max(0, evTokensIn - evCacheRead);

    processedTokens += evTokensIn + evTokensOut;
    cachedInputTokens += evCacheRead;
    uncachedInputTokens += evUncachedIn;
    cacheWriteTokens += evCacheWrite;
    outputTokens += evTokensOut;
    cacheSavingsUsd += Math.max(0, event.cacheSavingsUsd ?? 0);

    const split = apportionEventCostByType(event, pricing);
    inputUsd += split.inputUsd;
    cacheReadUsd += split.cacheReadUsd;
    outputUsd += split.outputUsd;

    const bucketIndex = Math.min(
      config.bucketCount - 1,
      Math.max(0, Math.floor((event.ts - startTs) / config.bucketMs)),
    );
    const bucket = buckets[bucketIndex];
    if (bucket) {
      bucket.costUsd += meteredCost;
      bucket.apiEquivalentUsd += equivalentCost;
      bucket.tokens += evTokensIn + evTokensOut;
      bucket.tokensIn += evTokensIn;
      bucket.tokensOut += evTokensOut;
      bucket.cacheReadTokens += evCacheRead;
      bucket.sessions.add(sessionKey);
    }

    let prov = providerMap.get(event.provider);
    if (!prov) {
      prov = {
        name: event.provider,
        sessions: new Set<string>(),
        spendUsd: 0,
        apiEquivalentUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
        subscription,
      };
      providerMap.set(event.provider, prov);
    }
    prov.sessions.add(sessionKey);
    prov.spendUsd += meteredCost;
    prov.apiEquivalentUsd += equivalentCost;
    prov.tokensIn += evTokensIn;
    prov.tokensOut += evTokensOut;
    prov.cacheReadTokens += evCacheRead;
    if (!subscription) {
      if (event.costKnown) prov.hasKnownCost = true;
      else prov.pricingIncomplete = true;
    }

    const modelKey = `${event.provider}::${event.model}`;
    let mod = modelMap.get(modelKey);
    if (!mod) {
      mod = {
        model: event.model,
        provider: event.provider,
        spendUsd: 0,
        apiEquivalentUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        hasKnownCost: false,
        pricingIncomplete: false,
        subscription,
      };
      modelMap.set(modelKey, mod);
    }
    mod.spendUsd += meteredCost;
    mod.apiEquivalentUsd += equivalentCost;
    mod.tokensIn += evTokensIn;
    mod.tokensOut += evTokensOut;
    mod.cacheReadTokens += evCacheRead;
    if (!subscription) {
      if (event.costKnown) mod.hasKnownCost = true;
      else mod.pricingIncomplete = true;
    }
  }

  const byProvider: UsageAnalyticsProviderRow[] = [...providerMap.values()]
    .map((p) => {
      const tokens = p.tokensIn + p.tokensOut;
      return {
        name: p.name,
        sessionCount: p.sessions.size,
        spendUsd: p.spendUsd,
        apiEquivalentUsd: p.subscription ? p.apiEquivalentUsd : null,
        sharePercent: totalSpendUsd > 0 ? (p.spendUsd / totalSpendUsd) * 100 : 0,
        tokenSharePercent: processedTokens > 0 ? (tokens / processedTokens) * 100 : 0,
        tokens,
        tokensIn: p.tokensIn,
        tokensOut: p.tokensOut,
        cacheReadTokens: p.cacheReadTokens,
        hasKnownCost: p.subscription ? true : p.hasKnownCost,
        pricingIncomplete: p.pricingIncomplete,
        subscription: p.subscription,
      };
    })
    .sort((a, b) => b.spendUsd - a.spendUsd || b.tokens - a.tokens || a.name.localeCompare(b.name));

  const byModel: UsageAnalyticsModelRow[] = [...modelMap.values()]
    .map((m) => {
      const tokens = m.tokensIn + m.tokensOut;
      const priced = !m.subscription && m.hasKnownCost;
      return {
        model: m.model,
        provider: m.provider,
        spendUsd: priced ? m.spendUsd : null,
        apiEquivalentUsd: m.subscription && m.apiEquivalentUsd > 0 ? m.apiEquivalentUsd : null,
        sharePercent: priced && totalSpendUsd > 0 ? (m.spendUsd / totalSpendUsd) * 100 : 0,
        tokenSharePercent: processedTokens > 0 ? (tokens / processedTokens) * 100 : 0,
        tokens,
        tokensIn: m.tokensIn,
        tokensOut: m.tokensOut,
        cacheReadTokens: m.cacheReadTokens,
        hasKnownCost: priced,
        pricingIncomplete: m.pricingIncomplete,
        subscription: m.subscription,
      };
    })
    .sort(
      (a, b) =>
        (b.spendUsd ?? -1) - (a.spendUsd ?? -1) ||
        b.tokens - a.tokens ||
        a.model.localeCompare(b.model),
    );

  return {
    window: config.key,
    granularity: config.granularity,
    startTs,
    endTs: now,
    totalSpendUsd,
    totalApiEquivalentUsd,
    hasKnownSpend,
    pricingIncomplete,
    sessionCount: windowSessions.size,
    totals: {
      processedTokens,
      cachedInputTokens,
      uncachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      cacheSavingsUsd,
    },
    costByType: {
      inputUsd,
      cacheReadUsd,
      outputUsd,
    },
    byProvider,
    byModel,
    series: buckets.map(({ sessions, ...bucket }) => ({
      ...bucket,
      sessionCount: sessions.size,
    })),
  };
}

export function summarizeUsageAnalytics(
  events: CreditUsageEventRow[],
  now = Date.now(),
  pricing: PricingResolver = createMemoizedPricing(),
): UsageAnalyticsSummary {
  const windows = Object.fromEntries(
    WINDOW_CONFIGS.map((config) => [
      config.key,
      buildWindowAnalytics(config, events, now, pricing),
    ]),
  ) as Record<UsageWindowKey, UsageWindowAnalytics>;

  return {
    generatedAt: now,
    windows,
  };
}
