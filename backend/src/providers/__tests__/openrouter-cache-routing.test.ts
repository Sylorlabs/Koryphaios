import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { OpenRouterProvider } from '../openai';
import { createPromptCachePlan } from '../prompt-cache';

class CapturingOpenRouterProvider extends OpenRouterProvider {
  readonly requests: Array<Record<string, unknown>> = [];

  constructor() {
    super({ name: 'openrouter', apiKey: 'test-key', disabled: false });
    this._client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            this.requests.push(params);
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
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

async function run(
  provider: CapturingOpenRouterProvider,
  sessionId: string,
  workspaceScope: string,
) {
  const systemPrompt = 'stable system';
  for await (const _event of provider.streamResponse({
    model: 'anthropic/claude-sonnet-4.6',
    systemPrompt,
    messages: [{ role: 'user', content: 'tail message' }],
    sessionId,
    harnessRole: 'manager',
    cacheLaneKind: 'manager',
    promptCache: createPromptCachePlan({
      stableSystemPrompt: systemPrompt,
      providerAdapter: 'openrouter',
      role: 'manager',
      workspaceScope,
    }),
  })) {
    // Drain the stream.
  }
}

describe('OpenRouter prompt-cache routing', () => {
  test('shares sticky routing across sibling tabs and marks the conversation tail', async () => {
    const provider = new CapturingOpenRouterProvider();
    await run(provider, 'tab-a', '/workspace/shared');
    await run(provider, 'tab-b', '/workspace/shared');
    await run(provider, 'tab-c', '/workspace/other');

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[0]?.session_id).toBe(provider.requests[1]?.session_id);
    expect(provider.requests[2]?.session_id).not.toBe(provider.requests[0]?.session_id);
    expect(String(provider.requests[0]?.session_id).length).toBeLessThanOrEqual(256);

    const firstMessages = provider.requests[0]?.messages as Array<Record<string, unknown>>;
    const lastContent = firstMessages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(lastContent.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  });
});
