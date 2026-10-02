import { describe, expect, test } from 'bun:test';
import {
  PromptCacheDiagnosticsRegistry,
  createCacheLane,
  evaluateCacheWarmthEconomics,
  explainCacheTransition,
  explainCacheTransitionDetails,
  selectAdaptiveCacheTtl,
} from '../cache-fabric';
const base = {
  baseCacheKey: 'base',
  stablePrefixHash: 'prefix',
  sessionId: 'a',
  kind: 'manager' as const,
  model: 'gpt-5.6',
  reasoning: 'medium',
  toolFingerprint: 'tools',
};
describe('cache fabric lanes', () => {
  test('shares provider routing across conversations while isolating lane identity', () => {
    const a = createCacheLane(base),
      b = createCacheLane({ ...base, sessionId: 'b' });
    expect(a.routingKey).toBe(b.routingKey);
    expect(a.key).not.toBe(b.key);
  });
  test('isolates role/model/tool changes and explains them', () => {
    const a = createCacheLane(base),
      b = createCacheLane({
        ...base,
        model: 'gpt-5.6-codex',
        reasoning: 'high',
        toolFingerprint: 'tools2',
      });
    expect(a.routingKey).not.toBe(b.routingKey);
    expect(explainCacheTransition(a, b)).toEqual(['model', 'reasoning', 'toolset']);
  });
  test('keeps provider routing stable across supported reasoning-only switches while tracking the execution variant', () => {
    const medium = createCacheLane({ ...base, reasoningScope: 'shared' }),
      high = createCacheLane({ ...base, reasoning: 'high', reasoningScope: 'shared' });
    expect(high.routingKey).toBe(medium.routingKey);
    expect(high.key).not.toBe(medium.key);
    expect(explainCacheTransition(medium, high)).toEqual(['reasoning']);
  });
  test('isolates provider routing across reasoning changes when capability policy fails closed', () => {
    const medium = createCacheLane({ ...base, reasoningScope: 'isolated' }),
      high = createCacheLane({ ...base, reasoning: 'high', reasoningScope: 'isolated' });
    expect(high.routingKey).not.toBe(medium.routingKey);
    expect(high.key).not.toBe(medium.key);
    expect(explainCacheTransition(medium, high)).toEqual(['reasoning']);
  });
  test('attributes a provider-route change caused only by reasoning capability policy', () => {
    const isolated = createCacheLane({ ...base, reasoningScope: 'isolated' }),
      shared = createCacheLane({ ...base, reasoningScope: 'shared' });
    expect(shared.routingKey).not.toBe(isolated.routingKey);
    expect(explainCacheTransition(isolated, shared)).toEqual(['reasoning-policy']);
  });
  test('tracks direct and workspace warm candidates', () => {
    const r = new PromptCacheDiagnosticsRegistry();
    const a = createCacheLane(base),
      b = createCacheLane({ ...base, sessionId: 'b' });
    expect(r.observe(a)).toMatchObject({ state: 'cold' });
    expect(r.observe(a)).toMatchObject({ state: 'warm-candidate', warmCandidateStreak: 1 });
    expect(r.observe(a)).toMatchObject({ state: 'warm-candidate', warmCandidateStreak: 2 });
    expect(r.observe(b)).toMatchObject({
      state: 'workspace-warm-candidate',
      workspaceReuseCount: 4,
    });
    expect(r.getStats()).toMatchObject({
      dispatches: 4,
      cold: 1,
      warmCandidates: 2,
      workspaceWarmCandidates: 1,
    });
    expect(selectAdaptiveCacheTtl(r.getRecent(1)[0])).toBe('1h');
  });
  test('recognizes a retained route when switching models away and back', () => {
    const r = new PromptCacheDiagnosticsRegistry();
    const a = createCacheLane(base),
      b = createCacheLane({ ...base, model: 'other-model' });
    expect(r.observe(a).state).toBe('cold');
    expect(r.observe(b).state).toBe('cold');
    expect(r.observe(a)).toMatchObject({ state: 'workspace-warm-candidate', reasons: [] });
  });
  test('distinguishes confirmed warm hits from provider-side cache rewrites', () => {
    const r = new PromptCacheDiagnosticsRegistry();
    const lane = createCacheLane(base);
    const cold = r.observe(lane);
    expect(
      r.recordProviderOutcome(cold, {
        inputTokens: 5000,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
      }),
    ).toMatchObject({ expectedWarm: false, unexpectedMiss: false });
    const warm = r.observe(lane);
    expect(
      r.recordProviderOutcome(warm, {
        inputTokens: 5100,
        cacheReadTokens: 5000,
        cacheWriteTokens: 0,
      }),
    ).toMatchObject({ confirmedHit: true, unexpectedMiss: false });
    const missed = r.observe(lane);
    expect(
      r.recordProviderOutcome(missed, {
        inputTokens: 5200,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
      }),
    ).toMatchObject({ expectedWarm: true, confirmedHit: false, unexpectedMiss: true });
    expect(r.getStats()).toMatchObject({
      providerOutcomes: 3,
      providerWarmHits: 1,
      providerUnexpectedMisses: 1,
      providerUnexpectedMissWriteTokens: 5000,
    });
  });
  test('attributes exact cache-break causes', () => {
    const a = createCacheLane({
        ...base,
        toolNames: ['read', 'write'],
        messageFingerprints: ['m1', 'm2'],
        stableComponentHashes: { role: 'a', style: 'same' },
      }),
      b = createCacheLane({
        ...base,
        stablePrefixHash: 'prefix2',
        toolFingerprint: 'tools2',
        toolNames: ['read', 'patch'],
        messageFingerprints: ['m1', 'changed'],
        stableComponentHashes: { role: 'b', style: 'same' },
      });
    expect(explainCacheTransition(a, b)).toEqual(['stable-prefix', 'toolset', 'history-rewrite']);
    expect(explainCacheTransitionDetails(a, b)).toEqual({
      toolsAdded: ['patch'],
      toolsRemoved: ['write'],
      toolSchemasChanged: false,
      stableComponentsChanged: ['role'],
      historyRewriteAt: 1,
    });
  });
  test('economics gate rejects negative-value refreshes', () => {
    expect(
      evaluateCacheWarmthEconomics({
        stableTokens: 50000,
        freshInputPerMillion: 2,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: 4,
        expectedReuseProbability: 0.5,
      }).keepWarm,
    ).toBe(false);
    expect(
      evaluateCacheWarmthEconomics({
        stableTokens: 100000,
        freshInputPerMillion: 10,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: 1,
        expectedReuseProbability: 0.95,
      }).keepWarm,
    ).toBe(true);
  });
});
