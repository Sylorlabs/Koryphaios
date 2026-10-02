import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { OpenAIProvider } from '../openai';
import { createPromptCachePlan } from '../prompt-cache';

class CapturingOpenAIProvider extends OpenAIProvider {
  readonly requests: Array<Record<string, unknown>> = [];

  constructor() {
    super({ name: 'openai', apiKey: 'test-key', disabled: false });
    this._client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            this.requests.push(params);
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                };
              },
            };
          },
        },
      },
    } as unknown as OpenAI;
  }

  override listModels() {
    return [];
  }
}

const declaredTools = [
  {
    name: 'bash',
    description: 'Run a command.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
  {
    name: 'read_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

async function drain(provider: OpenAIProvider, allowedToolNames: string[]) {
  const systemPrompt = 'stable system';
  for await (const _event of provider.streamResponse({
    model: 'gpt-5.6',
    systemPrompt,
    messages: [{ role: 'user', content: 'test' }],
    tools: declaredTools,
    allowedToolNames,
    promptCache: createPromptCachePlan({
      stableSystemPrompt: systemPrompt,
      providerAdapter: 'openai',
      role: 'manager',
    }),
  })) {
    // Drain the provider stream so the captured request is complete.
  }
}

describe('OpenAI stable tool declarations', () => {
  test('changes allowed_tools without changing declared tool schemas', async () => {
    const provider = new CapturingOpenAIProvider();

    await drain(provider, ['read_file']);
    await drain(provider, ['bash']);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools).toEqual(provider.requests[1]?.tools);
    expect(provider.requests[0]?.prompt_cache_key).toBe(provider.requests[1]?.prompt_cache_key);
    expect(provider.requests[0]?.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '30m' });
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('prompt_cache_breakpoint');
    expect(provider.requests[0]?.tool_choice).toEqual({
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'auto',
        tools: [{ type: 'function', function: { name: 'read_file' } }],
      },
    });
    expect(provider.requests[1]?.tool_choice).toEqual({
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'auto',
        tools: [{ type: 'function', function: { name: 'bash' } }],
      },
    });
  });
});
