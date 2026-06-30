import { describe, expect, it } from 'bun:test';
import { mergeModelLists, modelFromRemoteId, isLikelyChatModelId } from '../model-list-cache';
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

  it('isLikelyChatModelId filters embedding models for openai-compatible providers', () => {
    expect(isLikelyChatModelId('text-embedding-3-small', 'groq')).toBe(false);
    expect(isLikelyChatModelId('llama-3.3-70b-versatile', 'groq')).toBe(true);
    expect(isLikelyChatModelId('gpt-4.1', 'openai')).toBe(true);
    expect(isLikelyChatModelId('davinci-002', 'openai')).toBe(false);
  });
});