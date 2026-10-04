import { describe, expect, it } from 'bun:test';
import { OpenAIProvider } from '../openai';
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
