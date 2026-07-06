import { describe, expect, test } from 'bun:test';
import type { ModelDef } from '@koryphaios/shared';
import { enrichFromRemoteMetadata, mergeModelLists } from '../model-list-cache';

function def(overrides: Partial<ModelDef> = {}): ModelDef {
  return {
    id: 'test-model',
    name: 'test-model',
    provider: 'copilot',
    contextWindow: 0,
    maxOutputTokens: 4_096,
    supportsStreaming: true,
    ...overrides,
  };
}

describe('enrichFromRemoteMetadata', () => {
  test('ingests Copilot-style capabilities.limits and supports.vision', () => {
    const raw = {
      id: 'gpt-5.2',
      name: 'GPT-5.2',
      capabilities: {
        limits: { max_context_window_tokens: 264_000, max_output_tokens: 64_000 },
        supports: { vision: true },
      },
    };
    const out = enrichFromRemoteMetadata(raw, def());
    expect(out.contextWindow).toBe(264_000);
    expect(out.contextVerified).toBe(true);
    expect(out.maxOutputTokens).toBe(64_000);
    expect(out.vision).toBe(true);
    expect(out.supportsAttachments).toBe(true);
    expect(out.name).toBe('GPT-5.2');
  });

  test('ingests OpenRouter-style context_length', () => {
    const out = enrichFromRemoteMetadata({ id: 'x', context_length: 1_000_000 }, def());
    expect(out.contextWindow).toBe(1_000_000);
    expect(out.contextVerified).toBe(true);
  });

  test('leaves the def untouched when the raw entry has no metadata', () => {
    const base = def({ contextWindow: 128_000 });
    const out = enrichFromRemoteMetadata({ id: 'x' }, base);
    expect(out).toEqual(base);
    expect(out.contextVerified).toBeUndefined();
  });

  test('records vision: false so providers can strip images up front', () => {
    const out = enrichFromRemoteMetadata(
      { id: 'x', capabilities: { supports: { vision: false } } },
      def(),
    );
    expect(out.vision).toBe(false);
  });
});

describe('mergeModelLists live override', () => {
  test('live-verified context window beats the static catalog value', () => {
    const catalog = [def({ id: 'm1', contextWindow: 128_000, costPerMInputTokens: 3 })];
    const discovered = [
      def({ id: 'm1', contextWindow: 264_000, contextVerified: true, maxOutputTokens: 64_000 }),
    ];
    const merged = mergeModelLists(catalog, discovered);
    expect(merged).toHaveLength(1);
    expect(merged[0].contextWindow).toBe(264_000);
    expect(merged[0].contextVerified).toBe(true);
    expect(merged[0].maxOutputTokens).toBe(64_000);
    // Catalog-only metadata (pricing) survives the merge.
    expect(merged[0].costPerMInputTokens).toBe(3);
  });

  test('unverified discovered entries still defer to catalog metadata', () => {
    const catalog = [def({ id: 'm1', contextWindow: 128_000, name: 'Nice Name' })];
    const discovered = [def({ id: 'm1', contextWindow: 0 })];
    const merged = mergeModelLists(catalog, discovered);
    expect(merged[0].contextWindow).toBe(128_000);
    expect(merged[0].name).toBe('Nice Name');
  });
});

describe('trusted context metadata', () => {
  test('prefers a live provider or CLI context limit over the fallback catalog', async () => {
    const { resolveTrustedContextWindow, registerLiveModelResolver } = await import('../models');
    registerLiveModelResolver(() =>
      def({ provider: 'codex', contextWindow: 300_000, contextVerified: true }),
    );
    expect(resolveTrustedContextWindow('gpt-5.5', 'codex')).toEqual({
      contextWindow: 300_000,
      contextKnown: true,
      contextSource: 'live',
    });
    registerLiveModelResolver(() => undefined);
  });

  test('rejects a boolean-like live window and falls back to the provider catalog', async () => {
    const { resolveTrustedContextWindow, registerLiveModelResolver } = await import('../models');
    registerLiveModelResolver(() => def({ provider: 'codex', contextWindow: 1, contextVerified: true }));
    const resolved = resolveTrustedContextWindow('gpt-5.5', 'codex');
    expect(resolved.contextKnown).toBe(true);
    expect(resolved.contextWindow).toBe(272_000);
    expect(resolved.contextSource).toBe('catalog');
    registerLiveModelResolver(() => undefined);
  });

  test('never borrows context metadata from a different provider', async () => {
    const { resolveTrustedContextWindow, registerLiveModelResolver } = await import('../models');
    registerLiveModelResolver(() => undefined);
    expect(resolveTrustedContextWindow('gpt-5.3-codex', 'openai').contextWindow).toBe(500_000);
    expect(resolveTrustedContextWindow('gpt-5.3-codex', 'codex').contextKnown).toBe(false);
  });

  test('uses built-in context metadata for providers outside the old allowlist', async () => {
    const { resolveTrustedContextWindow, registerLiveModelResolver } = await import('../models');
    registerLiveModelResolver(() => undefined);
    const resolved = resolveTrustedContextWindow('azure.gpt-4.1', 'azure');
    expect(resolved).toEqual({
      contextWindow: 1_047_576,
      contextKnown: true,
      contextSource: 'catalog',
    });
  });
});
