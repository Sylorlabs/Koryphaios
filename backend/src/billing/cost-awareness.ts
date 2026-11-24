// Cost awareness for agents: what a model costs, and what this chat, project
// or the ledger has spent, plus the capacity states the backend already knows.
//
// Every number here comes from an existing service (provider catalogs, the
// pricing resolver, the credit ledger, enforced spend caps, the resource
// budget snapshot). Missing data stays null and is named in `limitations`;
// a price or balance is never invented, and unknown is never reported as zero.

import type { ModelDef } from '@koryphaios/shared';
import { resolvePricing, SUBSCRIPTION_PROVIDERS, type ResolvedPricing } from '../pricing';
import type { UsageCostBreakdownRow } from '../credit-accountant/db';
import { summarizeBillingSpend } from './cost-summary';
import type { ResourceBudgetEntry, ResourceBudgetSnapshot } from './resource-budget';

export type PriceSource =
  'catalog' | 'models.dev' | 'provider-reported' | 'openrouter-equivalent' | 'unknown';

export const PRICE_UNIT = 'USD per 1M tokens';
const MAX_LISTED_MODELS = 100;
const MAX_BY_MODEL_ROWS = 25;
const MIN_CONTEXT_WINDOW = 1024;

// ─── get_model_pricing ──────────────────────────────────────────────────────

export interface PricingProviderInput {
  name: string;
  models: ModelDef[];
}

export interface ModelPriceFacts {
  provider: string;
  model: string;
  /** False when no connected provider catalog lists this model. */
  inCatalog: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number | null;
  cacheWritePerMTok: number | null;
  priceSource: PriceSource;
  contextWindow: number | null;
  contextSource: 'provider-reported' | 'unknown';
  /** Billed through a subscription; per-token prices are reference values only. */
  subscription: boolean;
  /** Provider account rate relative to its base model, when the provider reports one. */
  accountRate?: { unit: string; cost: number };
  error?: string;
  note?: string;
}

export interface ModelPricingReport {
  generatedAt: number;
  unit: typeof PRICE_UNIT;
  models: ModelPriceFacts[];
  truncated: boolean;
  limitations: string[];
}

export interface PricingDependencies {
  resolvePricing?: (provider: string, model: string) => ResolvedPricing | null;
  now?: () => number;
}

export interface ModelPricingRequest {
  models?: string[];
  provider?: string;
}

const PRICE_SOURCE_FROM_RESOLVED: Record<ResolvedPricing['source'], PriceSource> = {
  'provider-rate': 'provider-reported',
  'models.dev': 'models.dev',
  'openrouter-equivalent': 'openrouter-equivalent',
};

type PriceFigures = Pick<
  ModelPriceFacts,
  'inputPerMTok' | 'outputPerMTok' | 'cacheReadPerMTok' | 'cacheWritePerMTok'
>;

/** A catalog price counts only when the provider reported both sides and the model is not a placeholder. */
function catalogPrice(def: ModelDef): PriceFigures | null {
  if (def.isGeneric) return null;
  if (typeof def.costPerMInputTokens !== 'number' || typeof def.costPerMOutputTokens !== 'number') {
    return null;
  }
  return {
    inputPerMTok: def.costPerMInputTokens,
    outputPerMTok: def.costPerMOutputTokens,
    cacheReadPerMTok: typeof def.costPerMInputCached === 'number' ? def.costPerMInputCached : null,
    cacheWritePerMTok: null,
  };
}

function contextFacts(
  def: ModelDef | undefined,
): Pick<ModelPriceFacts, 'contextWindow' | 'contextSource'> {
  if (
    def &&
    def.contextVerified === true &&
    Number.isFinite(def.contextWindow) &&
    def.contextWindow >= MIN_CONTEXT_WINDOW
  ) {
    return { contextWindow: def.contextWindow, contextSource: 'provider-reported' };
  }
  return { contextWindow: null, contextSource: 'unknown' };
}

/** Price facts for one provider/model pair. Pure except for the injected resolver. */
export function describeModelPrice(
  provider: string,
  model: string,
  def: ModelDef | undefined,
  deps: PricingDependencies = {},
): ModelPriceFacts {
  const resolve = deps.resolvePricing ?? resolvePricing;
  const subscription = SUBSCRIPTION_PROVIDERS.has(provider);
  const base = {
    provider,
    model,
    inCatalog: def !== undefined,
    subscription,
    ...contextFacts(def),
  };
  // Freebuff's account catalog reports a per-model cost in Freebucks, relative to its base model.
  const accountCost = (def as (ModelDef & { freebuckCost?: unknown }) | undefined)?.freebuckCost;
  const accountRate =
    provider === 'freebuff' && typeof accountCost === 'number' && Number.isFinite(accountCost)
      ? { accountRate: { unit: 'freebuck', cost: accountCost } }
      : {};

  const fromCatalog = def ? catalogPrice(def) : null;
  if (fromCatalog) {
    return { ...base, ...fromCatalog, priceSource: 'catalog', ...accountRate };
  }

  const resolved = resolve(provider, def?.apiModelId ?? model);
  if (resolved) {
    return {
      ...base,
      inputPerMTok: resolved.inPerM,
      outputPerMTok: resolved.outPerM,
      cacheReadPerMTok: resolved.cacheReadPerM ?? null,
      cacheWritePerMTok: resolved.cacheWritePerM ?? null,
      priceSource: PRICE_SOURCE_FROM_RESOLVED[resolved.source],
      ...accountRate,
    };
  }

  return {
    ...base,
    inputPerMTok: null,
    outputPerMTok: null,
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
    priceSource: 'unknown',
    note: def
      ? 'Listed by the provider without a reported price, and no models.dev or provider-rate price matches. Price is unknown, not zero.'
      : 'Not listed by any connected provider and no price source matches. Price is unknown, not zero.',
    ...accountRate,
  };
}

/** Split "provider:model" against the providers actually known, so "custom:x:model" parses. */
export function parseProviderModel(
  raw: string,
  knownProviders: readonly string[],
  defaultProvider?: string,
): { provider: string; model: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Empty model reference.' };
  const sorted = [...knownProviders].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (text.startsWith(`${name}:`) && text.length > name.length + 1) {
      return { provider: name, model: text.slice(name.length + 1) };
    }
  }
  const colon = text.indexOf(':');
  if (colon > 0 && colon < text.length - 1) {
    return { provider: text.slice(0, colon), model: text.slice(colon + 1) };
  }
  if (defaultProvider) return { provider: defaultProvider, model: text };
  return { error: `Use provider:model (for example openrouter:openai/gpt-4.1); got "${text}".` };
}

export function buildModelPricingReport(
  request: ModelPricingRequest,
  providers: readonly PricingProviderInput[],
  deps: PricingDependencies = {},
): ModelPricingReport {
  const generatedAt = (deps.now ?? Date.now)();
  const limitations: string[] = [
    'Prices are per 1M tokens as reported by a connected provider catalog or the models.dev / provider-rate registries. Unknown prices are null, never zero.',
    'Subscription providers bill through their plan; their per-token figures are reference values, not charges.',
  ];
  const known = providers.map((p) => p.name);
  const defs = new Map<string, Map<string, ModelDef>>();
  for (const provider of providers) {
    const byId = new Map<string, ModelDef>();
    for (const def of provider.models) {
      byId.set(def.apiModelId ?? def.id, def);
      byId.set(def.id, def);
    }
    defs.set(provider.name, byId);
  }
  const filterProvider = request.provider?.trim() || undefined;
  const out: ModelPriceFacts[] = [];
  let truncated = false;

  if (request.models && request.models.length > 0) {
    for (const raw of request.models) {
      const parsed = parseProviderModel(raw, known, filterProvider);
      if ('error' in parsed) {
        out.push({
          provider: '',
          model: raw,
          inCatalog: false,
          inputPerMTok: null,
          outputPerMTok: null,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
          priceSource: 'unknown',
          contextWindow: null,
          contextSource: 'unknown',
          subscription: false,
          error: parsed.error,
        });
        continue;
      }
      const def = defs.get(parsed.provider)?.get(parsed.model);
      out.push(describeModelPrice(parsed.provider, parsed.model, def, deps));
    }
  } else {
    const scoped = filterProvider ? providers.filter((p) => p.name === filterProvider) : providers;
    if (filterProvider && scoped.length === 0) {
      limitations.push(`Provider "${filterProvider}" is not connected or has no status entry.`);
    }
    const flat = scoped.flatMap((provider) =>
      provider.models.map((def) => ({ provider: provider.name, def })),
    );
    truncated = flat.length > MAX_LISTED_MODELS;
    for (const { provider, def } of flat.slice(0, MAX_LISTED_MODELS)) {
      out.push(describeModelPrice(provider, def.apiModelId ?? def.id, def, deps));
    }
  }

  return { generatedAt, unit: PRICE_UNIT, models: out, truncated, limitations };
}

// ─── get_usage_summary ──────────────────────────────────────────────────────

export type UsageScope = 'session' | 'project' | 'today' | 'month';
export const USAGE_SCOPES: readonly UsageScope[] = ['session', 'project', 'today', 'month'];

export interface SpendCapStatus {
  /** Whether enforcement is switched on at all. */
  enabled: boolean;
  action: string;
  /** null = no limit configured for that window. USD. */
  limitsUsd: {
    sessionHourly: number | null;
    sessionDaily: number | null;
    globalHourly: number | null;
    globalDaily: number | null;
  };
  spentUsd: {
    sessionHour: number | null;
    sessionDay: number | null;
    globalHour: number | null;
    globalDay: number | null;
  };
  sessionId?: string;
  paused: boolean;
  pauseReason?: string;
}

export interface UsageSummaryDependencies {
  /** Ledger rows since `sinceMs` (0 = all time), or null when the ledger is unavailable. */
  rows: (sinceMs: number) => UsageCostBreakdownRow[] | null;
  budget: () => Promise<ResourceBudgetSnapshot | null>;
  spendCap: (sessionId: string | undefined) => Promise<SpendCapStatus | null>;
  now?: () => number;
}

export interface UsageSummaryRequest {
  scope: UsageScope;
  /** Chat the summary is about for `session` scope, and whose cap is reported. */
  sessionId: string;
  /** Chats in the caller's project folder, for `project` scope. */
  projectSessionIds: readonly string[];
}

export interface UsageSummaryReport {
  generatedAt: number;
  scope: UsageScope;
  sessionId?: string;
  window: { from: string | null; to: string };
  ledgerAvailable: boolean;
  spend: {
    currency: 'USD';
    /** Metered USD across providers with a known price. null when nothing priced or no ledger. */
    totalUsd: number | null;
    /** True when some metered usage had no price, so totalUsd is a lower bound. */
    pricingIncomplete: boolean;
  };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  } | null;
  byProvider: Array<{
    provider: string;
    spendUsd: number | null;
    tokensIn: number;
    tokensOut: number;
    pricingIncomplete: boolean;
  }>;
  subscriptionProviders: Array<{ provider: string; tokensIn: number; tokensOut: number }>;
  byModel: Array<{
    provider: string;
    model: string;
    spendUsd: number | null;
    tokensIn: number;
    tokensOut: number;
    pricingIncomplete: boolean;
  }>;
  spendCap: SpendCapStatus | null;
  quotas: Array<{
    provider: string;
    kind: ResourceBudgetEntry['kind'];
    state: ResourceBudgetEntry['state'];
    accountLabel?: string;
    window?: string;
    usedPercent?: number;
    availableUsd?: number;
    resetsAt?: string;
    observedAt: string;
    observedAgeSeconds: number;
    source: ResourceBudgetEntry['source'];
  }>;
  limitations: string[];
}

function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function usageWindowStart(scope: UsageScope, now: number): number {
  if (scope === 'today') return startOfToday(now);
  if (scope === 'month') return startOfMonth(now);
  return 0;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function buildUsageSummary(
  request: UsageSummaryRequest,
  deps: UsageSummaryDependencies,
): Promise<UsageSummaryReport> {
  const now = (deps.now ?? Date.now)();
  const sinceMs = usageWindowStart(request.scope, now);
  const scopedIds =
    request.scope === 'session'
      ? new Set([request.sessionId])
      : request.scope === 'project'
        ? new Set(request.projectSessionIds)
        : undefined;

  const limitations: string[] = [
    'Spend is the ledger cost of recorded provider calls. Subscription providers have no per-token dollars; their tokens are listed separately.',
  ];

  const [allRows, budget, spendCap] = await Promise.all([
    Promise.resolve()
      .then(() => deps.rows(sinceMs))
      .catch(() => null),
    deps.budget().catch(() => null),
    deps.spendCap(request.sessionId).catch(() => null),
  ]);

  const ledgerAvailable = allRows !== null;
  if (!ledgerAvailable)
    limitations.push('The usage ledger is unavailable; spend and tokens are unknown, not zero.');
  const rows = (allRows ?? []).filter((row) => {
    if (!scopedIds) return true;
    return row.sessionId !== null && scopedIds.has(row.sessionId);
  });

  const meteredRows = rows.filter((row) => !SUBSCRIPTION_PROVIDERS.has(row.provider));
  const subscriptionRows = rows.filter((row) => SUBSCRIPTION_PROVIDERS.has(row.provider));
  const spend = summarizeBillingSpend(meteredRows);

  const tokens = ledgerAvailable
    ? rows.reduce(
        (acc, row) => ({
          input: acc.input + row.tokensIn,
          output: acc.output + row.tokensOut,
          cacheRead: acc.cacheRead + row.cacheReadTokens,
          cacheWrite: acc.cacheWrite + row.cacheWriteTokens,
          total: acc.total + row.tokensIn + row.tokensOut,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      )
    : null;

  const subscriptionByProvider = new Map<
    string,
    { provider: string; tokensIn: number; tokensOut: number }
  >();
  for (const row of subscriptionRows) {
    const entry = subscriptionByProvider.get(row.provider) ?? {
      provider: row.provider,
      tokensIn: 0,
      tokensOut: 0,
    };
    entry.tokensIn += row.tokensIn;
    entry.tokensOut += row.tokensOut;
    subscriptionByProvider.set(row.provider, entry);
  }

  const byModelMap = new Map<
    string,
    {
      provider: string;
      model: string;
      spendUsd: number;
      known: boolean;
      tokensIn: number;
      tokensOut: number;
      pricingIncomplete: boolean;
    }
  >();
  for (const row of meteredRows) {
    const key = `${row.provider}::${row.model}`;
    const entry = byModelMap.get(key) ?? {
      provider: row.provider,
      model: row.model,
      spendUsd: 0,
      known: false,
      tokensIn: 0,
      tokensOut: 0,
      pricingIncomplete: false,
    };
    entry.spendUsd += row.knownCostUsd;
    entry.known ||= row.knownRows > 0;
    entry.tokensIn += row.tokensIn;
    entry.tokensOut += row.tokensOut;
    entry.pricingIncomplete ||= row.unknownRows > 0;
    byModelMap.set(key, entry);
  }
  const byModel = [...byModelMap.values()].sort(
    (a, b) => b.spendUsd - a.spendUsd || a.model.localeCompare(b.model),
  );

  const pricingIncomplete = meteredRows.some((row) => row.unknownRows > 0);
  if (pricingIncomplete) {
    limitations.push(
      'Some metered usage has no known price; the spend total is a lower bound, not a complete figure.',
    );
  }

  const quotas: UsageSummaryReport['quotas'] = [];
  if (budget) {
    for (const entry of budget.entries) {
      if (entry.kind !== 'subscription_quota' && entry.kind !== 'api_balance') continue;
      quotas.push({
        provider: entry.provider,
        kind: entry.kind,
        state: entry.state,
        ...(entry.accountLabel ? { accountLabel: entry.accountLabel } : {}),
        ...(entry.window ? { window: entry.window } : {}),
        ...(entry.usedPercent === undefined ? {} : { usedPercent: entry.usedPercent }),
        ...(entry.availableUsd === undefined ? {} : { availableUsd: entry.availableUsd }),
        ...(entry.resetsAt === undefined ? {} : { resetsAt: iso(entry.resetsAt) }),
        observedAt: iso(entry.observedAt),
        observedAgeSeconds: Math.max(0, Math.round((now - entry.observedAt) / 1000)),
        source: entry.source,
      });
    }
    limitations.push(...budget.limitations);
  } else {
    limitations.push(
      'Subscription and balance state could not be read; quotas are unknown, not zero.',
    );
  }

  return {
    generatedAt: now,
    scope: request.scope,
    ...(request.scope === 'session' ? { sessionId: request.sessionId } : {}),
    window: { from: sinceMs > 0 ? iso(sinceMs) : null, to: iso(now) },
    ledgerAvailable,
    spend: {
      currency: 'USD',
      totalUsd: ledgerAvailable && spend.hasKnownSpend ? spend.totalSpendUsd : null,
      pricingIncomplete,
    },
    tokens,
    byProvider: spend.byProvider.map((provider) => ({
      provider: provider.name,
      spendUsd: provider.hasKnownCost ? (provider.spendUsd ?? null) : null,
      tokensIn: provider.tokensIn,
      tokensOut: provider.tokensOut,
      pricingIncomplete: provider.pricingIncomplete,
    })),
    subscriptionProviders: [...subscriptionByProvider.values()],
    byModel: byModel.slice(0, MAX_BY_MODEL_ROWS).map((model) => ({
      provider: model.provider,
      model: model.model,
      spendUsd: model.known ? model.spendUsd : null,
      tokensIn: model.tokensIn,
      tokensOut: model.tokensOut,
      pricingIncomplete: model.pricingIncomplete,
    })),
    spendCap,
    quotas,
    limitations,
  };
}
