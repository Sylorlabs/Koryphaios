import { afterEach, describe, expect, test } from 'bun:test';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { CustomProvider, normalizeCustomProviderBaseUrl, probeCustomProvider } from '../custom';
import { ProviderRegistry } from '../registry';
import type { Provider } from '../types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('custom provider onboarding hardening', () => {
  test('normalizes copied terminal API paths and rejects unsafe URL forms', () => {
    expect(normalizeCustomProviderBaseUrl(' https://seekai.cc/v1/models?source=docs#copy ')).toBe(
      'https://seekai.cc/v1',
    );
    expect(normalizeCustomProviderBaseUrl('https://gateway.example/v1/chat/completions')).toBe(
      'https://gateway.example/v1',
    );
    expect(normalizeCustomProviderBaseUrl('http://localhost:1234/v1/')).toBe(
      'http://localhost:1234/v1',
    );
    expect(() => normalizeCustomProviderBaseUrl('ftp://example.com/v1')).toThrow('http://');
    expect(() => normalizeCustomProviderBaseUrl('https://user:secret@example.com/v1')).toThrow(
      'credentials',
    );
  });

  test('never substitutes a different origin during normalization', () => {
    expect(normalizeCustomProviderBaseUrl('https://api.gateway.example.com/v1')).toBe(
      'https://api.gateway.example.com/v1',
    );
    expect(normalizeCustomProviderBaseUrl('https://eu.gateway.example.com/v1')).toBe(
      'https://eu.gateway.example.com/v1',
    );
  });

  test('probes the staged OpenAI-compatible catalog with the real bearer shape', async () => {
    let capturedUrl = '';
    let capturedAuthorization: string | null = null;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.url;
      capturedAuthorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ data: [{ id: 'seekai-model' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await probeCustomProvider({
      kind: 'openai',
      baseUrl: 'https://seekai.cc/v1/models',
      apiKey: 'sk-valid',
    });

    expect(result).toMatchObject({
      success: true,
      normalizedBaseUrl: 'https://seekai.cc/v1',
      models: ['seekai-model'],
      canSaveUnverified: false,
    });
    expect(capturedUrl).toBe('https://seekai.cc/v1/models');
    expect(capturedAuthorization).toBe('Bearer sk-valid');
  });

  test('removes and re-adds models when a live custom catalog changes', async () => {
    let models = ['first-model'];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const provider = new CustomProvider({
      name: 'custom:catalog-reconciliation',
      custom: true,
      kind: 'openai',
      baseUrl: 'https://gateway.example/v1',
      disabled: false,
    });

    await provider.refreshModels?.(true);
    expect(provider.listModels().map((model) => model.id)).toEqual(['first-model']);

    models = [];
    await provider.refreshModels?.(true);
    expect(provider.listModels()).toEqual([]);

    models = ['second-model'];
    await provider.refreshModels?.(true);
    expect(provider.listModels().map((model) => model.id)).toEqual(['second-model']);
  });

  test('falls back to /v1/models when a version-less Anthropic base serves HTML at /models', async () => {
    // The Anthropic SDK owns the `/v1` segment, so a version-less root is the
    // documented shape for an Anthropic-compatible deployment. Its web front
    // end answers `/models` with 200 + HTML, which is not a verdict on the key.
    const requested: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      requested.push(url);
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v3.2' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('<!DOCTYPE html><html><head><title>logfare</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const result = await probeCustomProvider({
      kind: 'anthropic',
      baseUrl: 'https://logfare.ai',
      apiKey: 'lfu_key',
    });

    expect(requested).toEqual(['https://logfare.ai/models', 'https://logfare.ai/v1/models']);
    expect(result).toMatchObject({
      success: true,
      normalizedBaseUrl: 'https://logfare.ai',
      models: ['deepseek-v3.2'],
      canSaveUnverified: false,
    });
  });

  test('still fails an Anthropic version-less base when no candidate serves a catalog', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input) => {
      requested.push(typeof input === 'string' ? input : input.url);
      return new Response('<!DOCTYPE html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const result = await probeCustomProvider({
      kind: 'anthropic',
      baseUrl: 'https://marketing-only.example',
      apiKey: 'k',
    });

    expect(requested).toHaveLength(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not return valid JSON');
  });

  test('keeps a rejected Anthropic credential terminal on the first candidate', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input) => {
      requested.push(typeof input === 'string' ? input : input.url);
      return new Response('{}', { status: 403 });
    }) as typeof fetch;

    const result = await probeCustomProvider({
      kind: 'anthropic',
      baseUrl: 'https://logfare.ai',
      apiKey: 'bad-key',
    });

    // A 403 describes the credential, not the path: never retry it elsewhere.
    expect(requested).toEqual(['https://logfare.ai/models']);
    expect(result).toMatchObject({ success: false, status: 403, canSaveUnverified: false });
  });

  test('never lets rejected credentials use the unverified escape hatch', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;

    const result = await probeCustomProvider({
      baseUrl: 'https://seekai.cc/v1',
      apiKey: 'bad-key',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.canSaveUnverified).toBe(false);
    expect(result.error).toContain('Nothing was saved');
    expect(result.error).not.toContain('bad-key');
  });

  test('permits an explicit manual-model fallback only for catalog gaps', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    const result = await probeCustomProvider({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'secret',
    });

    expect(result).toMatchObject({ success: false, status: 404, canSaveUnverified: true });
    expect(result.error).not.toContain('secret');
  });

  test('omits fabricated authorization for a keyless OpenAI-compatible endpoint', async () => {
    let chatAuthorization: string | null | undefined;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = request?.url ?? String(input);
      const headers = new Headers(request?.headers ?? init?.headers);
      if (url.endsWith('/chat/completions')) {
        chatAuthorization = headers.get('authorization');
        return new Response(
          ['data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'].join(
            '',
          ),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = new CustomProvider({
      name: 'custom:keyless',
      custom: true,
      kind: 'openai',
      label: 'Keyless',
      baseUrl: 'http://localhost:1234/v1',
      disabled: false,
      models: ['local-model'],
    });
    for await (const _event of provider.streamResponse({
      model: 'local-model',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      // Drain the real SDK stream so the captured request is authoritative.
    }

    expect(chatAuthorization).toBeNull();
  });

  test('uses Bearer auth at Anthropic runtime when the catalog accepted an auth token', async () => {
    let messageAuthorization: string | null | undefined;
    let messageApiKey: string | null | undefined;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = request?.url ?? String(input);
      const headers = new Headers(request?.headers ?? init?.headers);
      if (url.endsWith('/messages')) {
        messageAuthorization = headers.get('authorization');
        messageApiKey = headers.get('x-api-key');
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: 'claude-custom' }], has_more: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const provider = new CustomProvider({
      name: 'custom:anthropic-token',
      custom: true,
      kind: 'anthropic',
      label: 'Anthropic token gateway',
      baseUrl: 'https://anthropic-gateway.example/v1',
      authToken: 'oauth-token',
      disabled: false,
      models: ['claude-custom'],
    });
    for await (const _event of provider.streamResponse({
      model: 'claude-custom',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      // Drain the SDK stream so request headers are captured from the runtime path.
    }

    expect(messageAuthorization).toBe('Bearer oauth-token');
    expect(messageApiKey).toBeNull();
  });

  test('rejects keyless Gemini configurations before a misleading catalog probe', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;

    const result = await probeCustomProvider({
      kind: 'gemini',
      baseUrl: 'https://gemini-gateway.example/v1beta',
    });

    expect(result).toMatchObject({ success: false, canSaveUnverified: false });
    expect(result.error).toContain('require an API key');
    expect(called).toBe(false);
  });

  test('keeps a legacy custom endpoint off the cold status path', async () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{"error":"Invalid token"}', { status: 401 });
    }) as typeof fetch;

    try {
      const config: KoryphaiosConfig = {
        server: { port: 3001, host: '127.0.0.1' },
        providers: {
          'custom:legacy-rejected': {
            name: 'custom:legacy-rejected',
            custom: true,
            kind: 'openai',
            label: 'Legacy rejected',
            baseUrl: 'https://gateway.example/v1',
            apiKey: 'bad-key',
            models: ['legacy-model'],
            disabled: false,
          },
        },
      };
      const registry = new ProviderRegistry(config);

      expect(
        registry.getStatus().find((item) => item.name === 'custom:legacy-rejected'),
      ).toMatchObject({
        connectionState: 'detected',
        models: ['legacy-model'],
      });
      await registry.autoConnectCliProviders(false);
      expect(requests).toBe(0);

      await registry.autoConnectCliProviders(true);
      expect(requests).toBe(1);
      expect(
        registry.getStatus().find((item) => item.name === 'custom:legacy-rejected'),
      ).toMatchObject({
        connectionState: 'failed',
      });
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  test('does not duplicate a failed custom-provider probe during catalog refresh', async () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    let requests = 0;
    let credentialAccepted = false;
    globalThis.fetch = (async () => {
      requests += 1;
      return credentialAccepted
        ? new Response(JSON.stringify({ data: [{ id: 'recovered-model' }] }), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('{"error":"Invalid token"}', { status: 401 });
    }) as typeof fetch;

    try {
      const registry = new ProviderRegistry();
      registry.registerCustomProvider({
        id: 'custom:rejected-refresh',
        label: 'Rejected refresh',
        kind: 'openai',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'bad-key',
      });

      expect(await registry.verifyConnection('custom:rejected-refresh')).toMatchObject({
        success: false,
      });
      expect(requests).toBe(1);

      await registry.refreshModelCatalogs();
      expect(requests).toBe(1);

      // A deliberate verification is not held behind the catalog guard.
      credentialAccepted = true;
      expect(await registry.verifyConnection('custom:rejected-refresh')).toMatchObject({
        success: true,
        state: 'detected',
      });
      expect(requests).toBe(2);
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  test('the background scheduler never targets a provider whose credential probe failed', async () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    globalThis.fetch = (async () =>
      new Response('{"error":"Invalid token"}', { status: 401 })) as typeof fetch;
    try {
      const registry = new ProviderRegistry();
      registry.registerCustomProvider({
        id: 'custom:rejected-target',
        label: 'Rejected target',
        kind: 'openai',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'bad-key',
      });
      expect(await registry.verifyConnection('custom:rejected-target')).toMatchObject({
        success: false,
      });

      const targets = registry.listModelCatalogRefreshTargets().map((p) => p.name);
      expect(targets).not.toContain('custom:rejected-target');
    } finally {
      globalThis.fetch = realFetch;
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  test('the background scheduler targets only enabled, available, refreshable providers', async () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    try {
      const registry = new ProviderRegistry();
      let refreshes = 0;
      registry.registerRemoteProvider({
        name: 'remote-scheduler-target',
        config: { name: 'remote-scheduler-target', disabled: false },
        isAvailable: () => true,
        listModels: () => [],
        refreshModels: async () => {
          refreshes += 1;
        },
        async *streamResponse() {},
      } as Provider);
      // A provider with no discovery hook serves a fixed list and must never be
      // polled by the scheduler.
      registry.registerRemoteProvider({
        name: 'remote-no-hook',
        config: { name: 'remote-no-hook', disabled: false },
        isAvailable: () => true,
        listModels: () => [],
        async *streamResponse() {},
      } as Provider);
      // A disabled provider is configuration metadata, not a refresh target.
      registry.registerRemoteProvider({
        name: 'remote-disabled',
        config: { name: 'remote-disabled', disabled: true },
        isAvailable: () => false,
        listModels: () => [],
        refreshModels: async () => {
          refreshes += 1;
        },
        async *streamResponse() {},
      } as Provider);

      const names = registry.listModelCatalogRefreshTargets().map((p) => p.name);
      expect(names).toContain('remote-scheduler-target');
      expect(names).not.toContain('remote-no-hook');
      expect(names).not.toContain('remote-disabled');

      await registry.refreshModelCatalog('remote-scheduler-target');
      expect(refreshes).toBe(1);
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });

  test('coalesces concurrent global catalog refreshes', async () => {
    const previousAutoDetect = process.env.KORY_DISABLE_CLI_AUTODETECT;
    process.env.KORY_DISABLE_CLI_AUTODETECT = '1';
    try {
      const registry = new ProviderRegistry();
      let refreshes = 0;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      registry.registerRemoteProvider({
        name: 'remote-refresh-dedupe',
        config: { name: 'remote-refresh-dedupe', disabled: false },
        isAvailable: () => true,
        listModels: () => [],
        refreshModels: async () => {
          refreshes += 1;
          await pending;
        },
        async *streamResponse() {},
      } as Provider);

      const first = registry.refreshModelCatalogs();
      const second = registry.refreshModelCatalogs();
      await Promise.resolve();
      expect(refreshes).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(refreshes).toBe(1);
    } finally {
      if (previousAutoDetect === undefined) delete process.env.KORY_DISABLE_CLI_AUTODETECT;
      else process.env.KORY_DISABLE_CLI_AUTODETECT = previousAutoDetect;
    }
  });
});
