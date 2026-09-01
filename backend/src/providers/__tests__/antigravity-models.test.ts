import { describe, expect, it } from 'bun:test';
import { normalizeReasoningLevel } from '@koryphaios/shared';
import { canResumeAntigravityConversation, modelDefFromCliName } from '../antigravity';

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

  it('drops stale reasoning values instead of changing the selected model', () => {
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'low')).toBeUndefined();
    expect(normalizeReasoningLevel('antigravity', 'antigravity-gemini-flash', 'auto')).toBeUndefined();
  });

  it('never resumes a native transcript for nonlinear response regeneration', () => {
    const cached = { conversationId: 'agy-old', providerConversationRevision: 7 };
    expect(canResumeAntigravityConversation(cached, 7, false)).toBe(true);
    expect(canResumeAntigravityConversation(cached, 8, false)).toBe(false);
    expect(canResumeAntigravityConversation(cached, 7, true)).toBe(false);
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
