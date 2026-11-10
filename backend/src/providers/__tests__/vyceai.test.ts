import { afterEach, describe, expect, it } from 'bun:test';
import type { ProviderConfig } from '@koryphaios/shared';
import { VyceAIProvider } from '../openai';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config(): ProviderConfig {
  return {
    name: 'vyceai',
    apiKey: 'sk-vyce-synthetic',
    baseUrl: 'https://vyceai.com/v1',
    disabled: false,
  };
}

function sse(chunks: unknown[]): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('Vyce AI provider contract', () => {
  it('uses Vyce /v1/models metadata for context and reasoning controls', async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'claude-sonnet-4-6',
              display_name: 'Claude Sonnet 4.6',
              context_window: '270K',
              max_output_tokens: 64_000,
              supports_reasoning: true,
              supported_reasoning_efforts: ['low', 'medium', 'high'],
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new VyceAIProvider(config());
    await provider.refreshModels(true);

    const modelsRequest = requests.find((candidate) => candidate.url.endsWith('/v1/models'));
    expect(modelsRequest?.url).toBe('https://vyceai.com/v1/models');
    expect(modelsRequest?.headers.get('authorization')).toBe('Bearer sk-vyce-synthetic');
    expect(provider.listModels()).toMatchObject([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 270_000,
        contextVerified: true,
        maxOutputTokens: 64_000,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
    ]);
  });

  it('fills context window and reasoning from the upstream lab when Vyce publishes bare ids', async () => {
    const { __resetModelsDevCacheForTesting, warmModelsDevCache } = await import('../models-dev');
    __resetModelsDevCacheForTesting();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://models.dev/api.json') {
        return new Response(
          JSON.stringify({
            openai: {
              models: {
                'gpt-5.5': {
                  id: 'gpt-5.5',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
                  limit: { context: 400_000, output: 128_000 },
                },
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      // Vyce's authenticated catalog: bare ids, no limits, no effort ladder.
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-5.5', object: 'model', owned_by: 'vyce' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await warmModelsDevCache();
    const provider = new VyceAIProvider(config());
    await provider.refreshModels(true);

    expect(provider.listModels()).toMatchObject([
      {
        id: 'gpt-5.5',
        contextWindow: 400_000,
        contextVerified: true,
        canReason: true,
        reasoningLevels: ['low', 'medium', 'high'],
      },
    ]);
  });

  it('keeps the full conversation, tools, selected reasoning effort, and Bearer auth', async () => {
    let body: Record<string, unknown> | undefined;
    let request: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      if (request.url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'deepseek-v4.1',
                context_window: 270_000,
                reasoning: true,
                reasoning_levels: ['low', 'medium', 'high'],
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      body = JSON.parse(await request.text()) as Record<string, unknown>;
      return sse([
        { choices: [{ delta: { reasoning_content: 'thinking' } }] },
        { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;

    const provider = new VyceAIProvider(config());
    await provider.refreshModels(true);
    const events = [];
    for await (const event of provider.streamResponse({
      model: 'deepseek-v4.1',
      systemPrompt: 'Be precise.',
      messages: [
        { role: 'user', content: 'Earlier context' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Continue with the tool result.' },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look something up',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      reasoningLevel: 'high',
    })) {
      events.push(event);
    }

    expect(request?.url).toBe('https://vyceai.com/v1/chat/completions');
    expect(request?.headers.get('authorization')).toBe('Bearer sk-vyce-synthetic');
    expect(body).toMatchObject({
      model: 'deepseek-v4.1',
      stream: true,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Earlier context' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Continue with the tool result.' },
      ],
    });
    expect(body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look something up',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'thinking_delta', thinking: 'thinking' },
      { type: 'content_delta', content: 'answer' },
      { type: 'complete', finishReason: 'stop' },
    ]);
  });

  it('does not erase trusted metadata when a later catalog refresh fails', async () => {
    let modelsCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith('/models')) return new Response('{}');
      modelsCalls += 1;
      if (modelsCalls > 1) throw new Error('temporary Vyce catalog outage');
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'gpt-5.6-new',
              context_window: 270_000,
              supported_reasoning_efforts: ['low', 'high'],
              reasoning: true,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const provider = new VyceAIProvider(config());
    await provider.refreshModels(true);
    const before = provider.listModels();
    await provider.refreshModels(true);

    expect(provider.listModels()).toEqual(before);
    expect(provider.listModels()[0]).toMatchObject({
      contextWindow: 270_000,
      contextVerified: true,
      canReason: true,
      reasoningLevels: ['low', 'high'],
    });
  });
});
