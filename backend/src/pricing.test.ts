import { afterEach, describe, expect, test } from 'bun:test';
import { computeCostUsd, resolvePricing } from './pricing';
import { __resetModelsDevCacheForTesting, warmModelsDevCache } from './providers/models-dev';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetModelsDevCacheForTesting();
});

/** Load deliberately conflicting provider rates to test attribution. */
async function seedPrices(): Promise<void> {
  __resetModelsDevCacheForTesting();
  globalThis.fetch = (async () => Response.json({
    unrelated: { models: { 'test-model': { id: 'test-model', cost: { input: 99, output: 99 } } } },
    openai: { models: { 'test-model': { id: 'test-model', cost: { input: 2, output: 8, cache_read: 1 } } } },
    openrouter: { models: { 'openai/test-model': { id: 'openai/test-model', cost: { input: 3, output: 9 } } } },
  })) as unknown as typeof fetch;
  await warmModelsDevCache();
}

describe('provider spending provenance', () => {
  test('uses the selected provider rate ahead of the equivalent', async () => {
    await seedPrices();
    expect(computeCostUsd('openai', 'test-model', 1_000_000, 1_000_000, { cacheReadTokens: 500_000 }))
      .toMatchObject({ costUsd: 9.5, source: 'models.dev' });
  });

  test('uses only OpenRouter for fallback and identifies the equivalent', async () => {
    await seedPrices();
    expect(computeCostUsd('custom:unknown', 'test-model', 1_000_000, 1_000_000))
      .toMatchObject({ costUsd: 12, source: 'openrouter-equivalent' });
  });

  test('keeps missing prices unknown instead of taking another provider rate', async () => {
    await seedPrices();
    expect(resolvePricing('custom:unknown', 'not-priced')).toBeNull();
  });
});
