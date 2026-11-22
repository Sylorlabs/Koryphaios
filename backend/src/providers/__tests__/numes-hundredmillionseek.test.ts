import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { HundredMillionSeekProvider } from '../hundredmillionseek';
import { NumesProvider } from '../numes';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(name: 'numes' | 'hundredmillionseek'): ProviderConfig {
  return {
    name,
    apiKey: 'synthetic-test-key',
    baseUrl:
      name === 'numes' ? 'https://api.numes.ai/api/v1' : 'https://100milionseek.top/v1',
    disabled: false,
  } as ProviderConfig;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HundredMillionSeekProvider catalog', () => {
  it('ingests reported limits, the vendor price label and quota multiplier', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'deepseek-v4.1-flash-free',
            object: 'model',
            context_length: 198_000,
            max_output_tokens: 65_536,
            quota_multiplier: 1,
            price_label: '1x price',
          },
        ],
      })) as typeof fetch;

    const provider = new HundredMillionSeekProvider(config('hundredmillionseek'));
    await provider.refreshModels(true);
    const models = provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'deepseek-v4.1-flash-free',
      contextWindow: 198_000,
      contextVerified: true,
      maxOutputTokens: 65_536,
      creditsLabel: '1x price',
      quotaMultiplier: 1,
    });
    // The catalog publishes no USD rate; never invent one. Generic model rows
    // carry the shared zero default, not a provider-attributed price.
    expect(models[0].costPerMInputTokens).toBe(0);
    expect(models[0].costPerMOutputTokens).toBe(0);
  });

  it('does not offer a model served on a non-chat endpoint', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'jev-1.13-free',
            name: 'JEV',
            endpoint: '/v1/systemone',
            quota_multiplier: 0.2,
            price_label: 'JEV: 1/5 price',
          },
          { id: 'deepseek-v4.1-flash-free', context_length: 198_000 },
        ],
      })) as typeof fetch;

    const provider = new HundredMillionSeekProvider(config('hundredmillionseek'));
    await provider.refreshModels(true);
    expect(provider.listModels().map((model) => model.id)).toEqual([
      'deepseek-v4.1-flash-free',
    ]);
  });

  it('leaves the catalog empty on an unreachable endpoint instead of guessing', async () => {
    globalThis.fetch = (async () => json({ error: 'unauthorized' }, 401)) as typeof fetch;
    const provider = new HundredMillionSeekProvider(config('hundredmillionseek'));
    await provider.refreshModels(true);
    expect(provider.listModels()).toEqual([]);
  });
});

describe('NumesProvider catalog', () => {
  it('maps live pricing, limits, modalities and reasoning efforts into the model', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'anthropic/claude-fable-5.1',
            name: 'Claude Fable 5.1',
            context_length: 1_000_000,
            maximum_output_length: 128_000,
            pricing: {
              prompt: '0.00001',
              completion: '0.00005',
              input_cache_read: '0.00000025',
            },
            reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
            supported_parameters: ['tools', 'reasoning', 'max_tokens'],
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
          },
        ],
      })) as typeof fetch;

    const provider = new NumesProvider(config('numes'));
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    expect(model).toMatchObject({
      id: 'anthropic/claude-fable-5.1',
      name: 'Claude Fable 5.1',
      contextWindow: 1_000_000,
      contextVerified: true,
      maxOutputTokens: 128_000,
      costPerMInputTokens: 10,
      costPerMOutputTokens: 50,
      costPerMInputCached: 0.25,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      vision: true,
      supportsAttachments: true,
      functionCall: true,
      creditsLabel: '$10 in / $50 out per 1M',
      outputModalities: ['text'],
    });
  });

  it('does not claim pricing or vision the catalog omits', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [{ id: 'vendor/plain-model', context_length: 32_000 }],
      })) as typeof fetch;

    const provider = new NumesProvider(config('numes'));
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    expect(model.contextWindow).toBe(32_000);
    expect(model.contextVerified).toBe(true);
    expect(model.vision).toBeUndefined();
    expect(model.canReason).toBe(false);
    expect(model.creditsLabel).toBeUndefined();
  });
});
