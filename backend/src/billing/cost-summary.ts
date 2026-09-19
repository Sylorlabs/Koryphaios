import { computeCostUsd, SUBSCRIPTION_PROVIDERS } from '../pricing';
import type { UsageCostBreakdownRow } from '../credit-accountant/db';

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
  if (subscriptionProvider === 'jules') return 'google';
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

function providerSummaries(rows: UsageCostBreakdownRow[]): BillingProviderCostSummary[] {
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
    const equivalent = apiProvider
      ? computeCostUsd(apiProvider, row.model, row.tokensIn, row.tokensOut, {
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

export function summarizeBillingSpend(rows: UsageCostBreakdownRow[]): BillingSpendSummary {
  const providers = providerSummaries(rows).filter((provider) => !provider.subscription);
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

export function summarizeSessionCosts(rows: UsageCostBreakdownRow[]): Record<string, SessionCostSummary> {
  const bySession = new Map<string, UsageCostBreakdownRow[]>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  const result: Record<string, SessionCostSummary> = {};
  for (const [sessionId, sessionRows] of bySession) {
    const providers = providerSummaries(sessionRows);
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
