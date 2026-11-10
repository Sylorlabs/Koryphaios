import { afterEach, describe, expect, test } from 'bun:test';

import {
  capabilityAdapterProviders,
  capabilityProvidersFor,
  getCapabilityAdapter,
  resolveCapabilityConfig,
} from '../registry';
import { providerErrorMessage, providerHttpError } from '../http';
import { decodeDataUrl, pollJob } from '../poll';
import { ValidationError } from '../../../errors/types';

// ─── Catalog shape ──────────────────────────────────────────────────────────

describe('capability adapter catalog', () => {
  test('registers exactly the audited non-chat providers', () => {
    expect(new Set(capabilityAdapterProviders())).toEqual(
      new Set(['luma', 'klingai', 'prodia', 'replicate', 'lmnt', 'voyageai', 'mem0', 'letta']),
    );
  });

  test('every adapter declares a non-chat capability set and a reachable default', () => {
    for (const provider of capabilityAdapterProviders()) {
      const adapter = getCapabilityAdapter(provider)!;
      expect(adapter.capabilities.length, provider).toBeGreaterThan(0);
      for (const capability of adapter.capabilities) {
        expect(capability, provider).not.toBe('chat');
      }
      expect(adapter.defaultBaseUrl, provider).toMatch(/^https:\/\//);
      expect(typeof adapter.verify, provider).toBe('function');
    }
  });

  test('models modalities to the providers that actually serve them', () => {
    expect(capabilityProvidersFor('video').sort()).toEqual([
      'klingai',
      'luma',
      'prodia',
      'replicate',
    ]);
    // LMNT is a dedicated speech API; Replicate serves speech through models.
    expect(capabilityProvidersFor('audio').sort()).toEqual(['lmnt', 'replicate']);
    expect(capabilityProvidersFor('embedding')).toEqual(['voyageai']);
    expect(capabilityProvidersFor('rerank')).toEqual(['voyageai']);
    expect(capabilityProvidersFor('memory').sort()).toEqual(['letta', 'mem0']);
    // No adapter here generates images through a chat contract.
    expect(capabilityProvidersFor('image').sort()).toEqual([
      'klingai',
      'luma',
      'prodia',
      'replicate',
    ]);
  });

  test('an adapter never claims a capability it does not implement', () => {
    for (const provider of capabilityAdapterProviders()) {
      const adapter = getCapabilityAdapter(provider)!;
      const claimsImageOrVideo = adapter.capabilities.some((c) => c === 'image' || c === 'video');
      expect(Boolean(adapter.generate), `${provider}.generate`).toBe(claimsImageOrVideo);
      if (adapter.capabilities.includes('audio')) {
        expect(Boolean(adapter.synthesize), `${provider}.synthesize`).toBe(true);
      }
      if (adapter.capabilities.includes('embedding')) {
        expect(Boolean(adapter.embed), `${provider}.embed`).toBe(true);
      }
      if (adapter.capabilities.includes('rerank')) {
        expect(Boolean(adapter.rerank), `${provider}.rerank`).toBe(true);
      }
      if (adapter.capabilities.includes('memory')) {
        expect(Boolean(adapter.memory), `${provider}.memory`).toBe(true);
      }
    }
  });

  test('no adapter exposes a chat adapter', () => {
    for (const provider of capabilityAdapterProviders()) {
      const adapter = getCapabilityAdapter(provider)!;
      expect(adapter.capabilities.includes('chat'), provider).toBe(false);
    }
  });
});

// ─── Config resolution ──────────────────────────────────────────────────────

describe('capability config resolution', () => {
  test('falls back to the provider catalog base URL when none is configured', () => {
    const adapter = getCapabilityAdapter('luma')!;
    const config = resolveCapabilityConfig(adapter, { apiKey: 'k' });
    expect(config.baseUrl).toBe('https://api.lumalabs.ai/dream-machine/v1');
  });

  test('honors a user-supplied endpoint so self-hosted deployments work', () => {
    const adapter = getCapabilityAdapter('replicate')!;
    const config = resolveCapabilityConfig(adapter, {
      apiKey: 'k',
      baseUrl: 'https://replicate.internal/v1/',
    });
    expect(config.baseUrl).toBe('https://replicate.internal/v1');
  });

  test('refuses to build a config without a credential', () => {
    const adapter = getCapabilityAdapter('lmnt')!;
    expect(() => resolveCapabilityConfig(adapter, {})).toThrow(/Connect lmnt/);
  });

  test('rejects a credential containing a header terminator', () => {
    const adapter = getCapabilityAdapter('lmnt')!;
    expect(() => resolveCapabilityConfig(adapter, { apiKey: 'abc\r\nX-Evil: 1' })).toThrow(
      ValidationError,
    );
  });

  test('accepts an auth token in place of an api key', () => {
    const adapter = getCapabilityAdapter('voyageai')!;
    const config = resolveCapabilityConfig(adapter, { authToken: 'tok' });
    expect(config.apiKey).toBe('tok');
  });
});

// ─── Error mapping ──────────────────────────────────────────────────────────

describe('provider error mapping', () => {
  test('reads the message out of each provider envelope shape', () => {
    expect(providerErrorMessage({ error: { message: 'bad key' } }, 'x')).toBe('bad key');
    expect(providerErrorMessage({ message: 'rate limited' }, 'x')).toBe('rate limited');
    expect(providerErrorMessage({ detail: 'quota gone' }, 'x')).toBe('quota gone');
    expect(providerErrorMessage({ error: 'flat string' }, 'x')).toBe('flat string');
    expect(providerErrorMessage({ errors: [{ detail: 'nested detail' }] }, 'x')).toBe(
      'nested detail',
    );
    expect(providerErrorMessage({ nothing: 1 }, 'fallback')).toBe('fallback');
  });

  test('never surfaces an HTML error page as a message', () => {
    expect(providerErrorMessage('<!DOCTYPE html><html>nope</html>', 'fallback')).toBe('fallback');
  });

  test('maps 429 to a rate-limit error and 402/403 to a billing error', () => {
    const limited = providerHttpError('Luma', 429, { detail: 'slow down' }, 12);
    expect(limited.name).toBe('ProviderRateLimitError');
    expect(limited.message).toContain('Luma');
    expect(limited.message).toContain('slow down');

    const unpaid = providerHttpError('Kling', 402, { detail: 'no credits' });
    expect(unpaid).toBeInstanceOf(ValidationError);
    expect(unpaid.message).toContain('billing or access');
  });
});

// ─── Async job polling ──────────────────────────────────────────────────────

describe('async job polling', () => {
  afterEach(() => {
    // Nothing global to reset; each test builds its own signal.
  });

  test('polls until the provider reports completion', async () => {
    const states = ['dreaming', 'dreaming', 'completed'];
    let index = 0;
    const result = await pollJob<string>({
      provider: 'Luma',
      signal: AbortSignal.timeout(10_000),
      timeoutMs: 10_000,
      intervalMs: 1,
      maxIntervalMs: 2,
      status: async () => states[index++]!,
      interpret: (state) =>
        state === 'completed'
          ? { kind: 'completed' }
          : state === 'failed'
            ? { kind: 'failed', reason: 'x' }
            : { kind: 'pending' },
    });
    expect(result).toBe('completed');
    expect(index).toBe(3);
  });

  test('raises a provider-specific failure instead of timing out', async () => {
    await expect(
      pollJob<string>({
        provider: 'Kling',
        signal: AbortSignal.timeout(10_000),
        timeoutMs: 10_000,
        intervalMs: 1,
        status: async () => 'failed',
        interpret: () => ({ kind: 'failed', reason: 'content risk control' }),
      }),
    ).rejects.toThrow(/content risk control/);
  });

  test('gives up at the deadline rather than polling forever', async () => {
    await expect(
      pollJob<string>({
        provider: 'Replicate',
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 60,
        intervalMs: 1,
        status: async () => 'processing',
        interpret: () => ({ kind: 'pending' }),
      }),
    ).rejects.toThrow(/did not finish generating within/);
  });

  test('propagates caller cancellation without waiting out the deadline', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      pollJob<string>({
        provider: 'Luma',
        signal: controller.signal,
        timeoutMs: 60_000,
        intervalMs: 5,
        status: async () => 'dreaming',
        interpret: () => ({ kind: 'pending' }),
      }),
    ).rejects.toThrow();
  });
});

// ─── Inline asset decoding ──────────────────────────────────────────────────

describe('inline asset decoding', () => {
  test('decodes a data URL into base64 and a mime type', () => {
    expect(decodeDataUrl('data:image/png;base64,AAAB')).toEqual({
      mimeType: 'image/png',
      base64: 'AAAB',
    });
  });

  test('returns undefined for an ordinary URL', () => {
    expect(decodeDataUrl('https://cdn.example/clip.mp4')).toBeUndefined();
  });
});

// ─── Per-provider contract details ──────────────────────────────────────────

describe('provider request contracts', () => {
  const config = {
    baseUrl: 'https://example.test',
    apiKey: 'k',
    headers: {},
    endpointAuthOnly: false,
  };

  async function capture(
    provider: string,
    capability: 'image' | 'video',
    respond: (url: string, init?: RequestInit) => Response,
    extras: Record<string, unknown> = {},
  ): Promise<{ url: string; init: RequestInit | undefined }> {
    const adapter = getCapabilityAdapter(provider)!;
    let seen: { url: string; init: RequestInit | undefined } = { url: '', init: undefined };
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url: String(url), init };
      return respond(String(url), init);
    }) as unknown as typeof fetch;
    try {
      await adapter.generate!({
        config,
        capability,
        model:
          provider === 'replicate' ? 'owner/name' : provider === 'prodia' ? 'flux-2.klein' : 'x',
        prompt: 'a test prompt',
        options: {},
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 5_000,
        ...extras,
      });
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  }

  test('LMNT authenticates with X-API-Key and a version pin, not a bearer token', async () => {
    const lmnt = getCapabilityAdapter('lmnt')!;
    const original = globalThis.fetch;
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await lmnt.synthesize!({
        config,
        model: 'blizzard',
        text: 'hello',
        voice: 'leah',
        signal: AbortSignal.timeout(5_000),
      });
      expect(result.capability).toBe('audio');
      expect(result.mimeType).toBe('audio/mpeg');
    } finally {
      globalThis.fetch = original;
    }
    expect(headers['X-API-Key']).toBe('k');
    expect(headers['lmnt-version']).toBeTruthy();
    expect(headers.Authorization).toBeUndefined();
  });

  test('LMNT refuses text above its documented 5,000-character limit', async () => {
    const lmnt = getCapabilityAdapter('lmnt')!;
    await expect(
      lmnt.synthesize!({
        config,
        model: 'blizzard',
        text: 'x'.repeat(5001),
        voice: 'leah',
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow(/5,000 characters/);
  });

  test('Mem0 nests entity ids inside filters, as its v3 search requires', async () => {
    const mem0 = getCapabilityAdapter('mem0')!;
    const original = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ results: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      await mem0.memory!.search(config, { query: 'q', scope: 'alice' });
    } finally {
      globalThis.fetch = original;
    }
    // v3 rejects top-level entity ids with a 400.
    expect(body.user_id).toBeUndefined();
    expect(JSON.stringify(body.filters)).toContain('alice');
  });

  test('Letta requires an agent id rather than creating one as a side effect', async () => {
    const letta = getCapabilityAdapter('letta')!;
    await expect(letta.memory!.search(config, { query: 'q' })).rejects.toThrow(
      /needs a Letta agent id/,
    );
  });

  test('Voyage restores the caller input order using the returned index', async () => {
    const voyage = getCapabilityAdapter('voyageai')!;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          // Returned deliberately out of order.
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const vectors = await voyage.embed!({
        config,
        model: 'voyage-3.5-lite',
        inputs: ['first', 'second'],
        signal: AbortSignal.timeout(5_000),
      });
      expect(vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('Voyage rejects an embedding count that does not match the input count', async () => {
    const voyage = getCapabilityAdapter('voyageai')!;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await expect(
        voyage.embed!({
          config,
          model: 'voyage-3.5-lite',
          inputs: ['a', 'b'],
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toThrow(/different number of embeddings/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('Replicate rejects a model reference that is not owner/name', async () => {
    await expect(
      capture('replicate', 'image', () => new Response('{}'), {
        model: 'not-a-valid-reference',
      }),
    ).rejects.toThrow(/owner\/name/);
  });

  test('Replicate forwards selected video resolution and synchronized audio', async () => {
    const seen = await capture(
      'replicate',
      'video',
      () =>
        Response.json({
          id: 'clip-1',
          status: 'succeeded',
          output: 'data:video/mp4;base64,Y2xpcA==',
        }),
      { options: { resolution: '720p', sound: true, duration: '5s', aspectRatio: '16:9' } },
    );
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      input: {
        prompt: 'a test prompt',
        resolution: '720p',
        generate_audio: true,
        duration: '5s',
        aspect_ratio: '16:9',
      },
    });
  });

  test('Kling posts to the Singapore host by default', () => {
    expect(getCapabilityAdapter('klingai')!.defaultBaseUrl).toBe(
      'https://api-singapore.klingai.com',
    );
  });

  test('Kling surfaces the provider envelope error even on HTTP 200', async () => {
    const adapter = getCapabilityAdapter('klingai')!;
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 4001, message: 'insufficient credits' }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await expect(
        adapter.generate!({
          config,
          capability: 'video',
          model: 'kling-v2-6',
          prompt: 'p',
          options: {},
          signal: AbortSignal.timeout(5_000),
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/insufficient credits/);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('Prodia asks for the finished asset directly instead of polling', async () => {
    const adapter = getCapabilityAdapter('prodia')!;
    const original = globalThis.fetch;
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(new Uint8Array([9, 9]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await adapter.generate!({
        config,
        capability: 'image',
        model: 'flux-2.klein',
        prompt: 'p',
        options: {},
        signal: AbortSignal.timeout(5_000),
        timeoutMs: 5_000,
      });
      expect(result.capability).toBe('image');
      expect(result.mimeType).toBe('image/jpeg');
    } finally {
      globalThis.fetch = original;
    }
    expect(headers.Accept).toBe('image/jpeg');
    expect(headers.Authorization).toBe('Bearer k');
  });

  test('media adapters refuse image-to-video from a local file they cannot host', async () => {
    for (const provider of ['klingai', 'luma'] as const) {
      const adapter = getCapabilityAdapter(provider)!;
      await expect(
        adapter.generate!({
          config,
          capability: 'video',
          model: provider === 'luma' ? 'ray-2' : 'kling-v2-6',
          prompt: 'p',
          options: {},
          signal: AbortSignal.timeout(5_000),
          timeoutMs: 5_000,
          sourceImage: { base64: 'AAAA', mimeType: 'image/png' },
        }),
      ).rejects.toThrow(/publicly reachable|hosted first frame/i);
    }
  });
});
