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

  it('uses a custom Gemini endpoint and authenticates it without leaking the key into the URL', async () => {
    __resetModelsDevCacheForTesting();
    let catalogUrl = '';
    let apiKeyHeader: string | null = null;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === 'https://models.dev/api.json') {
        return new Response('{}', { status: 200 });
      }
      catalogUrl = String(input);
      apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key');
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/custom-gemini',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const provider = new GoogleProvider({
      name: 'custom:gemini-gateway',
      custom: true,
      kind: 'gemini',
      baseUrl: 'https://gemini-gateway.example/v1beta',
      apiKey: 'private-key',
      disabled: false,
    });
    await provider.refreshModels(true);

    expect(catalogUrl).toBe('https://gemini-gateway.example/v1beta/models');
    expect(catalogUrl).not.toContain('private-key');
    expect(apiKeyHeader).toBe('private-key');
    expect(provider.listModels()[0]).toMatchObject({
      id: 'custom-gemini',
      provider: 'custom:gemini-gateway',
    });
  });

  it('uses the same x-goog API-key auth for a custom Gemini auth token at runtime', async () => {
    __resetModelsDevCacheForTesting();
    let runtimeApiKey: string | null | undefined;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = request?.url ?? String(input);
      if (url === 'https://models.dev/api.json') return new Response('{}', { status: 200 });
      const method = (request?.method ?? init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes(':streamGenerateContent')) {
        runtimeApiKey = new Headers(request?.headers ?? init?.headers).get('x-goog-api-key');
        return new Response(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\r\n\r\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/custom-gemini',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new GoogleProvider({
      name: 'custom:gemini-token-gateway',
      custom: true,
      kind: 'gemini',
      baseUrl: 'https://gemini-gateway.example/v1beta',
      authToken: 'private-token',
      disabled: false,
    });
    const events = [];
    for await (const event of provider.streamResponse({
      model: 'custom-gemini',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      events.push(event);
    }

    expect(runtimeApiKey).toBe('private-token');
    expect(events).toContainEqual({ type: 'content_delta', content: 'ok' });
  });
});
