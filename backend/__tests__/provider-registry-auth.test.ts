import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import { ProviderRegistry } from '../src/providers/registry';

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
            ? new Response(JSON.stringify({ data: [] }), { status: 200 })
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
});
