import { afterEach, describe, expect, test } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

delete process.env.KORY_EMBEDDINGS_ENABLED;
delete process.env.KORY_EMBEDDINGS_PROVIDER;

const { setContext } = await import('../../context');

function setConfigs(configs: Record<string, unknown>): void {
  setContext({ providers: { getConfigs: () => configs } } as never);
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Reply with `dimensions`-wide vectors, echoing what Voyage would return. */
function stubVoyage(dimensions: number, capture?: (body: Record<string, unknown>) => void) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') capture?.(JSON.parse(init.body));
    const embedding = Array.from({ length: dimensions }, (_, i) => (i + 1) / dimensions);
    return new Response(
      JSON.stringify({
        data: [
          { index: 0, embedding },
          { index: 1, embedding: embedding.map((v) => -v) },
        ],
        model: 'voyage-3.5-lite',
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('Voyage-backed semantic embeddings', () => {
  test('is unavailable until Voyage is connected', async () => {
    const { voyageEmbeddingClient, configuredEmbeddingClient } =
      await import('../semantic-embeddings');
    setConfigs({});
    expect(voyageEmbeddingClient()).toBeNull();
    expect(configuredEmbeddingClient()).toBeNull();
  });

  test('a connected key alone is not enough to send content to Voyage', async () => {
    // Semantic retrieval forwards memory documents, note content, and user
    // queries to the embedding provider. A saved credential must not silently
    // opt the user into a paid third-party service.
    const { configuredEmbeddingClient, voyageEmbeddingClient } =
      await import('../semantic-embeddings');
    setConfigs({ voyageai: { apiKey: 'configured' } });
    expect(voyageEmbeddingClient()).toBeNull();
    expect(configuredEmbeddingClient()).toBeNull();
  });

  test('an explicit opt-in plus a connected key enables it', async () => {
    const { voyageEmbeddingClient } = await import('../semantic-embeddings');
    process.env.KORY_EMBEDDINGS_PROVIDER = 'voyageai';
    try {
      setConfigs({ voyageai: { apiKey: 'configured-key' } });
      expect(voyageEmbeddingClient()).not.toBeNull();
    } finally {
      delete process.env.KORY_EMBEDDINGS_PROVIDER;
    }
  });

  test('produces vectors through the adapter when Voyage is connected', async () => {
    process.env.KORY_EMBEDDINGS_PROVIDER = 'voyageai';
    const { voyageEmbeddingClient } = await import('../semantic-embeddings');
    setConfigs({ voyageai: { apiKey: 'configured-key' } });
    const client = voyageEmbeddingClient();
    expect(client).not.toBeNull();
    process.env.KORY_EMBEDDINGS_PROVIDER = 'other';
    let sent: Record<string, unknown> = {};
    stubVoyage(1024, (body) => (sent = body));
    const vectors = await client!.embed(['alpha', 'beta']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1024);
    expect(vectors[0]?.[0]).toBeCloseTo(1 / 1024);
    // Voyage changes retrieval quality by role, so the adapter must forward it.
    expect(sent.input_type).toBe('document');
    expect(sent.input).toEqual(['alpha', 'beta']);
  });

  test('rejects a dimension the model did not return instead of storing a wrong width', async () => {
    // Silently accepting a different width would poison every cached vector and
    // make cosine similarity meaningless, so this has to fail loudly.
    process.env.KORY_EMBEDDINGS_PROVIDER = 'voyageai';
    const { voyageEmbeddingClient } = await import('../semantic-embeddings');
    setConfigs({ voyageai: { apiKey: 'configured-key' } });
    const client = voyageEmbeddingClient();
    process.env.KORY_EMBEDDINGS_PROVIDER = 'other';
    stubVoyage(256);
    await expect(client!.embed(['alpha', 'beta'])).rejects.toThrow(/Embedding response error/);
  });

  test('rerank returns null rather than failing when Voyage is absent', async () => {
    const { rerankWithVoyage } = await import('../semantic-embeddings');
    setConfigs({});
    expect(await rerankWithVoyage('q', ['a', 'b'])).toBeNull();
  });

  test('rerank orders by relevance score', async () => {
    const { rerankWithVoyage } = await import('../semantic-embeddings');
    setConfigs({ voyageai: { apiKey: 'configured-key' } });
    globalThis.fetch = (async () =>
      new Response(
        // Returned unsorted on purpose.
        JSON.stringify({
          data: [
            { index: 2, relevance_score: 0.4 },
            { index: 0, relevance_score: 0.9 },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const ranked = await rerankWithVoyage('q', ['a', 'b', 'c']);
    expect(ranked?.map((entry) => entry.index)).toEqual([0, 2]);
  });
});
