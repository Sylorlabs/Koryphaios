import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { TokenHarborProvider } from '../tokenharbor';
import { resolvePricing } from '../../pricing';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): ProviderConfig {
  return {
    name: 'tokenharbor',
    apiKey: 'synthetic-test-key',
    baseUrl: 'https://tokenharbor.ai/v1',
    disabled: false,
  } as ProviderConfig;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TokenHarborProvider catalog', () => {
  it('ingests published context, USD prices and the reasoning ladder', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'claude-opus-5.5',
            object: 'model',
            label: 'Claude Opus 5.5',
            context_length: 1_000_000,
            pricing: {
              input_usd_per_1m: 4,
              output_usd_per_1m: 20,
              cache_read_usd_per_1m: 0.2,
              cache_write_usd_per_1m: 5,
            },
            reasoning: {
              efforts: ['low', 'medium', 'high', 'xhigh'],
              default_effort: 'medium',
              can_disable: false,
            },
            tool_call: true,
            function_call: true,
          },
        ],
      })) as typeof fetch;

    const provider = new TokenHarborProvider(config());
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    expect(model).toMatchObject({
      id: 'claude-opus-5.5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      contextVerified: true,
      costPerMInputTokens: 4,
      costPerMOutputTokens: 20,
      costPerMInputCached: 0.2,
      costPerMOutputCached: 5,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
      functionCall: true,
      creditsLabel: '$4 in / $20 out per 1M',
    });
    expect(resolvePricing('tokenharbor', 'claude-opus-5.5')).toMatchObject({
      inPerM: 4,
      outPerM: 20,
      cacheReadPerM: 0.2,
      cacheWritePerM: 5,
      source: 'provider-rate',
    });
  });

  it('marks a zero-priced free route Free and offers the none level when disable is checked', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'deepseek-v4.1-flash:free',
            object: 'model',
            label: 'DeepSeek V4.1 Flash (Free)',
            context_length: 1_048_576,
            pricing: {
              input_usd_per_1m: 0,
              output_usd_per_1m: 0,
              cache_read_usd_per_1m: 0,
              cache_write_usd_per_1m: 0,
            },
            reasoning: { efforts: ['low', 'high'], default_effort: null, can_disable: true },
            tool_call: true,
          },
        ],
      })) as typeof fetch;

    const provider = new TokenHarborProvider(config());
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    expect(model).toMatchObject({
      id: 'deepseek-v4.1-flash:free',
      contextWindow: 1_048_576,
      costPerMInputTokens: 0,
      costPerMOutputTokens: 0,
      creditsLabel: 'Free',
      canReason: true,
      reasoningLevels: ['none', 'low', 'high'],
    });
  });

  it('leaves an unchecked context null instead of claiming a window', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'claude-sonnet-4.6',
            object: 'model',
            label: 'Claude Sonnet 4.6',
            context_length: null,
            pricing: { input_usd_per_1m: 3, output_usd_per_1m: 15 },
            reasoning: { efforts: null, default_effort: null, can_disable: null },
          },
        ],
      })) as typeof fetch;

    const provider = new TokenHarborProvider(config());
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    expect(model.contextVerified).not.toBe(true);
    expect(model.costPerMInputTokens).toBe(3);
    expect(model.costPerMOutputTokens).toBe(15);
    expect(model.reasoningLevels).toBeUndefined();
  });

  it('leaves the catalog empty on an unauthorized response', async () => {
    globalThis.fetch = (async () => json({ error: 'unauthorized' }, 401)) as typeof fetch;
    const provider = new TokenHarborProvider(config());
    await provider.refreshModels(true);
    expect(provider.listModels()).toEqual([]);
  });
});
