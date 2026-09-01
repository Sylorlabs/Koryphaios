import { describe, expect, it } from 'bun:test';
import {
  parseOpenRouterPricingCatalog,
  quoteOpenRouterInput,
  quoteOpenRouterUsage,
  resolveOpenRouterModelPricing,
} from '../openrouter-pricing';

function catalog(...data: Array<Record<string, unknown>>) {
  return parseOpenRouterPricingCatalog({ data }, 1_700_000_000_000);
}

describe('official OpenRouter inference pricing', () => {
  it('parses fresh, completion, cache-read, and cache-write token rates', () => {
    const parsed = catalog({
      id: 'z-ai/glm-5.3-flash',
      context_length: 1_310_720,
      pricing: {
        prompt: '0.000000075',
        completion: '0.00000025',
        input_cache_read: '0.000000015',
      },
    });
    expect(parsed.models.get('z-ai/glm-5.3-flash')).toMatchObject({
      prompt: 0.000000075,
      completion: 0.00000025,
      inputCacheRead: 0.000000015,
      contextLength: 1_310_720,
    });
  });

  it('resolves a provider-prefix mismatch only through a unique official slug', () => {
    const parsed = catalog({
      id: 'xiaomi/mimo-v2.5',
      pricing: { prompt: '0.00000014', input_cache_read: '0.0000000028' },
    });
    expect(resolveOpenRouterModelPricing(parsed, 'mimo/mimo-v2.5')?.id).toBe('xiaomi/mimo-v2.5');

    parsed.models.set('another/mimo-v2.5', {
      id: 'another/mimo-v2.5',
      prompt: 0.1,
      overrides: [],
    });
    expect(resolveOpenRouterModelPricing(parsed, 'mimo/mimo-v2.5')).toBeNull();
  });

  it('matches provider-native dated IDs to one canonical OpenRouter model', () => {
    const parsed = catalog(
      {
        id: 'anthropic/claude-sonnet-4.5',
        canonical_slug: 'anthropic/claude-4.5-sonnet-20250929',
        pricing: { prompt: '0.000003', completion: '0.000015' },
      },
      {
        id: 'anthropic/claude-sonnet-4.5:batch',
        canonical_slug: 'anthropic/claude-4.5-sonnet-20250929',
        pricing: { prompt: '0.0000015', completion: '0.0000075' },
      },
    );
    expect(
      resolveOpenRouterModelPricing(parsed, 'claude-sonnet-4-5-20250929', 'anthropic')?.id,
    ).toBe('anthropic/claude-sonnet-4.5');
    expect(
      resolveOpenRouterModelPricing(parsed, 'claude-sonnet-4-5-20250929', 'openai'),
    ).toMatchObject({ id: 'anthropic/claude-sonnet-4.5' });
  });

  it('resolves a globally unique bare CLI model even when its fallback provider is stale', () => {
    const parsed = catalog({
      id: 'moonshotai/kimi-k2',
      pricing: { prompt: '0.0000005', completion: '0.000002' },
    });
    expect(resolveOpenRouterModelPricing(parsed, 'kimi-k2', 'kimicode')?.id).toBe(
      'moonshotai/kimi-k2',
    );
    expect(resolveOpenRouterModelPricing(parsed, 'kimi-k2', 'openai')?.id).toBe(
      'moonshotai/kimi-k2',
    );
  });

  it('applies prompt-size overrides to each Freebuff request and includes caching', () => {
    const parsed = catalog({
      id: 'openai/gpt-5.6-luna',
      pricing: {
        prompt: '0.0000002',
        completion: '0.0000012',
        input_cache_read: '0.00000002',
        input_cache_write: '0.00000025',
        overrides: [
          {
            min_prompt_tokens: 272_000,
            prompt: '0.0000004',
            completion: '0.0000018',
            input_cache_read: '0.00000004',
            input_cache_write: '0.0000005',
          },
        ],
      },
    });
    const model = resolveOpenRouterModelPricing(parsed, 'openai/gpt-5.6-luna');
    expect(model).not.toBeNull();
    const quote = quoteOpenRouterInput(model!, [100_000, 300_000]);
    expect(quote.freshInputUsd).toBeCloseTo(0.14, 10);
    expect(quote.completionUsdPerMillion).toBeCloseTo(1.2, 10);
    expect(quote.cacheReadInputUsd).toBeCloseTo(0.014, 10);
    expect(quote.cacheWriteInputUsd).toBeCloseTo(0.175, 10);
    expect(quote.minimumInputUsd).toBeCloseTo(0.014, 10);
    expect(quote.maximumInputUsd).toBeCloseTo(0.175, 10);
    expect(quote.hasThresholdOverrides).toBe(true);

    const usage = quoteOpenRouterUsage(model!, [
      { tokensIn: 100_000, tokensOut: 10_000, cacheReadTokens: 20_000 },
      { tokensIn: 300_000, tokensOut: 20_000, cacheReadTokens: 50_000 },
    ]);
    expect(usage.outputUsd).toBeCloseTo(0.048, 10);
    expect(usage.freshValueUsd).toBeCloseTo(0.188, 10);
    expect(usage.minimumValueUsd).toBeCloseTo(0.062, 10);
    expect(usage.maximumValueUsd).toBeCloseTo(0.223, 10);
    expect(usage.cacheReadAdjustedValueUsd).toBeCloseTo(0.1664, 10);
  });

  it('does not invent a cache discount when OpenRouter publishes no cache rate', () => {
    const parsed = catalog({ id: 'vendor/text', pricing: { prompt: '0.000001' } });
    const model = resolveOpenRouterModelPricing(parsed, 'vendor/text')!;
    const quote = quoteOpenRouterInput(model, [10_000]);
    expect(quote.cacheReadInputUsd).toBeUndefined();
    expect(quote.minimumInputUsd).toBe(quote.freshInputUsd);
    expect(quote.maximumInputUsd).toBe(quote.freshInputUsd);
  });
});
