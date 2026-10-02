import { formatUsdDelta, isZeroUsd } from './usd';

export interface CacheDiagnostics {
  prompt: {
    dispatches: number;
    cold: number;
    warmCandidates: number;
    workspaceWarmCandidates: number;
    providerOutcomes: number;
    providerWarmHits: number;
    providerUnexpectedMisses: number;
    providerUnexpectedMissWriteTokens: number;
    breaks: Record<string, number>;
  };
  recent: Array<{
    state: 'cold' | 'warm-candidate' | 'workspace-warm-candidate';
    laneKind: string;
    reasons: string[];
    details?: {
      toolsAdded: string[];
      toolsRemoved: string[];
      toolSchemasChanged: boolean;
      stableComponentsChanged: string[];
      historyRewriteAt?: number;
    };
    warmCandidateStreak: number;
    workspaceReuseCount: number;
    observedAt: number;
  }>;
  evidence: {
    hits: number;
    misses: number;
    waits: number;
    loads: number;
    invalidations: number;
    evictions: number;
    size: number;
    inFlight: number;
  };
  maintenance: {
    observations: number;
    scheduled: number;
    refreshes: number;
    skippedEconomics: number;
    skippedInactive: number;
    skippedUnsupported: number;
    skippedUnknownPricing: number;
    cancelledIdentityChanges: number;
    failures: number;
    prewarms: number;
    prewarmSkips: number;
    estimatedSavingsUsd: number;
  };
  durable: {
    requests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    hitRate: number;
    savingsUsd: number;
    averageTtftMs: number | null;
    averageLatencyMs: number | null;
    byProvider: Array<{
      provider: string;
      requests: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      hitRate: number;
      savingsUsd: number;
      averageTtftMs: number | null;
      averageLatencyMs: number | null;
    }>;
  };
}

type Unknown = Record<string, unknown>;

function asRecord(value: unknown): Unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function countMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(record)) out[key] = num(count);
  return out;
}

function normalizeDispatch(value: unknown): CacheDiagnostics['recent'][number] {
  const entry = asRecord(value);
  const details = entry.details;
  const state =
    entry.state === 'warm-candidate' || entry.state === 'workspace-warm-candidate'
      ? entry.state
      : 'cold';
  const base = {
    state,
    laneKind: str(entry.laneKind),
    reasons: strList(entry.reasons),
    warmCandidateStreak: num(entry.warmCandidateStreak),
    workspaceReuseCount: num(entry.workspaceReuseCount),
    observedAt: num(entry.observedAt),
  } satisfies Omit<CacheDiagnostics['recent'][number], 'details'>;
  if (details === undefined || details === null) return base;
  const detailRecord = asRecord(details);
  const historyRewriteAt = nullableNum(detailRecord.historyRewriteAt);
  return {
    ...base,
    details: {
      toolsAdded: strList(detailRecord.toolsAdded),
      toolsRemoved: strList(detailRecord.toolsRemoved),
      toolSchemasChanged: detailRecord.toolSchemasChanged === true,
      stableComponentsChanged: strList(detailRecord.stableComponentsChanged),
      ...(historyRewriteAt === null ? {} : { historyRewriteAt }),
    },
  };
}

function normalizeProviderRow(value: unknown): CacheDiagnostics['durable']['byProvider'][number] {
  const row = asRecord(value);
  return {
    provider: str(row.provider),
    requests: num(row.requests),
    inputTokens: num(row.inputTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheWriteTokens: num(row.cacheWriteTokens),
    hitRate: num(row.hitRate),
    savingsUsd: num(row.savingsUsd),
    averageTtftMs: nullableNum(row.averageTtftMs),
    averageLatencyMs: nullableNum(row.averageLatencyMs),
  };
}

/** Coerce a `/api/providers/cache-diagnostics` payload into a fully populated
 * shape.
 *
 * The payload is a rolling diagnostic surface: the backend adds and removes
 * sections as cache work lands, and an older backend or a partial response can
 * omit a whole block. Every consumer is a Svelte `$derived`, so a single
 * missing field used to throw inside the render and tear down the whole app
 * shell. Normalizing at the boundary means unknown, missing, or wrongly typed
 * fields degrade to zero instead of crashing. */
export function normalizeCacheDiagnostics(value: unknown): CacheDiagnostics | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Unknown;
  const prompt = asRecord(raw.prompt);
  const evidence = asRecord(raw.evidence);
  const maintenance = asRecord(raw.maintenance);
  const durable = asRecord(raw.durable);
  return {
    prompt: {
      dispatches: num(prompt.dispatches),
      cold: num(prompt.cold),
      warmCandidates: num(prompt.warmCandidates),
      workspaceWarmCandidates: num(prompt.workspaceWarmCandidates),
      providerOutcomes: num(prompt.providerOutcomes),
      providerWarmHits: num(prompt.providerWarmHits),
      providerUnexpectedMisses: num(prompt.providerUnexpectedMisses),
      providerUnexpectedMissWriteTokens: num(prompt.providerUnexpectedMissWriteTokens),
      breaks: countMap(prompt.breaks),
    },
    recent: Array.isArray(raw.recent) ? raw.recent.map(normalizeDispatch) : [],
    evidence: {
      hits: num(evidence.hits),
      misses: num(evidence.misses),
      waits: num(evidence.waits),
      loads: num(evidence.loads),
      invalidations: num(evidence.invalidations),
      evictions: num(evidence.evictions),
      size: num(evidence.size),
      inFlight: num(evidence.inFlight),
    },
    maintenance: {
      observations: num(maintenance.observations),
      scheduled: num(maintenance.scheduled),
      refreshes: num(maintenance.refreshes),
      skippedEconomics: num(maintenance.skippedEconomics),
      skippedInactive: num(maintenance.skippedInactive),
      skippedUnsupported: num(maintenance.skippedUnsupported),
      skippedUnknownPricing: num(maintenance.skippedUnknownPricing),
      cancelledIdentityChanges: num(maintenance.cancelledIdentityChanges),
      failures: num(maintenance.failures),
      prewarms: num(maintenance.prewarms),
      prewarmSkips: num(maintenance.prewarmSkips),
      estimatedSavingsUsd: num(maintenance.estimatedSavingsUsd),
    },
    durable: {
      requests: num(durable.requests),
      inputTokens: num(durable.inputTokens),
      cacheReadTokens: num(durable.cacheReadTokens),
      cacheWriteTokens: num(durable.cacheWriteTokens),
      hitRate: num(durable.hitRate),
      savingsUsd: num(durable.savingsUsd),
      averageTtftMs: nullableNum(durable.averageTtftMs),
      averageLatencyMs: nullableNum(durable.averageLatencyMs),
      byProvider: Array.isArray(durable.byProvider)
        ? durable.byProvider.map(normalizeProviderRow)
        : [],
    },
  };
}

/** Full diagnostic receipt shown on hover over the cache fabric label. */
export function buildCacheDiagnosticsNotice(diagnostics: CacheDiagnostics): string {
  const prompt = diagnostics.prompt;
  const warm = prompt.warmCandidates + prompt.workspaceWarmCandidates;
  const evidence = diagnostics.evidence;
  const evidenceTotal = evidence.hits + evidence.misses;
  const evidenceHitRate = evidenceTotal > 0 ? Math.round((evidence.hits / evidenceTotal) * 100) : 0;
  const last = diagnostics.recent.at(-1);
  const breakDetails: string[] = [];
  if (last?.details?.toolsAdded.length) breakDetails.push(`tools added: ${last.details.toolsAdded.join(', ')}`);
  if (last?.details?.toolsRemoved.length) breakDetails.push(`tools removed: ${last.details.toolsRemoved.join(', ')}`);
  if (last?.details?.toolSchemasChanged) breakDetails.push('tool schema changed');
  if (last?.details?.stableComponentsChanged.length) breakDetails.push(`system sections: ${last.details.stableComponentsChanged.join(', ')}`);
  if (last?.details?.historyRewriteAt !== undefined) breakDetails.push(`history rewritten at message ${last.details.historyRewriteAt + 1}`);
  const lastBreak = last?.state === 'cold' && last.reasons.length > 0
    ? ` Last cold reason: ${last.reasons.join(', ')}${breakDetails.length ? ` (${breakDetails.join('; ')})` : ''}.`
    : '';
  const maintenance = diagnostics.maintenance;
  const durable = diagnostics.durable;
  const durableHitRate = Math.round(durable.hitRate * 1000) / 10;
  const durableValue = isZeroUsd(durable.savingsUsd)
    ? '$0 net change'
    : `${formatUsdDelta(durable.savingsUsd) ?? ''} net ${durable.savingsUsd >= 0 ? 'saved' : 'cache premium'}`;
  const providerOutcome = prompt.providerOutcomes > 0
    ? ` Provider-confirmed warm hits: ${prompt.providerWarmHits}; unexpected warm misses: ${prompt.providerUnexpectedMisses}${prompt.providerUnexpectedMisses > 0 ? ` (${compactTokens(prompt.providerUnexpectedMissWriteTokens)} rewritten tokens)` : ''}.`
    : '';
  return `Harness cache: ${warm}/${prompt.dispatches} warm candidates.${providerOutcome} Evidence cache: ${evidence.hits} hits, ${evidence.waits} concurrent waits, ${evidenceHitRate}% hit rate. Cache maintenance: ${maintenance.refreshes}/${maintenance.scheduled} economical refreshes, ${maintenance.prewarms} typing prewarms. Durable 30-day provider cache: ${durableHitRate}% hit rate, ${durableValue}.${lastBreak}`;
}

function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}
