import { afterEach, describe, expect, it } from 'bun:test';
import { OpenAIProvider } from '../openai';
import type { ProviderEvent, StreamRequest } from '../types';

const originalFetch = globalThis.fetch;
const baseUrl = 'https://api.reflection.ai/openai/v1';
const model = 'Beam-1.0-501B-A23B';
// First-party schema: https://developers.reflection.ai/api-reference/models/list-models
const catalog = { object: 'list', data: [{
  id: model, object: 'model', owned_by: 'reflection', context_length: 1_048_576,
  max_output_tokens: 131_072,
  reasoning: { supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], mandatory: true },
}] };

afterEach(() => { globalThis.fetch = originalFetch; });

function provider() {
  return new OpenAIProvider({ name: 'beam', apiKey: 'synthetic-key', baseUrl }, 'beam');
}

async function collect(p: OpenAIProvider, overrides: Partial<StreamRequest> = {}) {
  const events: ProviderEvent[] = [];
  for await (const event of p.streamResponse({
    model, systemPrompt: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  })) events.push(event);
  return events;
}

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

describe('Beam chat contract', () => {
  it('discovers real limits and exact reasoning efforts without guessing image support', async () => {
    const requests: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      return Response.json(req.url === `${baseUrl}/models` ? catalog : {});
    }) as typeof fetch;
    const p = provider();
    await p.refreshModels(true);
    expect(requests.find((req) => req.url === `${baseUrl}/models`)?.headers.get('authorization'))
      .toBe('Bearer synthetic-key');
    expect(p.listModels()).toMatchObject([{
      id: model, contextWindow: 1_048_576, contextVerified: true, maxOutputTokens: 131_072,
      canReason: true, reasoningLevels: ['max', 'xhigh', 'high', 'medium', 'low'],
      vision: false, supportsAttachments: false,
    }]);
  });

  it('streams reasoning, tool calls, and usage while replaying assistant reasoning unchanged', async () => {
    let body: Record<string, any> = {};
    let chatRequest: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/models')) return Response.json(catalog);
      if (!req.url.endsWith('/chat/completions')) return Response.json({});
      chatRequest = req;
      body = await req.json();
      return sse([
        { choices: [{ delta: { reasoning_content: 'Check the result.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: {
          name: 'lookup', arguments: '{"q":"next"}',
        } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 12 } } },
      ]);
    }) as typeof fetch;
    const p = provider();
    await p.refreshModels(true);
    const events = await collect(p, {
      reasoningLevel: 'xhigh',
      messages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer', reasoningContent: '  Original thought.\n' },
        { role: 'assistant', content: '', reasoningContent: 'Need a lookup.',
          tool_calls: [{ id: 'call-1', name: 'lookup', input: { q: 'first' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Found it' },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    });
    expect(chatRequest?.url).toBe(`${baseUrl}/chat/completions`);
    expect(chatRequest?.headers.get('authorization')).toBe('Bearer synthetic-key');
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.messages[2].reasoning_content).toBe('  Original thought.\n');
    expect(body.messages[3]).toMatchObject({ reasoning_content: 'Need a lookup.',
      tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"q":"first"}' } }] });
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('thinking');
    expect(events).toContainEqual({ type: 'thinking_delta', thinking: 'Check the result.' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use_start', toolName: 'lookup' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage_update', tokensIn: 100,
      tokensOut: 20, thinkingTokens: 12 }));
    expect(events).toContainEqual({ type: 'complete', finishReason: 'tool_use' });
  });

  it('preserves reasoning with block-format tool history and omits unsupported effort values', async () => {
    let body: Record<string, any> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.endsWith('/models')) return Response.json(catalog);
      if (!req.url.endsWith('/chat/completions')) return Response.json({});
      body = await req.json();
      return sse([{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }]);
    }) as typeof fetch;
    const p = provider();
    await p.refreshModels(true);
    const events = await collect(p, {
      reasoningLevel: 'none',
      messages: [
        { role: 'assistant', reasoningContent: 'Look up the answer.', content: [
          { type: 'tool_use', toolCallId: 'call-1', toolName: 'lookup', toolInput: {} },
        ] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call-1', toolOutput: '42' }] },
      ],
    });
    expect(body.messages[1].reasoning_content).toBe('Look up the answer.');
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: '42' });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(events).toContainEqual({ type: 'content_delta', content: 'Done' });
    expect(events).toContainEqual({ type: 'complete', finishReason: 'stop' });
  });

  it('reports missing historical reasoning locally rather than fabricating it', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    for (const reasoningContent of [undefined, '', '  ']) {
      const events = await collect(provider(), {
        messages: [{ role: 'assistant', content: 'Imported answer', reasoningContent }],
      });
      expect(events).toEqual([{ type: 'error', error: expect.stringContaining('missing reasoning') }]);
    }
    expect(calls).toBe(0);
  });
});
