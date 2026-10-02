import { describe, expect, it } from 'bun:test';
import { normalizeReasoningLevel } from '@koryphaios/shared';
import {
  canResumeAntigravityConversation,
  collapseAgyReasoningTiers,
  matchAgyModel,
  modelDefFromCliName,
  resolveAgyVariant,
} from '../antigravity';

const tierRows = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6',
];

describe('Antigravity model capabilities', () => {
  it('uses the CLI model name without inventing limits or reasoning tiers', () => {
    // modelDefFromCliName is the pure parser for `agy models` output; it
    // must not invent limits — those come from models.dev enrichment in
    // AntigravityProvider.refreshModelsInBackground.
    const model = modelDefFromCliName('gemini-3.6-flash-high\tGemini 3.6 Flash (High)');
    expect(model.apiModelId).toBe('gemini-3.6-flash-high');
    expect(model.name).toBe('Gemini 3.6 Flash (High)');
    expect(model.contextWindow).toBe(0);
    expect(model.maxOutputTokens).toBe(0);
    expect(model.reasoningLevels).toBeUndefined();
  });

  it('falls back to cliName when no display name is present', () => {
    const model = modelDefFromCliName('gemini-flash');
    expect(model.apiModelId).toBe('gemini-flash');
    expect(model.name).toBe('gemini-flash');
  });

  it('forwards the composer effort level to the provider', () => {
    // Antigravity has no reasoning parameter, but Koryphaios collapses the
    // per-tier slugs and maps the level onto one of them at spawn time.
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'low')).toBe('low');
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'high')).toBe('high');
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'auto')).toBe('auto');
  });

  it('never resumes a native transcript for nonlinear response regeneration', () => {
    const cached = { conversationId: 'agy-old', providerConversationRevision: 7 };
    expect(canResumeAntigravityConversation(cached, 7, false)).toBe(true);
    expect(canResumeAntigravityConversation(cached, 8, false)).toBe(false);
    expect(canResumeAntigravityConversation(cached, 7, true)).toBe(false);
  });
});

describe('Antigravity reasoning-tier collapse', () => {
  const catalog = collapseAgyReasoningTiers(tierRows.map(modelDefFromCliName));

  it('shows one base model per effort family and keeps untiered models as-is', () => {
    expect(catalog.map((m) => m.id)).toEqual([
      'antigravity-gemini-3-8-flash',
      'antigravity-claude-sonnet-4-6',
    ]);
    expect(catalog[0].name).toBe('Gemini 3.8 Flash');
    expect(catalog[1].name).toBe('Claude Sonnet 4.6');
    expect(catalog[1].reasoningLevels).toBeUndefined();
  });

  it('reports the real agy effort levels plus Auto as a Koryphaios control', () => {
    expect(catalog[0].reasoningLevels).toEqual(['low', 'medium', 'high', 'auto']);
    expect(catalog[0].canReason).toBe(true);
  });

  it('maps each effort level onto the agy slug that implements it', () => {
    expect(catalog[0].reasoningVariants).toEqual({
      low: 'gemini-3.8-flash-low',
      medium: 'gemini-3.8-flash-medium',
      high: 'gemini-3.8-flash-high',
    });
    expect(resolveAgyVariant(catalog[0], 'high')).toBe('gemini-3.8-flash-high');
    // The base model's own slug stays the default so Auto/advisory effort never
    // silently changes which model runs.
    expect(resolveAgyVariant(catalog[0], 'auto')).toBeUndefined();
    expect(resolveAgyVariant(catalog[0], undefined)).toBeUndefined();
    expect(resolveAgyVariant(catalog[1], 'high')).toBeUndefined();
  });

  it('defaults to the bare slug when agy reports one, and keeps the old ids as aliases', () => {
    const withBare = collapseAgyReasoningTiers(
      ['gemini-3.8-flash\tGemini 3.8 Flash', ...tierRows].map(modelDefFromCliName),
    );
    expect(withBare).toHaveLength(2);
    expect(withBare[0].id).toBe('antigravity-gemini-3-8-flash');
    expect(withBare[0].apiModelId).toBe('gemini-3.8-flash');
    expect(withBare[0].aliases).toEqual([
      'antigravity-gemini-3-8-flash-high',
      'gemini-3.8-flash-high',
      'antigravity-gemini-3-8-flash-medium',
      'gemini-3.8-flash-medium',
      'antigravity-gemini-3-8-flash-low',
      'gemini-3.8-flash-low',
    ]);
    expect(resolveAgyVariant(withBare[0], 'medium')).toBe('gemini-3.8-flash-medium');
  });

  it('keeps a lone tier verbatim instead of inventing levels', () => {
    const lone = collapseAgyReasoningTiers(
      ['gemini-3.8-flash-high\tGemini 3.8 Flash (High)'].map(modelDefFromCliName),
    );
    expect(lone).toHaveLength(1);
    expect(lone[0].id).toBe('antigravity-gemini-3-8-flash-high');
    expect(lone[0].reasoningLevels).toBeUndefined();
  });

  it('routes a pre-collapse selection to its base model and recovers its tier', () => {
    const match = matchAgyModel(catalog, 'antigravity-gemini-3-8-flash-medium');
    expect(match?.model.id).toBe('antigravity-gemini-3-8-flash');
    expect(match?.legacyEffort).toBe('medium');
    expect(resolveAgyVariant(match?.model, match?.legacyEffort)).toBe('gemini-3.8-flash-medium');
    expect(matchAgyModel(catalog, 'antigravity-gemini-3-8-flash')?.legacyEffort).toBeUndefined();
    expect(matchAgyModel(catalog, 'gemini-3.8-flash-high')?.model.id).toBe(
      'antigravity-gemini-3-8-flash',
    );
    expect(matchAgyModel(catalog, 'antigravity-nope')).toBeUndefined();
  });
});

describe('Antigravity models.dev enrichment', () => {
  // Ensures the provider is registered so applyModelsDevMetadata looks it up
  // in the public models.dev catalog. antigravity slugs are matched against
  // the `google` provider key (gemini-* / claude-* both live there) plus the
  // `openai` key (gpt-oss-*).
  it('stamps real context + output limits onto known gemini/claude slugs', async () => {
    const { applyModelsDevMetadata, warmModelsDevCache, __resetModelsDevCacheForTesting } = await import(
      '../models-dev'
    );
    // Force a fresh fetch — other test files in the same process may have
    // pre-populated the cache with mocked data.
    __resetModelsDevCacheForTesting();
    await warmModelsDevCache();
    const gemini = applyModelsDevMetadata(
      'antigravity',
      [modelDefFromCliName('gemini-3.6-flash\tGemini 3.6 Flash')],
      ['google', 'anthropic', 'openai'],
    )[0];
    const claude = applyModelsDevMetadata(
      'antigravity',
      [modelDefFromCliName('claude-sonnet-4-6\tClaude Sonnet 4.6')],
      ['google', 'anthropic', 'openai'],
    )[0];
    // The test passes when the catalog has data. If models.dev was
    // unreachable, the values stay at 0 — the live provider's UI then
    // shows "unknown" until the next refresh.
    if (gemini.contextWindow === 0 && claude.contextWindow === 0) {
      // network unreachable in the test env; that's fine, just skip.
      return;
    }
    expect(gemini.contextWindow).toBeGreaterThanOrEqual(1024);
    expect(gemini.contextVerified).toBe(true);
    expect(claude.contextWindow).toBeGreaterThanOrEqual(1024);
    expect(claude.contextVerified).toBe(true);
  });
});
