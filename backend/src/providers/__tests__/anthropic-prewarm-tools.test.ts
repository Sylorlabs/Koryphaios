import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from '../anthropic';
import { createPromptCachePlan } from '../prompt-cache';

class CapturingAnthropicProvider extends AnthropicProvider {
  readonly requests: Array<Record<string, unknown>> = [];

  constructor() {
    super({ name: 'anthropic', apiKey: 'test-key', disabled: false });
    this._client = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          this.requests.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message_start',
                message: {
                  usage: {
                    input_tokens: 100,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                },
              };
              yield {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 1 },
              };
            },
          };
        },
      },
    } as unknown as Anthropic;
  }

  override listModels() {
    return [];
  }
}

describe('Anthropic cache prewarm tool safety', () => {
  test('keeps declared tool schemas while forbidding tool selection', async () => {
    const provider = new CapturingAnthropicProvider();
    const systemPrompt = 'stable system';

    for await (const _event of provider.streamResponse({
      model: 'claude-sonnet-4-6',
      systemPrompt,
      messages: [{ role: 'user', content: '.' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      allowedToolNames: [],
      maxTokens: 1,
      promptCache: createPromptCachePlan({
        stableSystemPrompt: systemPrompt,
        providerAdapter: 'anthropic',
        role: 'manager',
        workspaceScope: '/workspace/example',
      }),
    })) {
      // Drain the provider stream so the captured request is complete.
    }

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toHaveLength(1);
    expect(provider.requests[0]?.tool_choice).toEqual({ type: 'none' });
  });
});
