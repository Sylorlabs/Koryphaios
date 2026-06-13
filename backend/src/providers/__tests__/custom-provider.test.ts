// Custom (bring-your-own) provider tests — a user adds an OpenAI-compatible endpoint with
// just a base URL (+ optional key/models), no built-in support. Verified with a mocked
// transport (no real endpoint needed).

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ProviderRegistry } from '../registry';
import type { ProviderEvent } from '../types';

const realFetch = globalThis.fetch;

function mockFetch(input: any): Promise<Response> {
  const url = typeof input === 'string' ? input : input?.url ?? '';
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
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'live-model-from-endpoint' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
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
  });

  it('lists declared models merged with live /models discovery', () => {
    const provider = registry.get('custom:my-llm')!;
    const ids = provider.listModels().map((m) => m.id);
    // declared models present...
    expect(ids).toContain('my-model-a');
    expect(ids).toContain('my-model-b');
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
    const text = events.filter((e) => e.type === 'content_delta').map((e) => e.content).join('');
    expect(text).toContain('CUSTOM_OK');
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('removes a custom provider', () => {
    registry.removeCustomProvider('custom:keyless');
    expect(registry.get('custom:keyless')).toBeUndefined();
    expect(registry.getStatus().find((p) => p.name === 'custom:keyless')).toBeUndefined();
  });
});
