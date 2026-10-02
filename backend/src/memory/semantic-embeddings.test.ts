import { describe, expect, test } from 'bun:test';
import {
  EmbeddingClient,
  embeddingConfigFromEnv,
  cosineSimilarity,
  validateVector,
  MAX_EMBEDDING_RESPONSE_BYTES,
} from './semantic-embeddings';
import { processEmbeddingJob } from '../queue/workers/embedding-worker';

const config = {
  endpoint: 'https://embedding.example/v1/embeddings',
  model: 'test-model',
  apiKey: 'secret-test',
  dimensions: 2,
};

describe('authenticated opt-in embeddings', () => {
  test('disabled by default and does not infer endpoints or credentials', () => {
    expect(embeddingConfigFromEnv({ OPENAI_API_KEY: 'unused' })).toBeNull();
    expect(() => embeddingConfigFromEnv({ KORY_EMBEDDINGS_ENABLED: '1' })).toThrow('configuration');
    expect(
      embeddingConfigFromEnv({
        KORY_EMBEDDINGS_ENABLED: '1',
        KORY_EMBEDDING_ENDPOINT: config.endpoint,
        KORY_EMBEDDING_MODEL: 'test-model',
        KORY_EMBEDDING_DIMENSIONS: '2',
        KORY_EMBEDDING_API_KEY_ENV: 'OPENAI_API_KEY',
        OPENAI_API_KEY: 'reused',
      })?.apiKey,
    ).toBe('reused');
  });
  test('authenticates, forbids redirects, restores response index order and returns real vectors', async () => {
    const client = new EmbeddingClient(config, async (url, init) => {
      expect(url).toBe(config.endpoint);
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-test');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'test-model',
        input: ['one', 'two'],
        encoding_format: 'float',
      });
      return Response.json({
        data: [
          { index: 1, embedding: [0, 3] },
          { index: 0, embedding: [2, 0] },
        ],
      });
    });
    expect(await client.embed(['one', 'two'])).toEqual([
      [2, 0],
      [0, 3],
    ]);
  });
  test('validates vectors and computes actual cosine for unnormalized values', () => {
    for (const value of [[], [0, 0], [1, NaN], [1, Infinity], ['1', 0], [1]]) {
      expect(() => validateVector(value, 2)).toThrow();
    }
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([1e308, 1e308], [-1e308, -1e308])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [0, 2])).toBe(0);
  });
  test('rejects wrong dimensions, duplicate indexes and bad JSON without leaking provider details', async () => {
    for (const body of [
      { data: [{ index: 0, embedding: [1] }] },
      { data: [] },
      { data: [{ index: 8, embedding: [1, 2] }] },
      { data: [{ index: 0, embedding: [0, 0] }] },
    ]) {
      await expect(
        new EmbeddingClient(config, async () => Response.json(body)).embed(['one']),
      ).rejects.toThrow('response');
    }
    await expect(
      new EmbeddingClient(config, async () =>
        Response.json({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 0, embedding: [0, 1] },
          ],
        }),
      ).embed(['one', 'two']),
    ).rejects.toThrow('response');
    await expect(
      new EmbeddingClient(config, async () => {
        throw new Error('secret-test private input');
      }).embed(['one']),
    ).rejects.toThrow('Embedding transport error');
    await expect(
      new EmbeddingClient(config, async () => new Response('secret-test', { status: 401 })).embed([
        'one',
      ]),
    ).rejects.toThrow('Embedding transport error');
  });
  test('timeout aborts a transport that ignores cancellation and bounds body reads', async () => {
    let signal: AbortSignal | undefined;
    const client = new EmbeddingClient({ ...config, timeoutMs: 5 }, async (_, init) => {
      signal = init.signal as AbortSignal;
      return new Response(new ReadableStream({ start() {} }));
    });
    await expect(client.embed(['one'])).rejects.toThrow('transport');
    expect(signal?.aborted).toBe(true);
  });
  test('rejects unsafe configuration and blank or oversized inputs before transport', async () => {
    for (const endpoint of [
      'http://embedding.example/embeddings',
      'https://user:secret@example.com/embeddings',
      'https://example.com?api_key=secret',
    ]) {
      expect(() => new EmbeddingClient({ ...config, endpoint })).toThrow('configuration');
    }
    const client = new EmbeddingClient(config, async () => {
      throw new Error('must not call');
    });
    for (const input of [[], [' '], ['a'.repeat(16001)]])
      await expect(client.embed(input)).rejects.toThrow('input');
  });
  test('caller abort reaches transport and already-aborted input never sends', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    let calls = 0;
    const client = new EmbeddingClient(config, async (_, init) => {
      calls++;
      seen = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const pending = client.embed(['one'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(seen?.aborted).toBe(true);
    await expect(client.embed(['one'], { signal: controller.signal })).rejects.toThrow('aborted');
    expect(calls).toBe(1);
  });
  test('limits streamed and declared response bytes before parsing JSON', async () => {
    let canceled = false;
    const client = new EmbeddingClient(
      config,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_EMBEDDING_RESPONSE_BYTES));
              controller.enqueue(new Uint8Array(1));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    );
    await expect(client.embed(['one'])).rejects.toThrow('response');
    expect(canceled).toBe(true);
    const declared = new EmbeddingClient(
      config,
      async () =>
        new Response('{}', {
          headers: { 'Content-Length': String(MAX_EMBEDDING_RESPONSE_BYTES + 1) },
        }),
    );
    await expect(declared.embed(['one'])).rejects.toThrow('response');
  });
  test('credential rotation changes opaque cache identity', () => {
    const first = new EmbeddingClient(config);
    const rotated = new EmbeddingClient({ ...config, apiKey: 'rotated-secret' });
    expect(first.identity).not.toBe(rotated.identity);
    expect(first.identity).not.toContain(config.apiKey);
  });
  test('worker produces validated vectors and explicitly reports disabled/error states', async () => {
    const job = {
      data: { content: 'one', contentId: 'one', contentType: 'text' as const },
      updateProgress: async () => {},
    };
    expect(await processEmbeddingJob(job, null)).toMatchObject({ success: false, isStub: true });
    const client = new EmbeddingClient(config, async () =>
      Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
    );
    expect(await processEmbeddingJob(job, client)).toMatchObject({
      success: true,
      isStub: false,
      embedding: [1, 2],
      dimensions: 2,
    });
    const failed = new EmbeddingClient(config, async () => {
      throw new Error('secret-test');
    });
    expect(await processEmbeddingJob(job, failed)).toEqual({
      success: false,
      isStub: false,
      error: 'Embedding transport error',
    });
  });
});
