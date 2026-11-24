import { afterEach, describe, expect, it } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelDef } from '@koryphaios/shared';
import { AnthropicProvider } from '../anthropic';
import { GoogleProvider } from '../google';
import { OpenAIProvider } from '../openai';
import { gateModelParametersToForwarded } from '../registry';
import { enrichFromRemoteMetadata } from '../model-list-cache';
import {
  applyModelsDevMetadata,
  warmModelsDevCache,
  __resetModelsDevCacheForTesting,
} from '../models-dev';
import { SendMessageRequestSchema } from '../../validation/schemas';
import type { ProviderEvent, StreamRequest } from '../types';

const model = (id: string, extra: Partial<ModelDef> = {}): ModelDef => ({
  id,
  name: id,
  provider: 'openai',
  contextWindow: 0,
  maxOutputTokens: 0,
  supportsStreaming: true,
  ...extra,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('enrichFromRemoteMetadata', () => {
  it('builds parameter defs from supported_parameters + default_parameters', () => {
    const out = enrichFromRemoteMetadata(
      {
        supported_parameters: ['temperature', 'top_p', 'seed', 'max_tokens', 'tools'],
        default_parameters: { temperature: 0.7, top_p: 0.95 },
        top_provider: { max_completion_tokens: 8192 },
      },
      model('m'),
    );
    expect(out.parameters?.map((d) => d.key)).toEqual([
      'temperature',
      'top_p',
      'max_tokens',
      'seed',
    ]);
    const temp = out.parameters?.find((d) => d.key === 'temperature');
    expect(temp?.default).toBe(0.7);
    expect(temp?.defaultSource).toBe('provider');
    const seed = out.parameters?.find((d) => d.key === 'seed');
    expect(seed?.default).toBeUndefined();
    const max = out.parameters?.find((d) => d.key === 'max_tokens');
    expect(max?.max).toBe(8192);
  });

  it('leaves parameters absent when the row reports none', () => {
    const out = enrichFromRemoteMetadata({ context_length: 128000 }, model('m'));
    expect(out.parameters).toBeUndefined();
  });
});

describe('applyModelsDevMetadata temperature fill', () => {
  async function seed(temperature: boolean): Promise<void> {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          testlab: {
            models: {
              'm-temp': { id: 'm-temp', temperature, limit: { output: 4096 } },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    __resetModelsDevCacheForTesting();
    await warmModelsDevCache();
  }

  it('fills temperature when the lab says the model accepts it', async () => {
    await seed(true);
    const out = applyModelsDevMetadata('testlab', [model('m-temp')], ['testlab']);
    expect(out[0]?.parameters?.map((d) => d.key)).toEqual(['temperature']);
  });

  it('leaves parameters empty when the lab says false', async () => {
    await seed(false);
    const out = applyModelsDevMetadata('testlab', [model('m-temp')], ['testlab']);
    expect(out[0]?.parameters).toBeUndefined();
  });

  it('never overwrites provider-reported parameters', async () => {
    await seed(true);
    const reported = [
      { key: 'seed' as const, label: 'Seed', kind: 'integer' as const, description: 'd' },
    ];
    const out = applyModelsDevMetadata(
      'testlab',
      [model('m-temp', { parameters: reported })],
      ['testlab'],
    );
    expect(out[0]?.parameters).toBe(reported);
  });
});

describe('registry parameter gate', () => {
  const defs = [
    model('m', {
      parameters: [
        { key: 'temperature', label: 't', kind: 'float', description: 'd' },
        { key: 'max_tokens', label: 'm', kind: 'integer', description: 'd' },
        { key: 'seed', label: 's', kind: 'integer', description: 'd' },
      ],
    }),
  ];

  it('strips parameters for providers without a forwarding set (CLI harness)', () => {
    const out = gateModelParametersToForwarded({} as never, defs);
    expect(out[0]?.parameters).toBeUndefined();
    // Input model is not mutated.
    expect(defs[0]?.parameters).toHaveLength(3);
  });

  it('keeps only max_tokens for gwarden', () => {
    const gwarden = new OpenAIProvider(
      { name: 'gwarden', apiKey: 'k', disabled: false },
      'gwarden',
    );
    const out = gateModelParametersToForwarded(gwarden, defs);
    expect(out[0]?.parameters?.map((d) => d.key)).toEqual(['max_tokens']);
  });

  it('keeps the full set for a plain OpenAI-compatible provider', () => {
    const openai = new OpenAIProvider({ name: 'openrouter', apiKey: 'k', disabled: false });
    const out = gateModelParametersToForwarded(openai, defs);
    expect(out[0]?.parameters?.map((d) => d.key)).toEqual(['temperature', 'max_tokens', 'seed']);
  });
});

const sse = (payloads: string[]): Response =>
  new Response(payloads.map((p) => `data: ${p}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

function captureBodies(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return sse([
      '{"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      '[DONE]',
    ]);
  }) as typeof fetch;
  return bodies;
}

const req = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  systemPrompt: 'sys',
  ...overrides,
});

const paramDefs = [
  {
    key: 'temperature' as const,
    label: 't',
    kind: 'float' as const,
    min: 0,
    max: 2,
    description: 'd',
  },
  { key: 'seed' as const, label: 's', kind: 'integer' as const, description: 'd' },
  {
    key: 'max_tokens' as const,
    label: 'm',
    kind: 'integer' as const,
    min: 1,
    max: 4096,
    description: 'd',
  },
];

describe('OpenAIProvider model parameters', () => {
  it('sends declared overrides and drops undeclared keys', async () => {
    const provider = new OpenAIProvider({ name: 'openrouter', apiKey: 'k', disabled: false });
    provider.listModels = () => [model('test-model', { parameters: paramDefs })];
    const bodies = captureBodies();
    for await (const _e of provider.streamResponse(
      req({
        modelParameters: {
          temperature: 0.5,
          seed: 7,
          max_tokens: 100,
          repetition_penalty: 1.1, // not declared by this model
        } as never,
      }),
    )) {
      // drain
    }
    const body = bodies[0]!;
    expect(body.temperature).toBe(0.5);
    expect(body.seed).toBe(7);
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
    expect(body.repetition_penalty).toBeUndefined();
  });

  it('modelParameters.max_tokens overrides request.maxTokens', async () => {
    const provider = new OpenAIProvider({ name: 'openrouter', apiKey: 'k', disabled: false });
    provider.listModels = () => [model('test-model', { parameters: paramDefs })];
    const bodies = captureBodies();
    for await (const _e of provider.streamResponse(
      req({ maxTokens: 999, modelParameters: { max_tokens: 50 } }),
    )) {
      // drain
    }
    expect(bodies[0]!.max_completion_tokens).toBe(50);
  });

  it('gwarden sends only max_tokens even when other params are requested', async () => {
    const provider = new OpenAIProvider(
      { name: 'gwarden', apiKey: 'k', disabled: false },
      'gwarden',
    );
    provider.listModels = () => [
      model('test-model', {
        parameters: [
          ...paramDefs,
          { key: 'seed' as const, label: 's', kind: 'integer' as const, description: 'd' },
        ],
      }),
    ];
    const bodies = captureBodies();
    for await (const _e of provider.streamResponse(
      req({ modelParameters: { temperature: 0.5, seed: 1, max_tokens: 77 } }),
    )) {
      // drain
    }
    const body = bodies[0]!;
    expect(body.max_tokens).toBe(77);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });
});

class CapturingAnthropicProvider extends AnthropicProvider {
  readonly requests: Array<Record<string, unknown>> = [];
  constructor(private defs: ModelDef[]) {
    super({ name: 'anthropic', apiKey: 'test-key', disabled: false });
    this._client = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          this.requests.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'message_start',
                message: { usage: { input_tokens: 1, output_tokens: 0 } },
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
    return this.defs;
  }
}

describe('AnthropicProvider model parameters', () => {
  it('maps overrides into the request body and drops undeclared keys', async () => {
    const provider = new CapturingAnthropicProvider([
      model('claude-x', {
        parameters: [
          ...paramDefs,
          { key: 'top_k' as const, label: 'k', kind: 'integer' as const, description: 'd' },
        ],
      }),
    ]);
    for await (const _e of provider.streamResponse(
      req({
        model: 'claude-x',
        maxTokens: 999,
        modelParameters: { temperature: 0.4, max_tokens: 55, seed: 9, top_k: 3 } as never,
      }),
    )) {
      // drain
    }
    const body = provider.requests[0]!;
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(55);
    expect(body.top_k).toBe(3);
    expect(body.seed).toBeUndefined();
  });
});

describe('GoogleProvider model parameters', () => {
  it('maps overrides into generationConfig fields', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      return new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const provider = new GoogleProvider({ name: 'aistudio', apiKey: 'k', disabled: false });
    provider.listModels = () => [
      model('gemini-x', {
        parameters: [
          ...paramDefs,
          {
            key: 'top_k' as const,
            label: 'k',
            kind: 'integer' as const,
            description: 'd',
          },
          {
            key: 'presence_penalty' as const,
            label: 'p',
            kind: 'float' as const,
            description: 'd',
          },
        ],
      }),
    ];
    try {
      for await (const _e of provider.streamResponse(
        req({
          model: 'gemini-x',
          maxTokens: 999,
          modelParameters: {
            temperature: 0.3,
            top_k: 5,
            presence_penalty: 0.6,
            max_tokens: 42,
            repetition_penalty: 1.2, // not forwarded by google
          } as never,
        }),
      )) {
        // drain
      }
    } catch {
      // SDK response-shape details may throw after the body was captured;
      // the assertion below is what matters.
    }
    const config = (bodies[0]?.config ?? bodies[0]?.generationConfig ?? {}) as Record<
      string,
      unknown
    >;
    expect(config.temperature).toBe(0.3);
    expect(config.topK).toBe(5);
    expect(config.presencePenalty).toBe(0.6);
    expect(config.maxOutputTokens).toBe(42);
    expect(config.repetitionPenalty).toBeUndefined();
  });
});

describe('SendMessageRequestSchema modelParameters', () => {
  const base = { sessionId: 's'.repeat(8), content: 'hello' };

  it('accepts known keys with number and string values', () => {
    const parsed = SendMessageRequestSchema.safeParse({
      ...base,
      modelParameters: { temperature: 0.5, verbosity: 'high' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown keys and bad value types', () => {
    expect(
      SendMessageRequestSchema.safeParse({
        ...base,
        modelParameters: { tools: 1 },
      }).success,
    ).toBe(false);
    expect(
      SendMessageRequestSchema.safeParse({
        ...base,
        modelParameters: { temperature: [1] },
      }).success,
    ).toBe(false);
  });
});
