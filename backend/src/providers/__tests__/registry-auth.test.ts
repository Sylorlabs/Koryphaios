import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { ProviderRegistry } from '../registry';

const mockConfig: KoryphaiosConfig = {
  server: { port: 3001, host: '127.0.0.1' },
};

describe('ProviderRegistry credential verification', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects invalid OpenAI credentials instead of marking the provider authenticated', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
    ) as typeof fetch;

    const registry = new ProviderRegistry(mockConfig);
    const result = await registry.setCredentials('openai', { apiKey: 'asdfasdfasdf' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(registry.getStatus().find((provider) => provider.name === 'openai')?.authenticated).toBe(
      false,
    );
  });

  it('preserves the last working provider config when a replacement key fails verification', async () => {
    let openAiRequests = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.openai.com')) {
        openAiRequests += 1;
        return Promise.resolve(
          openAiRequests === 1
            ? new Response(JSON.stringify({ data: [{ id: 'synthetic-chat-model' }] }), {
                status: 200,
              })
            : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    const registry = new ProviderRegistry(mockConfig);

    const first = await registry.setCredentials('openai', { apiKey: 'sk-working' });
    expect(first.success).toBe(true);
    expect(registry.getStatus().find((provider) => provider.name === 'openai')?.authenticated).toBe(
      true,
    );

    const second = await registry.setCredentials('openai', { apiKey: 'sk-bad' });
    expect(second.success).toBe(false);
    expect(registry.getStatus().find((provider) => provider.name === 'openai')?.authenticated).toBe(
      true,
    );
  });

  it("accepts a Poe API key and verifies it against Poe's public API gateway", async () => {
    let requestUrl = '';
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      requestUrl = String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'synthetic-poe-model' }] }), { status: 200 }),
      );
    }) as typeof fetch;

    const registry = new ProviderRegistry(mockConfig);
    const result = await registry.setCredentials('poe', { apiKey: 'poe-test-key' });

    expect(result.success).toBe(true);
    expect(requestUrl).toBe('https://api.poe.com/v1/models');
    const status = registry.getStatus().find((provider) => provider.name === 'poe');
    expect(status).toMatchObject({ supportsApiKey: true, enabled: true, authenticated: true });
  });

  it('verifies Vertex AI through authenticated countTokens rather than key presence', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ totalTokens: 4, totalBillableCharacters: 29 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    const registry = new ProviderRegistry(mockConfig);
    const result = await registry.setCredentials('vertexai', { apiKey: 'vertex-live-key' });

    expect(result.success).toBe(true);
    expect(requestUrl).toBe(
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:countTokens',
    );
    expect(requestInit?.method).toBe('POST');
    expect(new Headers(requestInit?.headers).get('x-goog-api-key')).toBe('vertex-live-key');
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Koryphaios connection check' }] }],
    });
    expect(registry.getStatus().find((provider) => provider.name === 'vertexai')).toMatchObject({
      enabled: true,
      authenticated: true,
      supportsApiKey: true,
      authMode: 'api_key',
    });
  });

  it('keeps Vertex AI disconnected when the credential probe fails or lies', async () => {
    const registry = new ProviderRegistry(mockConfig);

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 401 }),
      ),
    ) as typeof fetch;
    const rejected = await registry.setCredentials('vertexai', { apiKey: 'vertex-bad-key' });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('HTTP 401');
    expect(
      registry.getStatus().find((provider) => provider.name === 'vertexai')?.authenticated,
    ).toBe(false);

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: 'ok-but-not-vertex-metadata' }), { status: 200 }),
      ),
    ) as typeof fetch;
    const malformed = await registry.setCredentials('vertexai', { apiKey: 'vertex-fake-200' });
    expect(malformed.success).toBe(false);
    expect(malformed.error).toContain('invalid countTokens response');
    expect(
      registry.getStatus().find((provider) => provider.name === 'vertexai')?.authenticated,
    ).toBe(false);
  });
});
