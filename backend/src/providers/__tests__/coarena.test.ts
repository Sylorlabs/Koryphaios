import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { CoarenaProvider } from '../coarena';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): ProviderConfig {
  return {
    name: 'coarena',
    apiKey: 'synthetic-test-key',
    baseUrl: 'https://coarena.ai/api/v1',
    disabled: false,
  } as ProviderConfig;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CoarenaProvider catalog', () => {
  it('uses the published context, output, capabilities and reasoning ladder', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'claude-fable-5',
            object: 'model',
            display_name: 'Claude Fable 5',
            context_length: 128_000,
            max_input_tokens: 128_000,
            max_tokens: 16_384,
            max_completion_tokens: 16_384,
            lifecycle: 'active',
            pricing: { prompt: '0', completion: '0' },
            capabilities: {
              vision: true,
              tools: true,
              json_schema: true,
              reasoning_text: true,
              efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          },
          {
            id: 'retired-model',
            object: 'model',
            display_name: 'Retired Model',
            lifecycle: 'retired',
            context_length: 128_000,
            capabilities: { vision: true, tools: true, reasoning_text: true },
          },
          {
            id: 'retiring-model',
            object: 'model',
            display_name: 'Retiring Model',
            lifecycle: 'active',
            retires_at: '2020-01-01T00:00:00Z',
            context_length: 128_000,
            capabilities: { vision: true, tools: true, reasoning_text: true },
          },
          {
            id: 'deprecated-model',
            object: 'model',
            display_name: 'Deprecated Model',
            lifecycle: 'deprecated',
            context_length: 64_000,
            max_completion_tokens: 8_192,
            pricing: { prompt: '0', completion: '0' },
            capabilities: {
              vision: false,
              tools: false,
              reasoning_text: false,
              efforts: null,
            },
          },
        ],
      })) as typeof fetch;

    const provider = new CoarenaProvider(config());
    await provider.refreshModels(true);
    const models = provider.listModels();

    expect(models.map((model) => model.id)).toEqual(['claude-fable-5', 'deprecated-model']);
    expect(models[0]).toMatchObject({
      name: 'Claude Fable 5',
      contextWindow: 128_000,
      contextVerified: true,
      maxOutputTokens: 16_384,
      vision: true,
      supportsAttachments: true,
      functionCall: true,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(models[1]).toMatchObject({
      name: 'Deprecated Model',
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      vision: false,
      functionCall: false,
      canReason: false,
      deprecated: true,
    });
    expect(models[1].reasoningLevels).toBeUndefined();
  });

  it('does not turn the catalog’s zero pricing into a free per-token rate', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        data: [
          {
            id: 'gpt-6-luna',
            object: 'model',
            display_name: 'GPT-6 Luna',
            context_length: 128_000,
            lifecycle: 'active',
            pricing: { prompt: '0', completion: '0' },
            capabilities: { vision: true, tools: true, reasoning_text: true, efforts: ['high'] },
          },
        ],
      })) as typeof fetch;

    const provider = new CoarenaProvider(config());
    await provider.refreshModels(true);
    const [model] = provider.listModels();

    // Only some Coarena models are free; a zero in every catalog row is not a
    // price. The account's real balance comes from /credits instead.
    expect(model.costPerMInputTokens).toBeUndefined();
    expect(model.costPerMOutputTokens).toBeUndefined();
    expect(model.creditsLabel).toBeUndefined();
  });

  it('leaves the catalog empty on an unauthorized response', async () => {
    globalThis.fetch = (async () => json({ error: 'unauthorized' }, 401)) as typeof fetch;
    const provider = new CoarenaProvider(config());
    await provider.refreshModels(true);
    expect(provider.listModels()).toEqual([]);
  });
});
