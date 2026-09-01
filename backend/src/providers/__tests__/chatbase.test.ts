import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { ChatbaseProvider } from '../chatbase';
import { ProviderRegistry } from '../registry';
import type { ProviderEvent } from '../types';
import type { KoryphaiosConfig } from '@koryphaios/shared';

setDefaultTimeout(30000);

const realFetch = globalThis.fetch;

function minimalConfig(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: 'claude-sonnet-4-5' },
      coder: { model: 'claude-sonnet-4-5' },
      task: { model: 'o4-mini' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

describe('ChatbaseProvider', () => {
  let mockHandler: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeAll(() => {
    globalThis.fetch = ((input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? '';
      return Promise.resolve(mockHandler(url, init));
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('reports unavailable when no API key is set', () => {
    const provider = new ChatbaseProvider({
      name: 'chatbase',
      disabled: false,
    });
    expect(provider.isAvailable()).toBe(false);
    expect(provider.listModels()).toEqual([]);
  });

  it('refreshes agent catalog from GET /agents and infers capabilities including reasoning', async () => {
    mockHandler = (url, init) => {
      if (url.includes('/api/v2/agents')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer test-chatbase-key',
        });
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'agent_customer_support',
                name: 'Customer Support Bot',
                model: 'gpt-4o',
                temperature: 0.2,
              },
              {
                id: 'agent_code_reasoner',
                name: 'Deep Reasoner',
                model: 'o1-preview',
                temperature: 1.0,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    expect(provider.isAvailable()).toBe(true);
    await provider.refreshModels(true);
    const models = provider.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('agent_customer_support');
    expect(models[0].name).toBe('Customer Support Bot (gpt-4o)');
    expect(models[0].canReason).toBe(false);
    expect(models[0].tier).toBe('flagship');
    expect(models[0].contextVerified).toBe(true);

    // Reasoning model detected
    expect(models[1].id).toBe('agent_code_reasoner');
    expect(models[1].name).toBe('Deep Reasoner (o1-preview)');
    expect(models[1].canReason).toBe(true);
    expect(models[1].tier).toBe('reasoning');
    expect(models[1].contextVerified).toBe(true);
  });

  it('streams chat completions without foreign conversationId and parses SSE chunks', async () => {
    let capturedBody: any = null;
    mockHandler = (url, init) => {
      if (url.includes('/api/v2/agents/agent_customer_support/chat')) {
        capturedBody = JSON.parse(init?.body as string);
        const streamData = [
          'data: {"conversationId": "cb_conv_999", "type": "thinking", "text": "Analyzing user prompt..."}\n\n',
          'data: {"type": "text", "text": "Hello "}\n\n',
          'data: {"type": "text", "text": "from Chatbase!"}\n\n',
          'data: {"finishReason": "stop", "usage": {"prompt_tokens": 25, "completion_tokens": 10}}\n\n',
          'data: [DONE]\n\n',
        ].join('');

        return new Response(streamData, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'agent_customer_support',
      systemPrompt: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'Hi there!' },
      ],
      sessionId: 'test-session-123',
    })) {
      events.push(event);
    }

    // Verify initial payload does not send foreign conversationId
    expect(capturedBody).toBeDefined();
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.conversationId).toBeUndefined();
    expect(capturedBody.message).toContain('[System Instructions]: You are a helpful assistant.');
    expect(capturedBody.message).toContain('User: Hi there!');

    // Verify stream events emitted
    const thinking = events.find((e) => e.type === 'thinking_delta');
    expect(thinking).toBeDefined();
    expect(thinking?.thinking).toBe('Analyzing user prompt...');

    const contentDeltas = events.filter((e) => e.type === 'content_delta');
    expect(contentDeltas.map((e) => e.content).join('')).toBe('Hello from Chatbase!');

    const usage = events.find((e) => e.type === 'usage_update');
    expect(usage).toBeDefined();
    expect(usage?.tokensIn).toBe(25);
    expect(usage?.tokensOut).toBe(10);

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete?.finishReason).toBe('stop');

    // Second turn with same sessionId should now pass the Chatbase-issued conversationId
    capturedBody = null;
    for await (const _ of provider.streamResponse({
      model: 'agent_customer_support',
      messages: [{ role: 'user', content: 'Follow up question' }],
      sessionId: 'test-session-123',
    })) {}

    expect(capturedBody).toBeDefined();
    expect(capturedBody.conversationId).toBe('cb_conv_999');
  });

  it('follows API v2 pagination ({ pagination: { cursor, hasMore } }) across pages', async () => {
    let page = 0;
    mockHandler = (url) => {
      if (url.includes('/api/v2/agents')) {
        page++;
        const cursors = ['cursor-after-page-1', 'cursor-after-page-2', null];
        return new Response(
          JSON.stringify({
            data: [
              {
                id: `agent_page_${page}`,
                name: `Agent ${page}`,
                model: 'gpt-4o',
              },
            ],
            pagination: { cursor: cursors[page - 1], hasMore: page < 3, total: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    await provider.refreshModels(true);
    const models = provider.listModels();
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual(['agent_page_1', 'agent_page_2', 'agent_page_3']);
    expect(page).toBe(3);
  });

  it('negotiates text-protocol tool calls and emits tool_use events', async () => {
    let capturedBody: any = null;
    mockHandler = (url, init) => {
      if (url.includes('/chat')) {
        capturedBody = JSON.parse(init?.body as string);
        const streamData = [
          'data: {"type": "text", "text": "<<TOOL_CALL>>"}\n\n',
          'data: {"type": "text", "text": "{\\"tool\\": \\"read_file\\", \\"arguments\\": {\\"path\\": \\"src/a.ts\\"}}"}\n\n',
          'data: {"type": "text", "text": "<<END_TOOL_CALL>>"}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(streamData, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'agent_x',
      systemPrompt: 'You are Kory.',
      messages: [{ role: 'user', content: 'Read the file.' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      sessionId: 's1',
    })) {
      events.push(event);
    }

    // Protocol manifest is injected into the flattened prompt.
    expect(capturedBody.message).toContain('KORYPHAIOS HOST PLATFORM NOTICE');
    expect(capturedBody.message).toContain('read_file');

    // No tool-call JSON leaks as chat content.
    expect(events.some((e) => e.type === 'content_delta')).toBe(false);

    const start = events.find((e) => e.type === 'tool_use_start');
    const stop = events.find((e) => e.type === 'tool_use_stop');
    const complete = events.find((e) => e.type === 'complete');
    expect(start?.toolName).toBe('read_file');
    expect(stop?.toolName).toBe('read_file');
    expect(JSON.parse(stop?.toolInput ?? '{}')).toEqual({ path: 'src/a.ts' });
    expect(complete?.finishReason).toBe('tool_use');
  });

  it('falls back to plain chat when the tool-protocol reply does not parse', async () => {
    mockHandler = () => {
      const streamData = [
        'data: {"type": "text", "text": "I cannot call unknown_tool."}\n\n',
        'data: {"type": "text", "text": " But here is an answer."}\n\n',
        'data: [DONE]\n\n',
      ].join('');
      return new Response(streamData, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'agent_x',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
      ],
      sessionId: 's2',
    })) {
      events.push(event);
    }

    const text = events
      .filter((e) => e.type === 'content_delta')
      .map((e) => e.content)
      .join('');
    expect(text).toContain('here is an answer');
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.finishReason).toBe('stop');
  });

  it('round-trips tool results back into the flattened conversation', async () => {
    mockHandler = () => {
      const streamData =
        'data: {"type": "text", "text": "The file contains hello."}\n\ndata: [DONE]\n\n';
      return new Response(streamData, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'agent_x',
      messages: [
        { role: 'user', content: 'Read src/a.ts' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolCallId: 'call-1',
              toolName: 'read_file',
              toolInput: { path: 'src/a.ts' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'hello' },
      ],
      tools: [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
      ],
      sessionId: 's3',
    })) {
      events.push(event);
    }

    const text = events
      .filter((e) => e.type === 'content_delta')
      .map((e) => e.content)
      .join('');
    expect(text).toBe('The file contains hello.');
  });

  it('parses native AI-SDK tool-input-available events into tool_use', async () => {
    let capturedBody: any = null;
    mockHandler = (url, init) => {
      if (url.includes('/chat')) {
        capturedBody = JSON.parse(init?.body as string);
        const streamData = [
          'data: {"type":"start","messageId":"m1"}\n\n',
          'data: {"type":"start-step"}\n\n',
          'data: {"type":"tool-input-start","toolCallId":"tc1","toolName":"read_file"}\n\n',
          'data: {"type":"tool-input-delta","toolCallId":"tc1","inputTextDelta":"{\\"path\\":\\"a.ts\\"}"}\n\n',
          'data: {"type":"tool-input-available","toolCallId":"tc1","toolName":"read_file","input":{"path":"a.ts"}}\n\n',
          'data: {"type":"finish-step"}\n\n',
          'data: {"type":"message-metadata","messageId":"m1","messageMetadata":{"conversationId":"cb_conv_101","usage":{"credits":4}}}\n\n',
          'data: {"type":"finish","finishReason":"stop","messageMetadata":{"conversationId":"cb_conv_101","usage":{"credits":4}}}\n\n',
          'data: [DONE]\n\n',
        ].join('');
        return new Response(streamData, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const provider = new ChatbaseProvider({
      name: 'chatbase',
      apiKey: 'test-chatbase-key',
      disabled: false,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'agent_x',
      messages: [{ role: 'user', content: 'Read a.ts' }],
      tools: [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
      ],
      sessionId: 's-native',
    })) {
      events.push(event);
    }

    const stop = events.find((e) => e.type === 'tool_use_stop');
    const complete = events.find((e) => e.type === 'complete');
    expect(stop?.toolName).toBe('read_file');
    expect(stop?.toolCallId).toBe('tc1');
    expect(JSON.parse(stop?.toolInput ?? '{}')).toEqual({ path: 'a.ts' });
    expect(complete?.finishReason).toBe('tool_use');
    // conversationId captured for follow-up turns
    expect(provider.listModels()).toBeDefined();
    // streaming back a follow-up should now pass the captured conversationId
    capturedBody = null;
    mockHandler = (url, init) => {
      if (url.includes('/chat')) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('Not found', { status: 404 });
    };
    for await (const _ of provider.streamResponse({
      model: 'agent_x',
      messages: [{ role: 'user', content: 'next' }],
      sessionId: 's-native',
    })) {
      // drain
    }
    expect(capturedBody.conversationId).toBe('cb_conv_101');
  });

  it('is properly verified in ProviderRegistry', async () => {
    mockHandler = (url, init) => {
      if (url.includes('/api/v2/agents')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('Unauthorized', { status: 401 });
    };

    const registry = new ProviderRegistry(minimalConfig());
    const verification = await registry.verifyConnection('chatbase', {
      apiKey: 'test-key',
    });
    expect(verification.success).toBe(true);
  });
});
