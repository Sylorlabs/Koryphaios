import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingClient } from './semantic-embeddings';
import { retrieveMemory } from './semantic-retrieval';
import { searchMemory, writeProjectMemory, saveMemorySettings } from './unified-memory';

function mockClient(model = 'retrieval') {
  const calls: string[][] = [];
  const client = new EmbeddingClient(
    { endpoint: 'https://embedding.example/embeddings', model, apiKey: 'test', dimensions: 2 },
    async (_, init) => {
      const inputs = JSON.parse(init.body as string).input as string[];
      calls.push(inputs);
      return Response.json({
        data: inputs.map((text, index) => ({
          index,
          embedding: /automobile|vehicle|car/.test(text) ? [1, 0] : [0, 1],
        })),
      });
    },
  );
  return { client, calls };
}

describe('memory retrieval', () => {
  test('finds semantic matches without lexical overlap; edits, deletions, scope and model invalidate cache', async () => {
    const { client, calls } = mockClient();
    const scope = crypto.randomUUID();
    const docs = [
      { id: 'car', content: 'automobile' },
      { id: 'fruit', content: 'banana' },
    ];
    expect((await retrieveMemory(scope, docs, 'vehicle', { client })).hits[0].id).toBe('car');
    await retrieveMemory(scope, docs, 'vehicle', { client });
    expect(calls).toHaveLength(3); // initial document batch + two queries
    docs[0].content = 'vehicle modified';
    await retrieveMemory(scope, docs, 'vehicle', { client });
    expect(calls[3]).toEqual(['vehicle modified']);
    const removed = await retrieveMemory(scope, [docs[1]], 'vehicle', { client });
    expect(removed.hits.map((hit) => hit.id)).toEqual(['fruit']);
    const other = mockClient('new-model');
    await retrieveMemory(scope, docs, 'vehicle', { client: other.client });
    expect(other.calls[0]).toHaveLength(2);
    await retrieveMemory(scope + '-other-project', docs, 'vehicle', { client: other.client });
    expect(other.calls[2]).toHaveLength(2);
  });
  test('disabled and failed retrieval report local lexical fallback', async () => {
    const docs = [{ id: 'a', content: 'local banana' }];
    expect(await retrieveMemory('disabled', docs, 'banana', { client: null })).toMatchObject({
      mode: 'lexical',
      reason: 'disabled',
      hits: [{ id: 'a' }],
    });
    const client = new EmbeddingClient(
      {
        endpoint: 'https://embedding.example/embeddings',
        model: 'bad',
        apiKey: 'test',
        dimensions: 2,
      },
      async () => Response.json({ data: [{ index: 0, embedding: [1] }] }),
    );
    expect(await retrieveMemory('bad', docs, 'banana', { client })).toMatchObject({
      mode: 'lexical',
      reason: 'unavailable',
      hits: [{ id: 'a' }],
    });
    expect(
      (
        await retrieveMemory('bounded', [{ id: 'huge', content: 'x'.repeat(600000) }], 'x', {
          client: null,
        })
      ).truncated,
    ).toBe(true);
  });
  test('one deadline bounds all batches and cancels the in-flight transport', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const client = new EmbeddingClient(
      {
        endpoint: 'https://embedding.example/embeddings',
        model: 'deadline',
        apiKey: 'test',
        dimensions: 2,
        timeoutMs: 1000,
      },
      async (_, init) => {
        calls++;
        signals.push(init.signal as AbortSignal);
        const texts = JSON.parse(init.body as string).input as string[];
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ data: texts.map((_, index) => ({ index, embedding: [1, 0] })) });
      },
    );
    const result = await retrieveMemory(
      crypto.randomUUID(),
      Array.from({ length: 256 }, (_, i) => ({ id: String(i), content: `document ${i}` })),
      'document',
      { client, timeoutMs: 30 },
    );
    expect(result).toMatchObject({ mode: 'lexical', reason: 'unavailable' });
    expect(calls).toBeLessThan(5);
    expect(signals.some((signal) => signal.aborted)).toBe(true);
  });
  test('active unified memory reads current files and respects disabled scopes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'semantic-memory-'));
    try {
      const { client, calls } = mockClient('unified');
      saveMemorySettings(root, { universalMemoryEnabled: false, sessionMemoryEnabled: false });
      writeProjectMemory(root, 'automobile');
      const result = await searchMemory(root, null, 'vehicle', { client });
      expect(result.mode).toBe('semantic');
      expect(result.hits[0].content).toBe('automobile');
      saveMemorySettings(root, { projectMemoryEnabled: false });
      const count = calls.length;
      expect((await searchMemory(root, null, 'vehicle', { client })).hits).toEqual([]);
      expect(calls.length).toBe(count);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
