import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from '../openai';
import { AnthropicProvider } from '../anthropic';
import { GoogleProvider } from '../google';
import { CursorProvider } from '../cursor';
import { DevinProvider } from '../devin';
import { GrokBuildProvider } from '../grok-build';
import { CodebuffProvider } from '../codebuff';
import { GitLabProvider } from '../gitlab';
import { NotionProvider } from '../notion';
import { ChatbaseProvider } from '../chatbase';
import { JulesProvider } from '../jules';
import { HopliteProvider } from '../hoplite';
import { ProviderRegistry } from '../registry';
import { OpenAICompatiblePlugin } from '../plugin/openai-compatible';
import { imageAttachmentAdmissionError, omitImageInputs } from '../attachment-admission';
import type { Provider, ProviderEvent, StreamRequest } from '../types';

process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const imageMessages: StreamRequest['messages'] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this image' },
      { type: 'image', imageData: 'cGl4ZWxz', imageMimeType: 'image/png' },
    ],
  },
];
const model = 'vision-fixture';
const config = (name: string): ProviderConfig => ({
  name,
  custom: true,
  apiKey: 'synthetic-fixture-key',
  disabled: false,
  baseUrl: 'https://image-fixture.test',
});
function modelDef(provider: string): ModelDef {
  return {
    id: model,
    name: model,
    provider,
    contextWindow: 0,
    maxOutputTokens: 0,
    vision: false,
    supportsAttachments: false,
  };
}
async function collect(
  provider: Provider,
  override?: StreamRequest['imageInputOverride'],
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.streamResponse({
    model,
    systemPrompt: '',
    messages: imageMessages,
    imageInputOverride: override,
  }))
    events.push(event);
  return events;
}
const frames = {
  openai: [{ choices: [{ delta: { content: 'Image seen' }, finish_reason: 'stop' }] }],
  anthropic: [
    {
      type: 'message_start',
      message: {
        id: 'fixture',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Image seen' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ],
  google: [
    {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'Image seen' }] }, finishReason: 'STOP' },
      ],
    },
  ],
};
function installTransport(family: keyof typeof frames, reject = false) {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return Response.json({ data: [], models: [] });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    if (!body.messages && !body.contents) return Response.json({ data: [], models: [] });
    bodies.push(body);
    if (reject)
      return Response.json(
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            type: 'invalid_request_error',
            message: 'This model does not support image input',
          },
        },
        { status: 400 },
      );
    const data = frames[family]
      .map(
        (frame) =>
          `${'type' in frame ? `event: ${frame.type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`,
      )
      .join('');
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return bodies;
}

describe('image capability correction across SDK provider identities', () => {
  test('OpenAI-compatible plugins send image parts instead of JSON-stringified pixels', async () => {
    const plugin = new OpenAICompatiblePlugin('custom:plugin', {
      ...config('custom:plugin'),
      baseUrl: 'https://image-fixture.test',
    });
    await plugin.initialize();
    const bodies = installTransport('openai');
    const events: ProviderEvent[] = [];
    for await (const event of plugin.stream({
      model,
      messages: imageMessages,
      systemPrompt: '',
      imageInputOverride: { provider: 'custom:plugin', model },
    }))
      events.push(event);
    expect(bodies[0]).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } },
          ],
        },
      ],
    });
    expect(events.some((event) => event.content === 'Image seen')).toBe(true);
  });

  test.each([
    'openai',
    'openrouter',
    'groq',
    'xai',
    'copilot',
    'cline',
    'commandcode',
    'kimicode',
    'azure',
    'sapai',
    'local',
    'ollama',
    'custom:vision',
  ])('OpenAI-compatible %s retains confirmed image bytes', async (name) => {
    const provider = new OpenAIProvider(config(name), name, 'https://image-fixture.test');
    provider.listModels = () => [modelDef(name)];
    const bodies = installTransport('openai');
    const events = await collect(provider, { provider: name, model });
    expect(JSON.stringify(bodies[0])).toContain('data:image/png;base64,cGl4ZWxz');
    expect(events.some((event) => event.content === 'Image seen')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  test.each(['anthropic', 'bedrock', 'commandcode', 'custom:claude'])(
    'Anthropic-compatible %s retains confirmed image bytes',
    async (name) => {
      const provider = new AnthropicProvider(config(name), name);
      provider.listModels = () => [modelDef(name)];
      const bodies = installTransport('anthropic');
      const events = await collect(provider, { provider: name, model });
      expect(bodies[0]).toMatchObject({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this image' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWxz' },
              },
            ],
          },
        ],
      });
      expect(events.some((event) => event.content === 'Image seen')).toBe(true);
      expect(events.some((event) => event.type === 'error')).toBe(false);
    },
  );

  test.each(['google', 'aistudio', 'vertexai', 'custom:gemini'])(
    'Gemini-compatible %s retains confirmed image bytes',
    async (name) => {
      const provider = new GoogleProvider(config(name));
      provider.listModels = () => [modelDef(name)];
      const bodies = installTransport('google');
      const events = await collect(provider, { provider: name, model });
      expect(JSON.stringify(bodies[0])).toContain('cGl4ZWxz');
      expect(JSON.stringify(bodies[0])).toContain('image/png');
      expect(events.some((event) => event.content === 'Image seen')).toBe(true);
      expect(events.some((event) => event.type === 'error')).toBe(false);
    },
  );

  test.each(['anthropic', 'google'] as const)(
    '%s surfaces confirmed-image rejection without text-only retries',
    async (family) => {
      const provider =
        family === 'anthropic'
          ? new AnthropicProvider(config(family), family)
          : new GoogleProvider(config(family));
      provider.listModels = () => [modelDef(family)];
      const bodies = installTransport(family, true);
      const events = await collect(provider, { provider: family, model });
      expect(bodies).toHaveLength(1);
      expect(JSON.stringify(bodies[0])).toContain('cGl4ZWxz');
      expect(events.some((event) => event.type === 'error')).toBe(true);
    },
  );

  test.each([false, true])('Gemini retains audio/video bytes and never retries as text (rejection=%s)', async (reject) => {
    const provider = new GoogleProvider(config('google'));
    const bodies = installTransport('google', reject);
    const events: ProviderEvent[] = [];
    for await (const event of provider.streamResponse({
      model: 'gemini-2.5-flash', systemPrompt: '',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe the clip and transcribe the recording.' },
        { type: 'video', mediaData: 'Y2xpcA==', mediaMimeType: 'video/mp4' },
        { type: 'audio', mediaData: 'c3BlZWNo', mediaMimeType: 'audio/mpeg' },
      ] }],
    })) events.push(event);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ contents: [{ parts: [
      { text: 'Describe the clip and transcribe the recording.' },
      { inlineData: { data: 'Y2xpcA==', mimeType: 'video/mp4' } },
      { inlineData: { data: 'c3BlZWNo', mimeType: 'audio/mpeg' } },
    ] }] });
    expect(events.some((event) => event.type === 'error')).toBe(reject);
  });
});

describe('image transport is independent of model metadata', () => {
  const textOnlyProviders = [
    CursorProvider,
    DevinProvider,
    GrokBuildProvider,
    CodebuffProvider,
    GitLabProvider,
    NotionProvider,
    ChatbaseProvider,
    JulesProvider,
    HopliteProvider,
  ];
  test.each(textOnlyProviders)(
    '$name does not turn an image correction into silent omission',
    (ProviderClass) => {
      const provider = new ProviderClass(config('text-fixture'));
      expect(provider.imageInputTransport).toBe('none');
      expect(imageAttachmentAdmissionError(provider, model, imageMessages, 'allow')).toContain(
        'cannot deliver image input',
      );
      expect(
        imageAttachmentAdmissionError(provider, model, omitImageInputs(imageMessages), 'omit'),
      ).toBeNull();
    },
  );

  test('the common dispatcher rejects a text-only provider before calling its converter', async () => {
    const registry = new ProviderRegistry();
    let called = false;
    const provider: Provider = {
      name: 'remote-text-fixture',
      config: config('remote-text-fixture'),
      imageInputTransport: 'none',
      isAvailable: () => true,
      listModels: () => [
        { ...modelDef('remote-text-fixture'), vision: true, supportsAttachments: true },
      ],
      async *streamResponse() {
        called = true;
        yield { type: 'complete' };
      },
    };
    registry.registerRemoteProvider(provider);
    const events: ProviderEvent[] = [];
    for await (const event of registry.executeWithRetry(
      {
        model,
        systemPrompt: '',
        messages: imageMessages,
        imageInputOverride: { provider: provider.name, model },
      },
      provider.name,
    ))
      events.push(event);
    expect(called).toBe(false);
    expect(events).toEqual([
      {
        type: 'error',
        error: expect.stringContaining('cannot deliver image input'),
        errorTransient: false,
      },
    ]);
  });
});
