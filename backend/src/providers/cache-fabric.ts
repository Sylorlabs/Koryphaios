import { createHash } from 'node:crypto';
import type { PromptCacheLaneKind } from './types';

type CacheLaneKind = PromptCacheLaneKind;

export type CacheTransitionReason =
  | 'new-lane'
  | 'stable-prefix'
  | 'model'
  | 'reasoning'
  | 'reasoning-policy'
  | 'toolset'
  | 'history-rewrite'
  | 'base-policy';

export interface CacheLaneInput {
  baseCacheKey: string;
  stablePrefixHash: string;
  sessionId?: string;
  kind?: CacheLaneKind;
  model: string;
  reasoning?: string;
  reasoningScope?: 'shared' | 'isolated';
  toolFingerprint: string;
  toolNames?: string[];
  messageFingerprints?: string[];
  stableComponentHashes?: Record<string, string>;
}

export interface CacheLaneIdentity {
  key: string;
  routingKey: string;
  slotKey: string;
  kind: CacheLaneKind;
  stablePrefixHash: string;
  model: string;
  reasoning: string;
  reasoningScope: 'shared' | 'isolated';
  toolFingerprint: string;
  toolNames: string[];
  messageFingerprints: string[];
  stableComponentHashes: Record<string, string>;
  baseCacheKey: string;
}

export interface CacheTransitionDetails {
  toolsAdded: string[];
  toolsRemoved: string[];
  toolSchemasChanged: boolean;
  stableComponentsChanged: string[];
  historyRewriteAt?: number;
}

export interface CacheDispatchDiagnostic {
  state: 'cold' | 'warm-candidate' | 'workspace-warm-candidate';
  laneKey: string;
  routingKey: string;
  laneKind: CacheLaneKind;
  reasons: CacheTransitionReason[];
  details: CacheTransitionDetails;
  warmCandidateStreak: number;
  workspaceReuseCount: number;
  observedAt: number;
}

export interface PromptCacheDiagnosticStats {
  dispatches: number;
  cold: number;
  warmCandidates: number;
  workspaceWarmCandidates: number;
  providerOutcomes: number;
  providerWarmHits: number;
  providerUnexpectedMisses: number;
  providerUnexpectedMissWriteTokens: number;
  breaks: Record<CacheTransitionReason, number>;
}

export interface CacheProviderOutcome {
  expectedWarm: boolean;
  confirmedHit: boolean;
  unexpectedMiss: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? '';

/** Workspace-wide provider routing plus conversation-local diagnostics. */
export function createCacheLane(input: CacheLaneInput): CacheLaneIdentity {
  const kind = input.kind ?? 'default';
  const reasoning = normalize(input.reasoning);
  const reasoningScope = input.reasoningScope ?? 'isolated';
  const model = normalize(input.model);
  const sessionFingerprint = input.sessionId
    ? sha256(`session\0${input.sessionId}`).slice(0, 24)
    : 'shared';
  const reasoningDomain = reasoningScope === 'shared' ? 'shared-reasoning' : reasoning;
  const routingKey = `kory-route-${sha256(
    [
      'kory-cache-fabric-v5',
      kind,
      input.baseCacheKey,
      input.stablePrefixHash,
      model,
      reasoningDomain,
      input.toolFingerprint,
    ].join('\0'),
  ).slice(0, 48)}`;
  // Reasoning always stays in the execution-lane identity. It leaves the
  // provider cache-domain identity only when provider/model capability policy
  // says that reasoning variants share one native cache namespace.
  const slotKey = `kory-slot-${sha256(['v5', sessionFingerprint, kind].join('\0')).slice(0, 32)}`;
  const key = `kory-lane-${sha256(['v5', routingKey, sessionFingerprint, reasoning].join('\0')).slice(0, 48)}`;
  return {
    key,
    routingKey,
    slotKey,
    kind,
    stablePrefixHash: input.stablePrefixHash,
    model,
    reasoning,
    reasoningScope,
    toolFingerprint: input.toolFingerprint,
    toolNames: [...new Set(input.toolNames ?? [])].sort(),
    messageFingerprints: [...(input.messageFingerprints ?? [])],
    stableComponentHashes: { ...(input.stableComponentHashes ?? {}) },
    baseCacheKey: input.baseCacheKey,
  };
}

function firstHistoryRewrite(previous: string[], next: string[]): number | undefined {
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index++) {
    if (previous[index] !== next[index]) return index;
  }
  return next.length < previous.length ? next.length : undefined;
}

export function explainCacheTransitionDetails(
  previous: CacheLaneIdentity,
  next: CacheLaneIdentity,
): CacheTransitionDetails {
  const previousTools = new Set(previous.toolNames);
  const nextTools = new Set(next.toolNames);
  const toolsAdded = next.toolNames.filter((name) => !previousTools.has(name));
  const toolsRemoved = previous.toolNames.filter((name) => !nextTools.has(name));
  const componentNames = new Set([
    ...Object.keys(previous.stableComponentHashes),
    ...Object.keys(next.stableComponentHashes),
  ]);
  const stableComponentsChanged = [...componentNames]
    .filter((name) => previous.stableComponentHashes[name] !== next.stableComponentHashes[name])
    .sort();
  return {
    toolsAdded,
    toolsRemoved,
    toolSchemasChanged:
      previous.toolFingerprint !== next.toolFingerprint &&
      toolsAdded.length === 0 &&
      toolsRemoved.length === 0,
    stableComponentsChanged,
    historyRewriteAt: firstHistoryRewrite(previous.messageFingerprints, next.messageFingerprints),
  };
}

export function explainCacheTransition(
  previous: CacheLaneIdentity,
  next: CacheLaneIdentity,
): CacheTransitionReason[] {
  const reasons: CacheTransitionReason[] = [];
  const details = explainCacheTransitionDetails(previous, next);
  if (previous.stablePrefixHash !== next.stablePrefixHash) reasons.push('stable-prefix');
  if (previous.model !== next.model) reasons.push('model');
  if (previous.reasoning !== next.reasoning) reasons.push('reasoning');
  if (previous.reasoningScope !== next.reasoningScope) reasons.push('reasoning-policy');
  if (previous.toolFingerprint !== next.toolFingerprint) reasons.push('toolset');
  if (details.historyRewriteAt !== undefined) reasons.push('history-rewrite');
  if (previous.baseCacheKey !== next.baseCacheKey) reasons.push('base-policy');
  return reasons;
}

export class PromptCacheDiagnosticsRegistry {
  private readonly previousBySlot = new Map<string, CacheLaneIdentity>();
  private readonly routeSeen = new Map<string, number>();
  private readonly warmStreakBySlot = new Map<string, number>();
  private readonly recent: CacheDispatchDiagnostic[] = [];
  private dispatches = 0;
  private cold = 0;
  private warmCandidates = 0;
  private workspaceWarmCandidates = 0;
  private providerOutcomes = 0;
  private providerWarmHits = 0;
  private providerUnexpectedMisses = 0;
  private providerUnexpectedMissWriteTokens = 0;
  private readonly breaks: Record<CacheTransitionReason, number> = {
    'new-lane': 0,
    'stable-prefix': 0,
    model: 0,
    reasoning: 0,
    'reasoning-policy': 0,
    toolset: 0,
    'history-rewrite': 0,
    'base-policy': 0,
  };

  observe(lane: CacheLaneIdentity, now = Date.now()): CacheDispatchDiagnostic {
    this.dispatches++;
    const previous = this.previousBySlot.get(lane.slotKey);
    const priorRouteCount = this.routeSeen.get(lane.routingKey) ?? 0;
    const reasons = previous ? explainCacheTransition(previous, lane) : (['new-lane'] as const);
    const details = previous
      ? explainCacheTransitionDetails(previous, lane)
      : {
          toolsAdded: [],
          toolsRemoved: [],
          toolSchemasChanged: false,
          stableComponentsChanged: [],
        };
    let state: CacheDispatchDiagnostic['state'];
    if (previous && reasons.length === 0) {
      state = 'warm-candidate';
      this.warmCandidates++;
    } else if (priorRouteCount > 0) {
      state = 'workspace-warm-candidate';
      this.workspaceWarmCandidates++;
    } else {
      state = 'cold';
      this.cold++;
    }
    if (state === 'cold') for (const reason of reasons) this.breaks[reason]++;
    const previousStreak = this.warmStreakBySlot.get(lane.slotKey) ?? 0;
    const warmCandidateStreak =
      state === 'warm-candidate'
        ? previousStreak + 1
        : state === 'workspace-warm-candidate'
          ? 1
          : 0;
    this.warmStreakBySlot.set(lane.slotKey, warmCandidateStreak);
    const workspaceReuseCount = priorRouteCount + 1;
    this.routeSeen.set(lane.routingKey, workspaceReuseCount);
    this.previousBySlot.set(lane.slotKey, lane);
    const diagnostic: CacheDispatchDiagnostic = {
      state,
      laneKey: lane.key,
      routingKey: lane.routingKey,
      laneKind: lane.kind,
      reasons: state === 'workspace-warm-candidate' ? [] : [...reasons],
      details,
      warmCandidateStreak,
      workspaceReuseCount,
      observedAt: now,
    };
    this.recent.push(diagnostic);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    return diagnostic;
  }

  getStats(): PromptCacheDiagnosticStats {
    return {
      dispatches: this.dispatches,
      cold: this.cold,
      warmCandidates: this.warmCandidates,
      workspaceWarmCandidates: this.workspaceWarmCandidates,
      providerOutcomes: this.providerOutcomes,
      providerWarmHits: this.providerWarmHits,
      providerUnexpectedMisses: this.providerUnexpectedMisses,
      providerUnexpectedMissWriteTokens: this.providerUnexpectedMissWriteTokens,
      breaks: { ...this.breaks },
    };
  }
  recordProviderOutcome(
    diagnostic: Pick<CacheDispatchDiagnostic, 'state'>,
    usage: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  ): CacheProviderOutcome {
    const inputTokens = Math.max(0, Math.floor(usage.inputTokens ?? 0));
    const cacheReadTokens = Math.max(0, Math.floor(usage.cacheReadTokens ?? 0));
    const cacheWriteTokens = Math.max(0, Math.floor(usage.cacheWriteTokens ?? 0));
    const expectedWarm = diagnostic.state !== 'cold';
    const confirmedHit = expectedWarm && cacheReadTokens > 0;
    // A zero-read request is only suspicious when the provider also reports a
    // fresh cache write. That avoids warning on prompts below a provider's
    // cache minimum or providers that do not expose cache-write telemetry.
    const unexpectedMiss = expectedWarm && cacheReadTokens === 0 && cacheWriteTokens > 0;
    this.providerOutcomes++;
    if (confirmedHit) this.providerWarmHits++;
    if (unexpectedMiss) {
      this.providerUnexpectedMisses++;
      this.providerUnexpectedMissWriteTokens += cacheWriteTokens;
    }
    return {
      expectedWarm,
      confirmedHit,
      unexpectedMiss,
      cacheReadTokens,
      cacheWriteTokens,
      inputTokens,
    };
  }
  getRecent(limit = 50): CacheDispatchDiagnostic[] {
    return this.recent.slice(-Math.max(0, limit));
  }
  clear(): void {
    this.previousBySlot.clear();
    this.routeSeen.clear();
    this.warmStreakBySlot.clear();
    this.recent.length = 0;
    this.dispatches = this.cold = this.warmCandidates = this.workspaceWarmCandidates = 0;
    this.providerOutcomes = this.providerWarmHits = this.providerUnexpectedMisses = 0;
    this.providerUnexpectedMissWriteTokens = 0;
    for (const reason of Object.keys(this.breaks) as CacheTransitionReason[])
      this.breaks[reason] = 0;
  }
}
export const promptCacheDiagnostics = new PromptCacheDiagnosticsRegistry();

export type AdaptiveCacheTtl = '5m' | '1h';
export function selectAdaptiveCacheTtl(
  diagnostic:
    Pick<CacheDispatchDiagnostic, 'warmCandidateStreak' | 'workspaceReuseCount'> | undefined,
): AdaptiveCacheTtl {
  if (!diagnostic) return '5m';
  return diagnostic.warmCandidateStreak >= 2 || diagnostic.workspaceReuseCount >= 3 ? '1h' : '5m';
}

export interface CacheWarmthEconomicsInput {
  stableTokens: number;
  freshInputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  refreshPerMillion?: number;
  /** Expected token breakdown of the keepalive replay itself. When supplied,
   * this replaces the old stable-prefix-only refresh-cost approximation. */
  refreshCachedTokens?: number;
  refreshFreshTokens?: number;
  expectedReuseProbability: number;
  expectedReuseCount?: number;
  refreshOverheadTokens?: number;
  minimumNetSavingsUsd?: number;
}
export interface CacheWarmthDecision {
  keepWarm: boolean;
  expectedSavingsUsd: number;
  refreshCostUsd: number;
  expectedNetSavingsUsd: number;
}
export function evaluateCacheWarmthEconomics(
  input: CacheWarmthEconomicsInput,
): CacheWarmthDecision {
  const stableTokens = Math.max(0, input.stableTokens);
  const probability = Math.max(0, Math.min(1, input.expectedReuseProbability));
  const reuseCount = Math.max(1, input.expectedReuseCount ?? 1);
  const refreshOverheadTokens = Math.max(0, input.refreshOverheadTokens ?? 1);
  const threshold = Math.max(0, input.minimumNetSavingsUsd ?? 0);
  const readSavingsPerMillion = Math.max(0, input.freshInputPerMillion - input.cacheReadPerMillion);
  const expectedSavingsUsd =
    (stableTokens / 1_000_000) * readSavingsPerMillion * probability * reuseCount;
  const hasRefreshBreakdown =
    input.refreshCachedTokens !== undefined || input.refreshFreshTokens !== undefined;
  const refreshCostUsd = hasRefreshBreakdown
    ? (Math.max(0, input.refreshCachedTokens ?? 0) / 1_000_000) *
        Math.max(0, input.cacheReadPerMillion) +
      (Math.max(0, input.refreshFreshTokens ?? 0) / 1_000_000) *
        Math.max(0, input.freshInputPerMillion) +
      (refreshOverheadTokens / 1_000_000) * Math.max(0, input.freshInputPerMillion)
    : (stableTokens / 1_000_000) *
        Math.max(0, input.refreshPerMillion ?? input.cacheWritePerMillion) +
      (refreshOverheadTokens / 1_000_000) * Math.max(0, input.freshInputPerMillion);
  const expectedNetSavingsUsd = expectedSavingsUsd - refreshCostUsd;
  return {
    keepWarm: expectedNetSavingsUsd > threshold,
    expectedSavingsUsd,
    refreshCostUsd,
    expectedNetSavingsUsd,
  };
}
