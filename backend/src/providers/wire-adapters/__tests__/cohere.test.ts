import { describe, expect, test } from 'bun:test';
import { cohereAdapter } from '../cohere';
import type { WireAdapterChatRequest } from '../types';

const CTX = {
  config: { name: 'custom:cohere' } as never,
  baseUrl: 'https://api.cohere.example',
  credential: 'tok_123',
};

function chatRequest(overrides: Partial<WireAdapterChatRequest> = {}): WireAdapterChatRequest {
  return {
    model: 'command-r-plus',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('cohere adapter', () => {
  test('never auto-matches a catalog (manual override only)', () => {
    expect(
      cohereAdapter.matchCatalog({ models: [{ name: 'command-r', endpoints: ['chat'] }] }),
    ).toBe(false);
    expect(cohereAdapter.matchCatalog({ object: 'list', data: [{ id: 'x' }] })).toBe(false);
    expect(cohereAdapter.catalogPaths).toEqual([]);
  });

  test('buildChatRequest targets /v2/chat with bearer auth and required max_tokens', () => {
    const wire = cohereAdapter.buildChatRequest(chatRequest({ temperature: 0.2 }), CTX);
    expect(wire.path).toBe('/v2/chat');
    expect(wire.headers.Authorization).toBe('Bearer tok_123');
    expect(wire.body).toMatchObject({
      model: 'command-r-plus',
      stream: true,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('buildChatRequest maps system prompt, assistant tool calls, and tool results', () => {
    const request = chatRequest({
      systemPrompt: 'Be brief.',
      maxTokens: 256,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_9', name: 'get_weather', input: { city: 'Oslo' } }],
        },
        { role: 'tool', content: '5C', tool_call_id: 'call_9' },
      ],
      tools: [{ name: 'get_weather', description: 'Weather', inputSchema: { type: 'object' } }],
    });
    const wire = cohereAdapter.buildChatRequest(request, CTX);
    expect(wire.body).toMatchObject({
      max_tokens: 256,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_9',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_9', content: '5C' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } },
        },
      ],
    });
  });

  test('parseEvent maps typed SSE events into canonical chunks', () => {
    expect(
      cohereAdapter.parseEvent({
        type: 'content-delta',
        delta: { message: { content: { text: 'Hi' } } },
      }),
    ).toMatchObject({ contentDelta: 'Hi' });
    expect(
      cohereAdapter.parseEvent({
        type: 'tool-call-start',
        tool_call: { id: 'call_1', function: { name: 'get_weather' } },
      }),
    ).toMatchObject({ toolCall: { id: 'call_1', name: 'get_weather' } });
    expect(
      cohereAdapter.parseEvent({
        type: 'tool-call-delta',
        delta: { tool_call: { function: { arguments: '{"ci' } } },
      }),
    ).toMatchObject({ toolCall: { argsDelta: '{"ci' } });
    expect(
      cohereAdapter.parseEvent({
        type: 'message-end',
        usage: { billed_units: { input_tokens: 10, output_tokens: 20 } },
        finish_reason: 'COMPLETE',
      }),
    ).toMatchObject({ usage: { tokensIn: 10, tokensOut: 20 }, finishReason: 'end_turn' });
    expect(
      cohereAdapter.parseEvent({ type: 'message-end', finish_reason: 'TOOL_CALLS' }),
    ).toMatchObject({ finishReason: 'tool_use' });
    expect(
      cohereAdapter.parseEvent({ type: 'message-end', finish_reason: 'MAX_TOKENS' }),
    ).toMatchObject({ finishReason: 'max_tokens' });
    expect(cohereAdapter.parseEvent({ type: 'stream-start' })).toBeNull();
  });
});
