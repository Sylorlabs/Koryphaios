import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { CrowLLMProvider } from '../crowllm';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): ProviderConfig {
  return {
    name: 'crowllm',
    apiKey: 'synthetic-test-key',
    baseUrl: 'https://crowllm.com/v1',
    disabled: false,
  } as ProviderConfig;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CrowLLMProvider catalog', () => {
  it('uses the public ids, free suffix and thinking variants without inventing limits', async () => {
    globalThis.fetch = (async () =>
      json({
        object: 'list',
        success: true,
        data: [
          {
            id: 'gpt-5.6-luna',
            object: 'model',
            owned_by: 'OpenAI',
            supported_endpoint_types: ['openai'],
          },
          {
            id: 'claude-opus-4-8-thinking',
            object: 'model',
            owned_by: 'Anthropic',
            supported_endpoint_types: ['openai'],
          },
          {
            id: 'gpt-5.6-sol:free',
            object: 'model',
            owned_by: 'OpenAI',
            supported_endpoint_types: ['openai'],
          },
          {
            id: 'deepseek-v4-pro',
            object: 'model',
            owned_by: 'DeepSeek',
            supported_endpoint_types: ['anthropic'],
          },
        ],
      })) as typeof fetch;

    const provider = new CrowLLMProvider(config());
    await provider.refreshModels(true);
    const models = provider.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'gpt-5.6-luna',
      'claude-opus-4-8-thinking',
      'gpt-5.6-sol:free',
    ]);

    expect(models[0]).toMatchObject({
      name: 'gpt-5.6-luna',
      canReason: false,
    });
    expect(models[0].costPerMInputTokens).toBeUndefined();
    expect(models[0].costPerMOutputTokens).toBeUndefined();
    // The catalog does not publish context or output limits for this row.
    expect(models[0].contextVerified).not.toBe(true);
    expect(models[0].reasoningLevels).toBeUndefined();

    expect(models[1]).toMatchObject({
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high'],
    });

    expect(models[2]).toMatchObject({
      costPerMInputTokens: 0,
      costPerMOutputTokens: 0,
      creditsLabel: 'Free',
    });
  });

  it('leaves the catalog empty on an unauthorized response', async () => {
    globalThis.fetch = (async () => json({ error: 'unauthorized' }, 401)) as typeof fetch;
    const provider = new CrowLLMProvider(config());
    await provider.refreshModels(true);
    expect(provider.listModels()).toEqual([]);
  });
});
