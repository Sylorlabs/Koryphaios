import { describe, expect, it } from 'bun:test';
import {
  enrichFromRemoteMetadata,
  mergeModelLists,
  modelFromRemoteId,
  isLikelyChatModelId,
} from '../model-list-cache';
import type { ModelDef } from '@koryphaios/shared';

const fallback: ModelDef[] = [
  {
    id: 'grok-build',
    name: 'Grok Build',
    provider: 'grok',
    apiModelId: 'grok-build',
    contextWindow: 256_000,
    maxOutputTokens: 50_000,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: 'flagship',
  },
];

describe('model-list-cache', () => {
  it('mergeModelLists prefers discovered ids and enriches from fallback', () => {
    const discovered = [
      modelFromRemoteId('grok-build', 'grok', fallback),
      modelFromRemoteId('grok-composer-2.5-fast', 'grok', fallback),
    ];
    const merged = mergeModelLists(fallback, discovered);
    expect(merged.map((m) => m.apiModelId)).toEqual(['grok-build', 'grok-composer-2.5-fast']);
    expect(merged[0].name).toBe('Grok Build');
    expect(merged[1].name).toBe('grok-composer-2.5-fast');
  });

  it('never appends a catalog-only model after a successful provider listing', () => {
    const stale = {
      ...fallback[0],
      id: 'grok-retired',
      apiModelId: 'grok-retired',
      name: 'Retired Grok',
    };
    const merged = mergeModelLists(
      [...fallback, stale],
      [modelFromRemoteId('grok-build', 'grok', fallback)],
    );
    expect(merged.map((model) => model.apiModelId)).toEqual(['grok-build']);
  });

  it('isLikelyChatModelId filters embedding models for openai-compatible providers', () => {
    expect(isLikelyChatModelId('text-embedding-3-small', 'groq')).toBe(false);
    expect(isLikelyChatModelId('llama-3.3-70b-versatile', 'groq')).toBe(true);
    expect(isLikelyChatModelId('gpt-4.1', 'openai')).toBe(true);
    expect(isLikelyChatModelId('davinci-002', 'openai')).toBe(false);
  });
});

describe('enrichFromRemoteMetadata reasoning flags', () => {
  const base: ModelDef = {
    id: 'gateway-model',
    name: 'gateway-model',
    provider: 'groq',
    contextWindow: 8_000,
    maxOutputTokens: 4_000,
  };

  it('reads a top-level reasoning flag', () => {
    const enriched = enrichFromRemoteMetadata({ id: 'gateway-model', reasoning: true }, base);
    expect(enriched.canReason).toBe(true);
    expect(enriched.contextWindow).toBe(8_000);
  });

  it('reads reasoning from nested capability shapes, top level winning', () => {
    const supportsOnly = enrichFromRemoteMetadata(
      { id: 'gateway-model', capabilities: { supports: { reasoning: false } } },
      base,
    );
    expect(supportsOnly.canReason).toBe(false);

    const capsOnly = enrichFromRemoteMetadata(
      { id: 'gateway-model', capabilities: { reasoning: true } },
      base,
    );
    expect(capsOnly.canReason).toBe(true);

    const topWins = enrichFromRemoteMetadata(
      { id: 'gateway-model', reasoning: true, capabilities: { reasoning: false } },
      base,
    );
    expect(topWins.canReason).toBe(true);
  });

  it('leaves canReason undefined when no reasoning flag is reported', () => {
    const enriched = enrichFromRemoteMetadata({ context_window: 32_000 }, base);
    expect(enriched.contextWindow).toBe(32_000);
    expect(enriched.canReason).toBeUndefined();
  });

  it('combines context_window and reasoning in one entry', () => {
    const enriched = enrichFromRemoteMetadata(
      { id: 'gateway-model', context_window: 128_000, reasoning: true },
      base,
    );
    expect(enriched.contextWindow).toBe(128_000);
    expect(enriched.contextVerified).toBe(true);
    expect(enriched.canReason).toBe(true);
  });

  it('returns def unchanged when only unknown fields are present', () => {
    const def: ModelDef = { ...base };
    expect(
      enrichFromRemoteMetadata({ id: 'gateway-model', owned_by: 'org', created: 123 }, def),
    ).toBe(def);
  });
});
