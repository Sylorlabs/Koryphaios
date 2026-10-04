import { describe, expect, test } from 'bun:test';
import { ollamaAdapter } from '../ollama';
import type { WireAdapterChatRequest } from '../types';

const CTX = {
  config: { name: 'custom:local-ollama' } as never,
  baseUrl: 'http://127.0.0.1:11434',
};

function chatRequest(overrides: Partial<WireAdapterChatRequest> = {}): WireAdapterChatRequest {
  return {
    model: 'llama3',
    systemPrompt: 'You are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('ollama adapter', () => {
  test('matchCatalog requires Ollama tag markers, not just a name list', () => {
    expect(
      ollamaAdapter.matchCatalog(
        {
          models: [{ name: 'llama3:latest', digest: 'abc123', size: 1234 }],
        },
        '/api/tags',
      ),
    ).toBe(true);
    expect(
      ollamaAdapter.matchCatalog(
        { models: [{ name: 'llama3', details: { family: 'llama' } }] },
        '/api/tags',
      ),
    ).toBe(true);
    // Generic name lists never match — even at the Ollama path.
    expect(ollamaAdapter.matchCatalog({ models: [{ name: 'x' }] }, '/api/tags')).toBe(false);
    // Ollama-shaped payloads at other paths do not match.
    expect(ollamaAdapter.matchCatalog({ models: [{ name: 'x', digest: 'd' }] }, '/models')).toBe(
      false,
    );
  });

  test('buildChatRequest maps system, options, and tools onto /api/chat', () => {
    const request = chatRequest({
      maxTokens: 512,
      temperature: 0.4,
      tools: [
        { name: 'get_weather', description: 'Weather lookup', inputSchema: { type: 'object' } },
      ],
    });
    const wire = ollamaAdapter.buildChatRequest(request, CTX);
    expect(wire.path).toBe('/api/chat');
    expect(wire.body).toMatchObject({
      model: 'llama3',
      stream: true,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'hi' },
      ],
      options: { temperature: 0.4, num_predict: 512 },
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather lookup',
            parameters: { type: 'object' },
          },
        },
      ],
    });
  });

  test('buildChatRequest pairs tool results with tool names from assistant history', () => {
    const request = chatRequest({
      systemPrompt: '',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }],
        },
        { role: 'tool', content: '5C', tool_call_id: 'call_1' },
      ],
    });
    const wire = ollamaAdapter.buildChatRequest(request, CTX);
    const messages = (wire.body as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }],
    });
    expect(messages[2]).toMatchObject({ role: 'tool', content: '5C', tool_name: 'get_weather' });
  });

  test('preserves historical and current images in native images arrays', () => {
    const wire = ollamaAdapter.buildChatRequest(
      chatRequest({
        systemPrompt: '',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', imageData: 'cGFzdA==', imageMimeType: 'image/png' }],
          },
          { role: 'assistant', content: 'Earlier answer' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Compare these' },
              { type: 'image', imageData: 'bm93', imageMimeType: 'image/jpeg' },
            ],
          },
        ],
      }),
      CTX,
    );
    expect(wire.body).toMatchObject({
      messages: [
        { role: 'user', content: '', images: ['cGFzdA=='] },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Compare these', images: ['bm93'] },
      ],
    });
  });

  test('parseEvent maps content, thinking, and tool calls', () => {
    expect(ollamaAdapter.parseEvent({ message: { content: 'Hello' } })).toMatchObject({
      contentDelta: 'Hello',
    });
    expect(ollamaAdapter.parseEvent({ message: { thinking: 'hmm' } })).toMatchObject({
      thinkingDelta: 'hmm',
    });
    expect(
      ollamaAdapter.parseEvent({
        message: {
          tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }],
        },
      }),
    ).toMatchObject({
      toolCall: { name: 'get_weather', argsObject: { city: 'Oslo' } },
    });
    expect(ollamaAdapter.parseEvent({ message: {} })).toBeNull();
  });

  test('parseEvent maps the done line usage and finish reasons', () => {
    expect(
      ollamaAdapter.parseEvent({
        message: {},
        done: true,
        prompt_eval_count: 12,
        eval_count: 34,
        done_reason: 'stop',
      }),
    ).toMatchObject({ usage: { tokensIn: 12, tokensOut: 34 }, finishReason: 'end_turn' });
    expect(
      ollamaAdapter.parseEvent({ message: {}, done: true, done_reason: 'length' }),
    ).toMatchObject({ finishReason: 'max_tokens' });
    expect(
      ollamaAdapter.parseEvent({ message: {}, done: true, done_reason: 'tool_calls' }),
    ).toMatchObject({ finishReason: 'tool_use' });
  });
});
