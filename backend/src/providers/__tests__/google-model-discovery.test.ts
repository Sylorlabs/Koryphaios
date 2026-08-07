import { afterEach, describe, expect, it } from 'bun:test';
import { formatGoogleProviderError, GoogleProvider, rejectsTemperatureConfiguration, rejectsThinkingConfiguration } from '../google';
import { __resetModelsDevCacheForTesting } from '../models-dev';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Google AI Studio model discovery', () => {
  it('recognizes only unsupported thinking-configuration errors for compatibility retry', () => {
    expect(rejectsThinkingConfiguration(new Error('Thinking budget is not supported for this model.'))).toBe(true);
    expect(rejectsThinkingConfiguration(new Error('Quota exceeded for metric.'))).toBe(false);
  });

  it('recognizes a provider temperature rejection for compatibility retry', () => {
    expect(rejectsTemperatureConfiguration(new Error('temperature is deprecated for this model'))).toBe(true);
    expect(rejectsTemperatureConfiguration(new Error('Quota exceeded for metric'))).toBe(false);
  });

  it('turns a Gemini quota dump into one actionable provider error', () => {
    const error = formatGoogleProviderError(
      new Error('{"error":{"code":429,"message":"Quota exceeded for metric","status":"RESOURCE_EXHAUSTED"}}'),
      'gemini-3.1-pro-preview',
      'aistudio',
    );
    expect(error).toContain('Google AI Studio has no available quota');
    expect(error).toContain('enable billing');
    expect(error).not.toContain('RESOURCE_EXHAUSTED');
  });

  it('returns an awaitable model refresh for Settings instead of racing a background fetch', async () => {
    // Reset the cache right before the test body — not just in beforeEach —
    // so a parallel test file can't populate the cache between beforeEach
    // and this test's refreshModels() call.
    __resetModelsDevCacheForTesting();
    globalThis.fetch = (async (input) => {
      if (String(input) === 'https://models.dev/api.json') {
        return new Response(
          JSON.stringify({
            google: {
              models: {
                'gemini-3.6-flash': {
                  id: 'gemini-3.6-flash',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 1_000_000,
              outputTokenLimit: 65_536,
              supportedGenerationMethods: ['generateContent'],
              thinking: true,
              supportedThinkingLevels: ['low', 'medium', 'high'],
              temperature: 1,
              maxTemperature: 2,
            },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new GoogleProvider({ name: 'aistudio', apiKey: 'test-key' });
    expect(provider.listModels()).toEqual([]);

    await provider.refreshModels(true);

    const models = provider.listModels();
    expect(models.map((model) => model.apiModelId)).toEqual(['gemini-2.5-pro']);
    expect(models[0]).toMatchObject({
      name: 'Gemini 2.5 Pro',
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      canReason: true,
      reasoningLevels: ['low', 'medium', 'high'],
      temperature: 1,
      maxTemperature: 2,
    });
  });

  it('enriches Gemini 3 with its exact per-model thinking-level list', async () => {
    __resetModelsDevCacheForTesting();
    globalThis.fetch = (async (input) => {
      if (String(input) === 'https://models.dev/api.json') {
        return new Response(
          JSON.stringify({
            google: {
              models: {
                'gemini-3.6-flash': {
                  id: 'gemini-3.6-flash',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          models: [{
            name: 'models/gemini-3.6-flash',
            supportedGenerationMethods: ['generateContent'],
            thinking: true,
          }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new GoogleProvider({ name: 'aistudio', apiKey: 'test-key' });
    await provider.refreshModels(true);

    expect(provider.listModels()[0]?.reasoningLevels).toEqual(['minimal', 'low', 'medium', 'high']);
  });
});
