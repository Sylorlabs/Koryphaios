import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CustomProvider } from '../custom';
import { promptCacheDiagnostics } from '../cache-fabric';
import { createPromptCachePlan } from '../prompt-cache';
import type { ProviderEvent, StreamRequest } from '../types';

const realFetch = globalThis.fetch;

function streamingResponse(cachedTokens: number): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { content: 'ok' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 5_000,
        completion_tokens: 1,
        total_tokens: 5_001,
        prompt_tokens_details: {
          cached_tokens: cachedTokens,
          cache_write_tokens: 0,
        },
      },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function drain(provider: CustomProvider, request: StreamRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse(request)) events.push(event);
  return events;
}

describe('custom OpenAI-compatible prompt-cache diagnostics', () => {
  beforeEach(() => promptCacheDiagnostics.clear());
  afterEach(() => {
    globalThis.fetch = realFetch;
    promptCacheDiagnostics.clear();
  });

  test('tracks warm provider outcomes without sending provider-specific cache controls', async () => {
    const chatBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.url.endsWith('/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gateway-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (request.url.endsWith('/chat/completions')) {
        chatBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
        return streamingResponse(4_096);
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const provider = new CustomProvider({
      name: 'custom:gateway',
      custom: true,
      kind: 'openai',
      label: 'Gateway',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'test-key',
      disabled: false,
      models: ['gateway-model'],
    });
    const stableSystemPrompt = `Stable cache prefix. ${'policy '.repeat(3_000)}`;
    const promptCache = createPromptCachePlan({
      stableSystemPrompt,
      providerAdapter: provider.name,
      role: 'manager',
      workspaceScope: '/workspace',
    });
    const request: StreamRequest = {
      model: 'gateway-model',
      systemPrompt: stableSystemPrompt,
      messages: [{ role: 'user', content: 'reply ok' }],
      sessionId: 'session-a',
      harnessRole: 'manager',
      cacheLaneKind: 'manager',
      promptCache,
      promptCacheKeepaliveMode: 'off',
      maxTokens: 8,
    };

    await drain(provider, request);
    const second = await drain(provider, request);
    const secondUsage = second.find((event) => event.type === 'usage_update');

    expect(secondUsage?.cacheExpectedWarm).toBe(true);
    expect(secondUsage?.cacheUnexpectedMiss).toBe(false);
    expect(secondUsage?.cacheLaneKind).toBe('manager');
    expect(promptCacheDiagnostics.getStats().providerWarmHits).toBe(1);
    expect(chatBodies).toHaveLength(2);
    for (const body of chatBodies) {
      expect(body.prompt_cache_key).toBeUndefined();
      expect(body.prompt_cache_options).toBeUndefined();
      expect(body.session_id).toBeUndefined();
    }
  });
});
