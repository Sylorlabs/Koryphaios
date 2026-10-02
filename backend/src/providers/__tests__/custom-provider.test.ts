// Custom (bring-your-own) provider tests — a user adds an OpenAI-compatible endpoint with
// just a base URL (+ optional key/models), no built-in support. Verified with a mocked
// transport (no real endpoint needed).

import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

// Custom provider tests involve network mocking and provider instantiation
// that can be slow under parallel test load.
setDefaultTimeout(30000);
import { ProviderRegistry } from '../registry';
import type { ProviderEvent } from '../types';

const realFetch = globalThis.fetch;

function mockFetch(input: any): Promise<Response> {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  if (url.includes('/chat/completions')) {
    return Promise.resolve(
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'CUSTOM_OK' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  }
  if (url.includes('/models')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'live-model-from-endpoint' },
            {
              id: 'route-truth-model',
              display_name: 'Route Truth Model',
              context_window: 64000,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
  }
  return Promise.resolve(new Response('{}', { status: 200 }));
}

describe('Custom (bring-your-own) provider', () => {
  let registry: ProviderRegistry;

  beforeAll(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    registry = new ProviderRegistry();
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('registers an OpenAI-compatible custom provider with base URL + optional key', () => {
    const res = registry.registerCustomProvider({
      id: 'custom:my-llm',
      label: 'My LLM',
      kind: 'openai',
      baseUrl: 'https://my-endpoint.example/v1',
      apiKey: 'sk-test',
      models: ['my-model-a', 'my-model-b'],
      catalogDetected: true,
    });
    expect(res.success).toBe(true);
    const provider = registry.get('custom:my-llm');
    expect(provider).toBeDefined();
    expect(provider?.isAvailable()).toBe(true);
  });

  it('surfaces the custom provider in getStatus with the right form fields', () => {
    const status = registry.getStatus().find((p) => p.name === 'custom:my-llm');
    expect(status, 'custom provider missing from status').toBeDefined();
    expect(status!.custom).toBe(true);
    expect(status!.label).toBe('My LLM');
    expect(status!.supportsApiKey).toBe(true); // shows an API-key box
    expect(status!.requiresBaseUrl).toBe(true); // shows a base-URL box
    expect(status!.enabled).toBe(true);
    expect(status!.connectionState).toBe('detected');
    expect(status!.verificationScope).toBe('catalog');
    expect(status!.authenticated).toBe(false);
  });

  it('lists declared models merged with live /models discovery', () => {
    const provider = registry.get('custom:my-llm')!;
    const ids = provider.listModels().map((m) => m.id);
    // declared models present...
    expect(ids).toContain('my-model-a');
    expect(ids).toContain('my-model-b');
  });

  it('prefers live route metadata over declared generic placeholders', async () => {
    const res = registry.registerCustomProvider({
      id: 'custom:route-truth',
      label: 'Route Truth',
      kind: 'openai',
      baseUrl: 'https://route-truth.example/v1',
      apiKey: 'sk-test',
      // Same id the live catalog reports WITH verified metadata: the live
      // entry must win so sessions compact against the route's real window
      // instead of dying on its limit. declared-only stays generic.
      models: ['route-truth-model', 'declared-only-model'],
      catalogDetected: true,
    });
    expect(res.success).toBe(true);
    const provider = registry.get('custom:route-truth')!;
    await provider.refreshModels(true);
    const byId = new Map(provider.listModels().map((m) => [m.id, m]));
    expect(byId.get('route-truth-model')).toMatchObject({
      name: 'Route Truth Model',
      contextWindow: 64000,
      contextVerified: true,
    });
    expect(byId.get('declared-only-model')).toMatchObject({ contextWindow: 0 });
  });

  it('works without an API key (keyless OpenAI-compatible endpoint)', () => {
    const res = registry.registerCustomProvider({
      id: 'custom:keyless',
      label: 'Keyless Local',
      kind: 'openai',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(res.success).toBe(true);
    expect(registry.get('custom:keyless')?.isAvailable()).toBe(true);
  });

  it('preserves custom metadata and icon ownership when credentials change', async () => {
    const icon = {
      assetId: '123e4567-e89b-42d3-a456-426614174000',
      revision: 'a'.repeat(64),
      shape: 'circle' as const,
    };
    expect(registry.setCustomProviderIcon('custom:my-llm', icon).success).toBe(true);

    const result = await registry.setCredentials('custom:my-llm', { apiKey: 'sk-replacement' });
    expect(result.success).toBe(true);
    expect(registry.getConfigs()['custom:my-llm']).toMatchObject({
      custom: true,
      kind: 'openai',
      label: 'My LLM',
      models: ['my-model-a', 'my-model-b'],
      customIcon: icon,
      apiKey: 'sk-replacement',
    });
  });

  it('rejects a custom provider with no base URL', () => {
    const res = registry.registerCustomProvider({
      id: 'custom:bad',
      label: 'Bad',
      baseUrl: '',
    });
    expect(res.success).toBe(false);
  });

  it('routes a model id to the custom provider and streams through its endpoint', async () => {
    const provider = registry.resolveProvider('my-model-a', 'custom:my-llm');
    expect(provider?.name).toBe('custom:my-llm');

    const events: ProviderEvent[] = [];
    for await (const e of registry.get('custom:my-llm')!.streamResponse({
      model: 'my-model-a',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(e);
    }
    const text = events
      .filter((e) => e.type === 'content_delta')
      .map((e) => e.content)
      .join('');
    expect(text).toContain('CUSTOM_OK');
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('removes a custom provider', () => {
    registry.removeCustomProvider('custom:keyless');
    expect(registry.get('custom:keyless')).toBeUndefined();
    expect(registry.getStatus().find((p) => p.name === 'custom:keyless')).toBeUndefined();
  });

  it('enriches custom models with models.dev reasoning levels', async () => {
    const { __resetModelsDevCacheForTesting, warmModelsDevCache } = await import('../models-dev');
    __resetModelsDevCacheForTesting();
    const withCatalog = (async (input: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url === 'https://models.dev/api.json') {
        return new Response(
          JSON.stringify({
            openai: {
              models: {
                'test-reasoning-model': {
                  id: 'test-reasoning-model',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
                  limit: { context: 200000, output: 32000 },
                  modalities: { input: ['text', 'image'], output: ['text'] },
                },
                // Toggle + effort tiers that already include 'none' — the
                // prepended off-level must not duplicate the reported one.
                'test-toggle-none-model': {
                  id: 'test-toggle-none-model',
                  reasoning: true,
                  reasoning_options: [
                    { type: 'toggle' },
                    { type: 'effort', values: ['none', 'high'] },
                  ],
                },
                'test-toggle-only-model': {
                  id: 'test-toggle-only-model',
                  reasoning: true,
                  reasoning_options: [{ type: 'toggle' }],
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return mockFetch(input);
    }) as unknown as typeof fetch;
    globalThis.fetch = withCatalog;
    try {
      await warmModelsDevCache();
      expect(
        registry.registerCustomProvider({
          id: 'custom:enriched',
          label: 'Enriched',
          kind: 'openai',
          baseUrl: 'https://enriched.example/v1',
          models: [
            'test-reasoning-model',
            'test-plain-model',
            'test-toggle-none-model',
            'test-toggle-only-model',
          ],
          catalogDetected: true,
        }).success,
      ).toBe(true);
      const defs = registry.get('custom:enriched')!.listModels();
      const reasoned = defs.find((m) => m.id === 'test-reasoning-model')!;
      expect(reasoned.canReason).toBe(true);
      expect(reasoned.reasoningLevels).toEqual(['low', 'medium', 'high']);
      expect(reasoned.contextWindow).toBe(200000);
      expect(reasoned.supportsAttachments).toBe(true);
      expect(reasoned.vision).toBe(true);
      // Toggle + effort tiers already carrying 'none': exactly one off-level,
      // in its reported position — no duplicate from the prepend.
      const toggleNone = defs.find((m) => m.id === 'test-toggle-none-model')!;
      expect(toggleNone.canReason).toBe(true);
      expect(toggleNone.reasoningLevels).toEqual(['none', 'high']);
      // Pure on/off thinking keeps the none/high pair.
      const toggleOnly = defs.find((m) => m.id === 'test-toggle-only-model')!;
      expect(toggleOnly.canReason).toBe(true);
      expect(toggleOnly.reasoningLevels).toEqual(['none', 'high']);
      // Unknown ids stay generic — enrichment never invents capabilities.
      const plain = defs.find((m) => m.id === 'test-plain-model')!;
      expect(plain.canReason).toBe(false);
      expect(plain.reasoningLevels).toBeUndefined();
      expect(plain.supportsAttachments).toBeFalsy();
      expect(plain.vision).toBeFalsy();
    } finally {
      globalThis.fetch = mockFetch as unknown as typeof fetch;
    }
  });
});
