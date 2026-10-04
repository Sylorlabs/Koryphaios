import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import { resolveProjectIdentity } from '../../runtime/request-project';
import { NOTE_CONTEXT_LIMITS, retrieveNoteContext } from '../note-context';
import { createNote, linkNotes, trashNote, updateNote } from '../notes-service';
import { saveNotesAgentPermissions } from '../notes-settings';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { rebuildNoteSemanticIndex } from '../note-semantic-index';

let root: string;
let foreignRoot: string;
const originalFetch = globalThis.fetch;
const envNames = [
  'KORY_EMBEDDINGS_ENABLED',
  'KORY_EMBEDDING_ENDPOINT',
  'KORY_EMBEDDING_MODEL',
  'KORY_EMBEDDING_DIMENSIONS',
  'KORY_EMBEDDING_API_KEY',
  'KORY_EMBEDDING_TIMEOUT_MS',
];
let savedEnv: Record<string, string | undefined>;
beforeAll(async () => {
  await initDb();
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-context-retrieval-'));
  foreignRoot = mkdtempSync(join(tmpdir(), 'kory-context-foreign-'));
  savedEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  delete process.env.KORY_EMBEDDINGS_ENABLED;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envNames) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(foreignRoot, { recursive: true, force: true });
});
function enableEmbeddings() {
  Object.assign(process.env, {
    KORY_EMBEDDINGS_ENABLED: '1',
    KORY_EMBEDDING_ENDPOINT: 'https://embedding.example/embeddings',
    KORY_EMBEDDING_MODEL: 'note-context-test',
    KORY_EMBEDDING_DIMENSIONS: '2',
    KORY_EMBEDDING_API_KEY: 'fixture-only',
    KORY_EMBEDDING_TIMEOUT_MS: '100',
  });
}
function embeddingResponse(init?: RequestInit) {
  const texts = JSON.parse(init!.body as string).input as string[];
  return Response.json({
    data: texts.map((text, index) => ({
      index,
      embedding: /automobile|vehicle/.test(text) ? [1, 0] : [0, 1],
    })),
  });
}
function snapshot() {
  const database = getDb();
  const scope = resolveProjectIdentity(root);
  return [
    database.query('SELECT * FROM notes WHERE project_root = ? ORDER BY id').all(scope),
    ...['note_links', 'note_relationships'].map((table) =>
      database
        .query(
          `SELECT e.* FROM ${table} e JOIN notes n ON n.id = e.from_note_id WHERE n.project_root = ? ORDER BY e.from_note_id, e.to_note_id`,
        )
        .all(scope),
    ),
    database
      .query(
        'SELECT r.* FROM note_revisions r JOIN notes n ON n.id = r.note_id WHERE n.project_root = ? ORDER BY r.note_id, r.revision',
      )
      .all(scope),
  ];
}

describe('bounded explainable associative note context', () => {
  test('ranks direct evidence above graph neighbors, explains paths, and never promotes co-retrieval into edges', async () => {
    const seed = await createNote(
      { title: 'quasar implementation', content: 'quasar exact evidence' },
      root,
    );
    const neighbor = await createNote(
      { title: 'Follow-up', content: 'Related design constraints without the search term' },
      root,
    );
    const incoming = await createNote(
      { title: 'Prior decision', content: 'Historic rationale' },
      root,
    );
    const distant = await createNote(
      { title: 'Second-order evidence', content: 'A longer reasoning chain' },
      root,
    );
    const other = await createNote(
      { title: 'quasar alternative', content: 'quasar independent match' },
      root,
    );
    await linkNotes(seed.id, neighbor.id, { syncContent: false }, root);
    await linkNotes(incoming.id, seed.id, { syncContent: false }, root);
    await linkNotes(neighbor.id, distant.id, { syncContent: false }, root);
    await linkNotes(distant.id, seed.id, { syncContent: false }, root);
    writeFileSync(
      join(root, 'not-yet-indexed.md'),
      '# quasar\n\nRetrieval must not import this file.',
    );
    const before = snapshot();
    expect(before[0]).toHaveLength(5);
    const input = { query: 'quasar', seedIds: [seed.id], maxHops: 2, limit: 12, semantic: false };
    const result = await retrieveNoteContext(input, root);
    expect(result.results[0]?.id).toBe(seed.id);
    expect(result.results.map((note) => note.id)).toContain(other.id);
    expect(new Set(result.results.map((note) => note.id)).size).toBe(result.results.length);
    const related = result.results.find((note) => note.id === neighbor.id)!;
    expect(related.sources).toContain('graph');
    expect(related.seedId).toBe(seed.id);
    expect(related.path).toContainEqual(
      expect.objectContaining({
        fromId: seed.id,
        toId: neighbor.id,
        direction: 'outgoing',
        kind: 'association',
      }),
    );
    expect(related.explanation).toContain(seed.id);
    expect(related.score).toBeLessThan(result.results[0]!.score);
    const prior = result.results.find((note) => note.id === incoming.id)!;
    expect(prior.path).toContainEqual(
      expect.objectContaining({ fromId: incoming.id, toId: seed.id, direction: 'incoming' }),
    );
    expect(
      related.path.every(
        (edge) =>
          edge.fromRevision >= 1 && edge.toRevision >= 1 && typeof edge.provenance === 'string',
      ),
    ).toBe(true);
    expect(result.retrieval.exhaustive).toBe(false);
    expect(result.retrieval.index).toBe('stored_snapshot');
    expect(await retrieveNoteContext(input, root)).toEqual(result);
    expect(snapshot()).toEqual(before);
    expect(result.results.some((note) => note.excerpt.includes('Retrieval must not import'))).toBe(
      false,
    );
  });

  test('bounds excerpts and serialized output, reports truncation, and finds a match deep inside long content', async () => {
    const deep = await createNote(
      {
        title: 'Long record',
        content: `${'padding '.repeat(3000)}quasar critical evidence ${'trailing '.repeat(3000)}`,
      },
      root,
    );
    for (let i = 0; i < 15; i++)
      await createNote(
        { title: `quasar record ${i}`, content: 'quasar evidence '.repeat(80) },
        root,
      );
    const result = await retrieveNoteContext(
      {
        query: 'quasar',
        seedIds: [deep.id],
        maxChars: 256,
        excerptChars: 128,
        limit: 12,
        semantic: false,
      },
      root,
    );
    expect(result.results[0]?.id).toBe(deep.id);
    expect(result.results[0]?.excerpt).toContain('quasar critical evidence');
    expect(result.results.every((note) => note.excerpt.length <= 128)).toBe(true);
    const chars = result.results.reduce((sum, note) => sum + note.excerpt.length, 0);
    expect(chars).toBeLessThanOrEqual(256);
    expect(result.budget.used.excerptChars).toBe(chars);
    expect(result.budget.used.outputChars).toBe(JSON.stringify(result).length);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.outputChars);
    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.reasons).toContain('excerpt_budget');
    expect(result.results[0]?.truncated).toBe(true);
    expect(result.budget.used.candidates).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.candidates);
    expect(result.budget.used.seeds).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.seeds);
    expect(result.budget.used.visited).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.visited);
    expect(result.budget.used.edges).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.edges);
  });

  test('zero-hop retrieval never expands and excludes foreign and trashed explicit seeds', async () => {
    const seed = await createNote({ title: 'quasar seed', content: 'local public evidence' }, root);
    const related = await createNote(
      { title: 'Neighbor', content: 'only reachable through graph' },
      root,
    );
    const foreign = await createNote(
      { title: 'quasar foreign', content: 'FOREIGN_PRIVATE' },
      foreignRoot,
    );
    const hidden = await createNote({ title: 'quasar trash', content: 'TRASH_PRIVATE' }, root);
    await linkNotes(seed.id, related.id, { syncContent: false }, root);
    await trashNote(hidden.id, root);
    const result = await retrieveNoteContext(
      { query: 'quasar', seedIds: [foreign.id, hidden.id, seed.id], maxHops: 0, semantic: false },
      root,
    );
    expect(result.results.map((note) => note.id)).toEqual([seed.id]);
    expect(result.budget.used.edges).toBe(0);
    expect(result.results[0]?.path).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('FOREIGN_PRIVATE');
    expect(JSON.stringify(result)).not.toContain('TRASH_PRIVATE');
  });

  test('semantic seeds find synonyms while foreign and trashed contents never leave the project', async () => {
    enableEmbeddings();
    const car = await createNote({ title: 'Transport', content: 'automobile design' }, root);
    await createNote({ title: 'Lunch', content: 'banana' }, root);
    await createNote({ title: 'Secret', content: 'FOREIGN_EMBEDDING_SECRET' }, foreignRoot);
    const hidden = await createNote({ title: 'Deleted', content: 'TRASH_EMBEDDING_SECRET' }, root);
    await trashNote(hidden.id, root);
    const transmitted: string[] = [];
    globalThis.fetch = (async (_, init) => {
      transmitted.push(...JSON.parse(init!.body as string).input);
      return embeddingResponse(init);
    }) as typeof fetch;
    await rebuildNoteSemanticIndex(root, { optIn: true });
    const result = await retrieveNoteContext({ query: 'vehicle', maxHops: 0, limit: 1 }, root);
    expect(result.retrieval.semantic).toBe('used');
    expect(result.results[0]?.id).toBe(car.id);
    expect(result.results[0]?.sources).toContain('semantic');
    expect(result.results[0]?.explanation).toContain('semantic');
    expect(transmitted.join(' ')).toContain('automobile');
    expect(transmitted.join(' ')).not.toContain('FOREIGN_EMBEDDING_SECRET');
    expect(transmitted.join(' ')).not.toContain('TRASH_EMBEDDING_SECRET');
  });

  test('embedding failure preserves lexical evidence and denied semantic permissions never call transport', async () => {
    enableEmbeddings();
    const note = await createNote({ title: 'Local fallback', content: 'quasar evidence' }, root);
    globalThis.fetch = (async (_, init) => embeddingResponse(init)) as typeof fetch;
    await rebuildNoteSemanticIndex(root, { optIn: true });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('credential diagnostic must not leak', { status: 401 });
    }) as typeof fetch;
    const fallback = await retrieveNoteContext({ query: 'quasar' }, root);
    expect(fallback.results.map((item) => item.id)).toContain(note.id);
    expect(fallback.retrieval.semantic).toBe('unavailable');
    expect(JSON.stringify(fallback)).not.toContain('credential diagnostic');
    expect(calls).toBeGreaterThan(0);
    calls = 0;
    saveNotesAgentPermissions(root, {
      preset: 'custom',
      tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, search_notes: 'ask' },
    });
    const denied = await retrieveNoteContext({ query: 'quasar' }, root);
    expect(denied.retrieval.semantic).toBe('permission_denied');
    expect(calls).toBe(0);
  });

  test('revision changes during semantic retrieval are excluded and reported rather than returning stale excerpts', async () => {
    enableEmbeddings();
    const note = await createNote(
      { title: 'Transport', content: 'automobile STALE_EVIDENCE' },
      root,
    );
    globalThis.fetch = (async (_, init) => embeddingResponse(init)) as typeof fetch;
    await rebuildNoteSemanticIndex(root, { optIn: true });
    let changed = false;
    globalThis.fetch = (async (_, init) => {
      if (!changed) {
        changed = true;
        await updateNote(
          note.id,
          { content: 'new unrelated evidence', expectedRevision: note.revision },
          root,
        );
      }
      return embeddingResponse(init);
    }) as typeof fetch;
    const result = await retrieveNoteContext({ query: 'vehicle', seedIds: [note.id] }, root);
    expect(result.results.map((item) => item.id)).not.toContain(note.id);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        noteId: note.id,
        reason: 'revision_changed',
        expectedRevision: note.revision,
        currentRevision: note.revision + 1,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('STALE_EVIDENCE');
  });

  test('validates work limits and cancellation before doing retrieval', async () => {
    for (const input of [
      { query: '' },
      { query: 'x', maxHops: 3 },
      { query: 'x', limit: 13 },
      { query: 'x', maxChars: 16001 },
      { query: 'x', excerptChars: 127 },
      { query: 'x', seedIds: Array(9).fill('x') },
      { query: 'x', limit: Number.NaN },
    ])
      await expect(retrieveNoteContext(input, root)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieveNoteContext({ query: 'quasar' }, root, { signal: controller.signal }),
    ).rejects.toThrow('canceled');
  });
});
