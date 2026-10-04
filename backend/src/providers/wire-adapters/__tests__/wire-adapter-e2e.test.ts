import { afterEach, describe, expect, test } from 'bun:test';
import { probeCustomProvider } from '../../custom';
import { getWireAdapter, listWireAdapters } from '../registry';
import { ollamaAdapter } from '../ollama';
import { cohereAdapter } from '../cohere';
import { CustomProvider } from '../../custom';
import { WireAdapterProvider } from '../wire-adapter-provider';
import type { ProviderEvent } from '../../types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route mock fetch by exact URL to a canned response (default 404). */
function mockFetchByUrl(
  routes: Record<string, Response | ((url: string, init?: RequestInit) => Response)>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (typeof route === 'function') return route(url, init);
    if (route) return route;
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

function jsonlResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('wire adapter registry', () => {
  test('resolves known ids and rejects unknown ones', () => {
    expect(getWireAdapter('ollama')?.id).toBe('ollama');
    expect(getWireAdapter('cohere')?.id).toBe('cohere');
    expect(getWireAdapter('nope')).toBeUndefined();
    expect(listWireAdapters().length).toBeGreaterThanOrEqual(2);
  });

  test.each([ollamaAdapter, cohereAdapter])(
    'sends confirmed images through the custom $id provider',
    async (adapter) => {
      const name = `custom:${adapter.id}-vision`;
      let submitted: Record<string, unknown> | undefined;
      const path = adapter.id === 'ollama' ? '/api/chat' : '/v2/chat';
      mockFetchByUrl({
        [`http://image-fixture.test${path}`]: (_url, init) => {
          submitted = JSON.parse(init?.body as string);
          return adapter.id === 'ollama'
            ? jsonlResponse([{ message: { content: 'Image seen' }, done: true }])
            : sseResponse([
                { type: 'content-delta', delta: { message: { content: { text: 'Image seen' } } } },
              ]);
        },
      });
      const provider = new CustomProvider({
        name,
        custom: true,
        adapter: adapter.id,
        baseUrl: 'http://image-fixture.test',
        disabled: false,
      });
      const events: ProviderEvent[] = [];
      for await (const event of provider.streamResponse({
        model: 'vision-fixture',
        systemPrompt: '',
        imageInputOverride: { provider: name, model: 'vision-fixture' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect' },
              { type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' },
            ],
          },
        ],
      }))
        events.push(event);
      expect(provider.imageInputTransport).toBe('native');
      expect(JSON.stringify(submitted)).toContain('cGl4ZWxz');
      expect(events.some((event) => event.content === 'Image seen')).toBe(true);
      expect(events.some((event) => event.type === 'error')).toBe(false);
    },
  );
});

describe('ollama adapter end to end', () => {
  test('auto-detects an Ollama endpoint from /api/tags through the probe', async () => {
    mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': jsonResponse({
        models: [
          {
            name: 'llama3:latest',
            model: 'llama3:latest',
            size: 4_000_000,
            digest: 'aa11bb22',
            details: { family: 'llama', format: 'gguf' },
          },
          { name: 'qwen2:7b', digest: 'cc33dd44', details: { family: 'qwen2' } },
        ],
      }),
    });

    const probe = await probeCustomProvider({ baseUrl: 'http://127.0.0.1:11434' });
    expect(probe.success).toBe(true);
    expect(probe.detectedAdapter).toBe('ollama');
    expect(probe.detectedKind).toBe('openai');
    expect(probe.models).toEqual(['llama3:latest', 'qwen2:7b']);
  });

  test('an explicit adapter pin overrides SDK classification', async () => {
    mockFetchByUrl({
      'http://proxy.example/models': jsonResponse({
        object: 'list',
        data: [{ id: 'some-model' }],
      }),
    });

    const probe = await probeCustomProvider({
      baseUrl: 'http://proxy.example',
      adapter: 'ollama',
    });
    expect(probe.detectedAdapter).toBe('ollama');
  });

  test('an unknown adapter id is ignored by the probe', async () => {
    mockFetchByUrl({});
    const probe = await probeCustomProvider({
      baseUrl: 'http://nowhere.example',
      adapter: 'not-real',
    });
    expect(probe.detectedAdapter).toBeUndefined();
  });

  test('WireAdapterProvider streams canonical events from a JSONL body', async () => {
    mockFetchByUrl({
      'http://127.0.0.1:11434/api/chat': jsonlResponse([
        { message: { role: 'assistant', content: 'Checking ' } },
        { message: { role: 'assistant', content: 'the weather.' } },
        {
          message: {
            role: 'assistant',
            tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }],
          },
        },
        {
          message: {},
          done: true,
          prompt_eval_count: 15,
          eval_count: 8,
          done_reason: 'tool_calls',
        },
      ]),
    });

    const provider = new WireAdapterProvider(
      {
        name: 'custom:ollama-test',
        baseUrl: 'http://127.0.0.1:11434',
      } as never,
      ollamaAdapter,
    );

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'llama3:latest',
      messages: [{ role: 'user', content: 'weather?' }],
      systemPrompt: '',
    })) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === 'content_delta').map((event) => event.content),
    ).toEqual(['Checking ', 'the weather.']);
    const start = events.find((event) => event.type === 'tool_use_start');
    expect(start).toMatchObject({ toolCallId: 'call_0', toolName: 'get_weather' });
    const stop = events.find((event) => event.type === 'tool_use_stop');
    expect(stop).toMatchObject({
      toolCallId: 'call_0',
      toolName: 'get_weather',
      toolInput: JSON.stringify({ city: 'Oslo' }),
    });
    const usage = events.find((event) => event.type === 'usage_update');
    expect(usage).toMatchObject({ tokensIn: 15, tokensOut: 8 });
    const complete = events.find((event) => event.type === 'complete');
    expect(complete).toMatchObject({ finishReason: 'tool_use' });
  });

  test('WireAdapterProvider frames SSE bodies for sse adapters', async () => {
    const { cohereAdapter } = await import('../cohere');
    mockFetchByUrl({
      'https://api.cohere.example/v2/chat': sseResponse([
        { type: 'content-delta', delta: { message: { content: { text: 'Hello' } } } },
        {
          type: 'message-end',
          usage: { billed_units: { input_tokens: 3, output_tokens: 1 } },
          finish_reason: 'COMPLETE',
        },
      ]),
    });

    const provider = new WireAdapterProvider(
      { name: 'custom:cohere-test', baseUrl: 'https://api.cohere.example' } as never,
      cohereAdapter,
    );

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'command-r',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: '',
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: 'content_delta', content: 'Hello' });
    expect(events[1]).toMatchObject({ type: 'usage_update', tokensIn: 3, tokensOut: 1 });
    expect(events[2]).toMatchObject({ type: 'complete', finishReason: 'end_turn' });
  });
});
