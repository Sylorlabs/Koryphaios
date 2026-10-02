/** Closed-transport Chatbase v2 contract tests; no account/live compatibility claim.
 * Sources: https://www.chatbase.co/docs/api-v2/streaming
 *          https://www.chatbase.co/docs/api-v2/error-handling
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CHATBASE_BASE_URL, ChatbaseProvider } from '../chatbase';
import type { ProviderEvent, StreamRequest } from '../types';

const KEY = 'synthetic-chatbase-key';
const AGENT = 'synthetic/agent';
const CHAT_URL = `${CHATBASE_BASE_URL}/agents/${encodeURIComponent(AGENT)}/chat`;
const request: StreamRequest = {
  model: AGENT,
  systemPrompt: '',
  messages: [{ role: 'user', content: 'Hello' }],
  sessionId: 'foreign-kory-session',
};

function stream(events: object[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') +
      'data: [DONE]\r\n\r\n',
  );
  // Deliberately split UTF-8 characters and SSE lines across transport chunks.
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function finish(conversationId = 'issued-conversation'): object {
  return {
    type: 'finish',
    finishReason: 'stop',
    messageMetadata: { conversationId, userId: null, usage: { credits: 7 } },
  };
}

async function collect(provider: ChatbaseProvider, input = request): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse(input)) events.push(event);
  return events;
}

describe('Chatbase dedicated v2 conformance', () => {
  let originalFetch: typeof fetch;
  let provider: ChatbaseProvider;
  let bodies: Record<string, unknown>[];
  let respond: () => Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    bodies = [];
    provider = new ChatbaseProvider({ name: 'chatbase', apiKey: KEY, disabled: false });
    respond = () => {
      throw new Error('No synthetic response configured');
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe(CHAT_URL);
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(headers.get('content-type')).toBe('application/json');
      bodies.push(JSON.parse(String(init?.body)));
      return respond();
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses fragmented UIMessage text and reuses only the server-issued conversation ID', async () => {
    respond = () =>
      stream([
        { type: 'start', messageId: 'synthetic-message' },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Hello 🌍' },
        { type: 'text-end', id: 'text-1' },
        finish(),
      ]);
    const events = await collect(provider);
    expect(events).toEqual([
      { type: 'content_delta', content: 'Hello 🌍' },
      { type: 'complete', finishReason: 'stop' },
    ]);
    expect(bodies).toEqual([{ message: 'Hello', stream: true }]);
    await collect(provider);
    expect(bodies[1]).toEqual({
      message: 'Hello',
      stream: true,
      conversationId: 'issued-conversation',
    });
    await collect(provider, { ...request, sessionId: 'another-session' });
    expect(bodies[2]).toEqual({ message: 'Hello', stream: true });
  });

  it.each([
    [400, 'VALIDATION_INVALID_BODY'],
    [401, 'AUTH_INVALID_API_KEY'],
    [402, 'CHAT_CREDITS_EXHAUSTED'],
    [403, 'AUTH_INSUFFICIENT_PERMISSIONS'],
    [404, 'RESOURCE_NOT_FOUND'],
    [429, 'RATE_LIMIT_TOO_MANY_REQUESTS'],
    [500, 'INTERNAL_SERVER_ERROR'],
  ] as const)(
    'surfaces HTTP %s structured error %s without successful completion',
    async (status, code) => {
      respond = () =>
        new Response(JSON.stringify({ error: { code, message: 'Synthetic rejection' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      const events = await collect(provider);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].error).toContain(`Chatbase HTTP ${status}`);
      expect(events[0].error).toContain(code);
      expect(events[0].error).toContain('Synthetic rejection');
      expect(bodies).toHaveLength(1);
    },
  );

  it('retries a structured conversation mismatch once, omitting the rejected ID', async () => {
    respond = () => stream([{ type: 'text-delta', delta: 'Initial answer' }, finish()]);
    expect((await collect(provider)).at(-1)).toEqual({ type: 'complete', finishReason: 'stop' });
    let attempts = 0;
    respond = () =>
      ++attempts === 1
        ? new Response(
            JSON.stringify({
              error: { code: 'CHAT_CONVERSATION_MISMATCH', message: 'Wrong agent' },
            }),
            { status: 403 },
          )
        : stream([
            { type: 'text-delta', id: 'text-1', delta: 'Recovered' },
            finish('replacement-conversation'),
          ]);
    const events = await collect(provider);
    expect(attempts).toBe(2);
    expect(bodies[1].conversationId).toBe('issued-conversation');
    expect(bodies[2]).toEqual({ message: 'Hello', stream: true });
    expect(events).toEqual([
      { type: 'content_delta', content: 'Recovered' },
      { type: 'complete', finishReason: 'stop' },
    ]);
    await collect(provider);
    expect(bodies[3].conversationId).toBe('replacement-conversation');
  });

  it('does not retry an unrelated permission error on an existing conversation', async () => {
    respond = () => stream([{ type: 'text-delta', delta: 'Initial answer' }, finish()]);
    expect((await collect(provider)).at(-1)).toEqual({ type: 'complete', finishReason: 'stop' });
    respond = () =>
      new Response(
        JSON.stringify({ error: { code: 'AUTH_INSUFFICIENT_PERMISSIONS', message: 'Denied' } }),
        { status: 403 },
      );
    const events = await collect(provider);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('AUTH_INSUFFICIENT_PERMISSIONS');
    expect(bodies).toHaveLength(2);
  });
  it.each([
    { type: 'error', errorText: 'Synthetic stream failure' },
    { type: 'error' },
    { type: 'error', errorText: { unexpected: true } },
    { type: 'finish', finishReason: 'error' },
    { finishReason: 'error' },
    { finish_reason: 'error' },
    { type: 'finish', metadata: { finishReason: 'error' } },
  ])('rejects a streamed error shape without successful completion: %j', async (failure) => {
    respond = () => stream([failure, finish()]);
    const events = await collect(provider);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toContain('Chatbase stream failed');
  });

  it.each(['error', 'finish'])(
    'preserves partial text but never completes after %s failure',
    async (type) => {
      respond = () =>
        stream([
          { type: 'text-delta', delta: 'Partial answer' },
          { type, finishReason: 'error', errorText: 'Synthetic upstream failure' },
          { type: 'text-delta', delta: 'Must not appear' },
          finish(),
        ]);
      expect(await collect(provider)).toEqual([
        { type: 'content_delta', content: 'Partial answer' },
        { type: 'error', error: 'Chatbase stream failed: Synthetic upstream failure' },
      ]);
    },
  );

  it.each(['text', 'native'])(
    'does not dispatch buffered %s tool calls when the stream fails',
    async (mode) => {
      const input = {
        ...request,
        tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
      };
      respond = () =>
        stream([
          mode === 'native'
            ? {
                type: 'tool-input-available',
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: { path: 'a.ts' },
              }
            : {
                type: 'text-delta',
                delta:
                  '<<TOOL_CALL>>{"tool":"read_file","arguments":{"path":"a.ts"}}<<END_TOOL_CALL>>',
              },
          { type: 'error', errorText: 'Tool generation failed' },
          finish(),
        ]);
      const events = await collect(provider, input);
      expect(events).toEqual([
        { type: 'error', error: 'Chatbase stream failed: Tool generation failed' },
      ]);
    },
  );

  it.each(['', 'data: [DONE]\n\n', 'data: {"type":"finish","finishReason":"stop"}\n\n'])(
    'rejects an empty successful-looking stream: %j',
    async (body) => {
      respond = () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      const events = await collect(provider);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    },
  );

  it('handles a final error frame without a trailing newline', async () => {
    respond = () => new Response('data: {"type":"error","errorText":"Truncated failure"}');
    expect(await collect(provider)).toEqual([
      { type: 'error', error: 'Chatbase stream failed: Truncated failure' },
    ]);
  });

  it('rejects interrupted text without a finish event or DONE marker', async () => {
    respond = () => new Response('data: {"type":"text-delta","delta":"Partial"}\n\n');
    const events = await collect(provider);
    expect(events.map((event) => event.type)).toEqual(['content_delta', 'error']);
  });

  it('normalizes reader failure and releases the response body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('Synthetic connection reset'));
      },
    });
    respond = () => new Response(body);
    const events = await collect(provider);
    // A reader reset is a transport failure, so the event carries the transient
    // flag the registry retries on.
    expect(events).toEqual([
      {
        type: 'error',
        error: 'Chatbase stream failed: Error:Synthetic connection reset',
        errorTransient: true,
      },
    ]);
    expect(body.locked).toBe(false);
  });

  it('cancels and unlocks the reader after a terminal provider error', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"error","errorText":"Failed"}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    respond = () => new Response(body);
    const events = await collect(provider);
    expect(events.map((event) => event.type)).toEqual(['error']);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('redacts and bounds upstream stream error text', async () => {
    respond = () =>
      stream([{ type: 'error', errorText: 'Bearer synthetic-secret ' + 'x'.repeat(1000) }]);
    const events = await collect(provider);
    expect(events[0].error).not.toContain('synthetic-secret');
    expect(events[0].error!.length).toBeLessThan(300);
  });

  it('does not emit premature success when an error follows a finish event', async () => {
    respond = () =>
      stream([
        { type: 'text-delta', delta: 'Partial' },
        finish(),
        { type: 'error', errorText: 'Late failure' },
      ]);
    expect(await collect(provider)).toEqual([
      { type: 'content_delta', content: 'Partial' },
      { type: 'error', error: 'Chatbase stream failed: Late failure' },
    ]);
  });

  it('recognizes SSE error data without optional whitespace', async () => {
    respond = () => new Response('data:{"type":"error","errorText":"Failed"}\n\ndata:[DONE]\n\n');
    expect(await collect(provider)).toEqual([
      { type: 'error', error: 'Chatbase stream failed: Failed' },
    ]);
  });

  it('accepts a successful finish at EOF without requiring a DONE marker', async () => {
    respond = () =>
      new Response(
        'data: {"type":"text-delta","delta":"Answer"}\n\ndata: {"type":"finish","finishReason":"stop"}',
      );
    expect(await collect(provider)).toEqual([
      { type: 'content_delta', content: 'Answer' },
      { type: 'complete', finishReason: 'stop' },
    ]);
  });
});
