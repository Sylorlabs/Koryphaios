import { describe, expect, it } from 'bun:test';
import { OpenAIProvider } from '../openai';
import type { ModelDef } from '@koryphaios/shared';
import type { ProviderEvent, StreamRequest } from '../types';

/**
 * Regression coverage for stream-frame handling that only a live provider
 * exposed. Cline attaches `usage` to the SAME chunk that carries
 * `finish_reason` (rather than sending a trailing usage-only chunk) and can
 * repeat `finish_reason` across its final chunk pair. Reading usage only from
 * usage-only chunks silently discarded every token count, and the repeated
 * finish reason completed the turn twice.
 */

/** Minimal 2x1 PNG so image-capable paths are exercised honestly. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Render SSE payloads. Server-Sent Events are separated by a BLANK line, so
 * each payload becomes `data: <json>` followed by `\n\n`.
 */
function sse(payloads: string[]): Response {
  return new Response(payloads.map((p) => `data: ${p}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const realFetch = globalThis.fetch;
let lastBodies: Record<string, unknown>[] = [];

/** Replace global fetch with a canned SSE stream, remembering request bodies. */
function installFetch(lines: string[]): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  lastBodies = bodies;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return sse(lines);
  }) as typeof fetch;
  return bodies;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
  lastBodies = [];
}

const request = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'hi' }],
  systemPrompt: 'system',
  ...overrides,
});

async function collect(
  provider: OpenAIProvider,
  req: StreamRequest,
): Promise<{ events: ProviderEvent[]; bodies: Record<string, unknown>[] }> {
  const bodies = lastBodies;
  const events: ProviderEvent[] = [];
  try {
    for await (const event of provider.streamResponse(req)) events.push(event);
  } finally {
    restoreFetch();
  }
  return { events, bodies };
}

describe('OpenAI stream usage and completion framing', () => {
  const provider = () => new OpenAIProvider({ name: 'openai', apiKey: 'k', disabled: false });

  it('records usage that arrives on the same chunk as finish_reason', async () => {
    // Cline's shape: a finished chunk that also carries usage.
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":90},"completion_tokens_details":{"reasoning_tokens":4}}}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    const usage = events.filter((e) => e.type === 'usage_update');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      tokensIn: 120,
      tokensOut: 7,
      tokensCacheRead: 90,
      thinkingTokens: 4,
    });
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
  });

  it('preserves a provider reported zero charge and rejects invalid charges', async () => {
    for (const cost of [0, 0.125, -1, '0.1']) {
      installFetch([
        JSON.stringify({
          id: 'cost',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost },
        }),
        '[DONE]',
      ]);
      const { events } = await collect(provider(), request());
      expect(events.find((event) => event.type === 'usage_update')?.reportedCostUsd).toBe(
        typeof cost === 'number' && cost >= 0 ? cost : undefined,
      );
    }
  });

  it('completes once when a provider repeats finish_reason on a final chunk pair', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
    // Usage from the repeated chunk is still captured.
    expect(events.filter((e) => e.type === 'usage_update')).toHaveLength(1);
  });

  it('buffers tool arguments until the streamed tool identity is complete', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"path\\\":"}}]},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"\\\"a.ts\\\"}"}}]},"finish_reason":null}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    expect(events.map((event) => event.type)).toEqual([
      'tool_use_start',
      'tool_use_delta',
      'tool_use_stop',
      'complete',
    ]);
    expect(events[0]).toMatchObject({ toolCallId: 'call-1', toolName: 'read_file' });
    // The prefix that arrived before the call was announced is still delivered:
    // the runtime appends deltas, so it must receive the whole buffered payload.
    expect(events[1]).toMatchObject({ toolCallId: 'call-1', toolInput: '{\"path\":\"a.ts\"}' });
    expect(events[2]).toMatchObject({ toolCallId: 'call-1', toolInput: '{\"path\":\"a.ts\"}' });
    expect(events[3]).toMatchObject({ finishReason: 'tool_use' });
  });

  it('assembles arguments when the gateway omits `index` on continuation chunks', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\\"path\\\":"}}]},"finish_reason":null}]}',
      // Same call, no index: this used to open a second id-less buffer and the
      // rest of the arguments were silently dropped.
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\\"a.ts\\\"}"}}]},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    const stop = events.find((event) => event.type === 'tool_use_stop');
    expect(stop).toMatchObject({ toolCallId: 'call-1', toolName: 'read_file' });
    expect(JSON.parse(String(stop?.toolInput))).toEqual({ path: 'a.ts' });
  });

  it('closes a running call when a proxy reuses its index for another id', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_b","function":{"name":"list_files","arguments":"{}"}}]},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    const starts = events.filter((event) => event.type === 'tool_use_start');
    const stops = events.filter((event) => event.type === 'tool_use_stop');
    expect(starts.map((event) => event.toolCallId)).toEqual(['call_a', 'call_b']);
    expect(stops.map((event) => event.toolCallId)).toEqual(['call_a', 'call_b']);
  });

  it('surfaces an error frame sent instead of deltas', async () => {
    installFetch([
      '{"error":{"message":"Error:The request is invalid. Please check the parameters.","type":"invalid_request_error"}}',
      '[DONE]',
    ]);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    const error = events.find((event) => event.type === 'error');
    expect(error?.error).toContain('rejected the request');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('sends a valid JSON object when the upstream truncated the arguments', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\\"path\\\":\\\"a.t"}}]},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    const stop = events.find((event) => event.type === 'tool_use_stop');
    expect(() => JSON.parse(String(stop?.toolInput))).not.toThrow();
  });

  it('discards streamed tool fragments without a complete identity', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"x\\\":1}"}}]},"finish_reason":null}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }

    expect(events.filter((event) => event.type.startsWith('tool_use_'))).toEqual([]);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    expect(events.find((event) => event.type === 'complete')).toMatchObject({
      finishReason: 'tool_use',
    });
  });

  it('still records the standard trailing usage-only chunk', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }
    expect(events.filter((e) => e.type === 'usage_update')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
  });

  it('omits thinkingTokens when the provider reports no reasoning tokens', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }
    const usage = events.find((e) => e.type === 'usage_update') as ProviderEvent | undefined;
    expect(usage).toBeDefined();
    expect(usage!.thinkingTokens).toBeUndefined();
  });

  it('surfaces stream reasoning as thinking_delta (OpenRouter `reasoning` shape)', async () => {
    const frames = [
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"reasoning":"think "},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"reasoning":"more"},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"legacy"},"finish_reason":null}]}',
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
      '[DONE]',
    ];
    installFetch(frames);
    const events: ProviderEvent[] = [];
    try {
      for await (const event of provider().streamResponse(request())) events.push(event);
    } finally {
      restoreFetch();
    }
    const thinking = events
      .filter((e) => e.type === 'thinking_delta')
      .map((e) => e.thinking)
      .join('');
    // `reasoning` and `reasoning_content` both feed the same thinking stream.
    expect(thinking).toBe('think morelegacy');
  });

  it('sends no reasoning parameter when the model reports no reasoning support', async () => {
    installFetch(['[DONE]']);
    const { bodies } = await collect(provider(), request({ reasoningLevel: 'high' }));
    const body = bodies[0] ?? {};
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps PNG attachments intact on the request body', async () => {
    installFetch(['[DONE]']);
    const { bodies } = await collect(
      provider(),
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', imageData: PNG_1x1, imageMimeType: 'image/png' },
            ],
          },
        ],
      }),
    );
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).toContain('image_url');
    expect(serialized).toContain('data:image/png;base64,');
  });

  it.each([
    ['openai', 'synthetic-model', true],
    ['anthropic', 'synthetic-model', false],
    ['openai', 'another-model', false],
  ] as const)(
    'applies image correction only to the authorized route %s/%s',
    async (name, model, allowed) => {
      const selectedProvider = provider();
      selectedProvider.listModels = () => [
        {
          id: 'synthetic-model',
          name: 'Synthetic',
          provider: 'openai',
          contextWindow: 0,
          maxOutputTokens: 0,
          vision: false,
          supportsAttachments: false,
        },
      ];
      installFetch(['[DONE]']);
      const { bodies } = await collect(
        selectedProvider,
        request({
          imageInputOverride: { provider: name, model },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Inspect this' },
                { type: 'image', imageData: PNG_1x1, imageMimeType: 'image/png' },
              ],
            },
          ],
        }),
      );
      expect(JSON.stringify(bodies[0]).includes('data:image/png;base64,')).toBe(allowed);
    },
  );

  it('surfaces a confirmed-image rejection instead of retrying text-only', async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Catalog enrichment may fetch concurrently; count only inference calls.
      if (init?.body && JSON.parse(init.body as string).messages) calls++;
      return Response.json(
        {
          error: {
            message: 'This model does not support image input',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      );
    }) as typeof fetch;
    const { events } = await collect(
      provider(),
      request({
        imageInputOverride: { provider: 'openai', model: 'synthetic-model' },
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', imageData: PNG_1x1, imageMimeType: 'image/png' }],
          },
        ],
      }),
    );
    expect(calls).toBe(1);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});

describe('speed tiers in the request body', () => {
  const provider = () => new OpenAIProvider({ name: 'openai', apiKey: 'k', disabled: false });
  const done = [
    '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    '[DONE]',
  ];

  it('sends service_tier="priority" when speedTier is priority', async () => {
    const bodies = installFetch(done);
    await collect(provider(), request({ speedTier: 'priority' }));
    expect(bodies[0].service_tier).toBe('priority');
    expect(bodies[0].model).toBe('synthetic-model');
  });

  it('sends no service_tier for a non-priority or absent tier', async () => {
    for (const speedTier of ['fast', undefined] as const) {
      const bodies = installFetch(done);
      await collect(provider(), request({ speedTier }));
      expect('service_tier' in bodies[0]).toBe(false);
    }
  });

  it('sends the folded variant slug for a slug-encoded speed tier', async () => {
    const mimo: ModelDef = {
      id: 'mimo-v2.6-pro',
      apiModelId: 'mimo-v2.6-pro',
      name: 'MiMo V2.6 Pro',
      provider: 'openai',
      contextWindow: 0,
      contextVerified: false,
      maxOutputTokens: 0,
      costPerMInputTokens: 0,
      costPerMOutputTokens: 0,
      canReason: false,
      supportsAttachments: false,
      supportsStreaming: true,
      speedTiers: [{ id: 'ultraspeed', label: 'UltraSpeed', description: 'faster' }],
      speedVariants: { ultraspeed: { default: 'mimo-v2.6-pro-ultraspeed' } },
    };
    const instance = provider();
    (instance as unknown as { cachedModels: ModelDef[] }).cachedModels = [mimo];
    const bodies = installFetch(done);
    await collect(instance, request({ model: 'mimo-v2.6-pro', speedTier: 'ultraspeed' }));
    expect(bodies[0].model).toBe('mimo-v2.6-pro-ultraspeed');
    // The variant slug is not an OpenAI service tier.
    expect('service_tier' in bodies[0]).toBe(false);
  });

  it('keeps the base slug when the tier is off', async () => {
    const bodies = installFetch(done);
    await collect(provider(), request({ model: 'synthetic-model' }));
    expect(bodies[0].model).toBe('synthetic-model');
  });
});
