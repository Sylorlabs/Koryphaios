import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTE_CONTEXT_LIMITS, retrieveNoteContext } from '../note-context';
import { saveNotesAgentPermissions } from '../notes-settings';
import { NOTE_SEMANTIC_INDEX_DDL, rebuildNoteSemanticIndex } from '../note-semantic-index';
import { setNoteSearchText } from '../note-search-index';

let database: Database;
let root: string;
let savedEnv: Record<string, string | undefined>;
const originalFetch = globalThis.fetch;
const envNames = [
  'KORY_EMBEDDINGS_ENABLED',
  'KORY_EMBEDDING_ENDPOINT',
  'KORY_EMBEDDING_MODEL',
  'KORY_EMBEDDING_DIMENSIONS',
  'KORY_EMBEDDING_API_KEY',
  'KORY_EMBEDDING_TIMEOUT_MS',
];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'note-context-unit-')));
  savedEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  delete process.env.KORY_EMBEDDINGS_ENABLED;
  database = new Database(':memory:');
  database.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, content TEXT, tags TEXT DEFAULT '[]', revision INTEGER DEFAULT 1,
      project_root TEXT, trashed_at INTEGER, pinned INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 1);
    CREATE TABLE note_links (from_note_id TEXT, to_note_id TEXT);
    CREATE TABLE note_relationships (from_note_id TEXT, to_note_id TEXT, project_root TEXT,
      provenance TEXT DEFAULT 'user', evidence TEXT DEFAULT '', weight REAL DEFAULT 1, revision INTEGER DEFAULT 1,
      source_revision INTEGER DEFAULT 1, target_revision INTEGER DEFAULT 1);
    ${NOTE_SEMANTIC_INDEX_DDL}
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, content='', contentless_delete=1, detail='column', tokenize='porter unicode61');
    CREATE TABLE notes_fts_rowids (fts_rowid INTEGER PRIMARY KEY, note_id TEXT NOT NULL UNIQUE);
  `);
});
afterEach(() => {
  database.close();
  globalThis.fetch = originalFetch;
  for (const key of envNames) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});
function note(id: string, content: string, project = root, trashed = false) {
  database
    .query('INSERT INTO notes(id,title,content,project_root,trashed_at) VALUES (?,?,?,?,?)')
    .run(id, id, content, project, trashed ? 10 : null);
  setNoteSearchText(id, id, content, '[]', database);
}
function link(from: string, to: string, association = true) {
  if (association)
    database
      .query(
        'INSERT INTO note_relationships(from_note_id,to_note_id,project_root,evidence) VALUES(?,?,?,?)',
      )
      .run(from, to, root, 'Reviewed supporting evidence');
  else database.query('INSERT INTO note_links VALUES(?,?)').run(from, to);
}
function embeddings(onRequest?: (texts: string[]) => void) {
  Object.assign(process.env, {
    KORY_EMBEDDINGS_ENABLED: '1',
    KORY_EMBEDDING_ENDPOINT: 'https://embedding.example/embeddings',
    KORY_EMBEDDING_MODEL: root,
    KORY_EMBEDDING_DIMENSIONS: '2',
    KORY_EMBEDDING_API_KEY: 'test',
    KORY_EMBEDDING_TIMEOUT_MS: '50',
  });
  globalThis.fetch = (async (_, init) => {
    const texts = JSON.parse(init!.body as string).input as string[];
    onRequest?.(texts);
    return Response.json({
      data: texts.map((text, index) => ({
        index,
        embedding: /automobile|vehicle/.test(text) ? [1, 0] : [0, 1],
      })),
    });
  }) as typeof fetch;
}

describe('bounded read-only note context', () => {
  test('natural-language questions find lexical seeds without requiring every filler word', async () => {
    note('authentication', 'Authentication uses short-lived access tokens.');
    const result = await retrieveNoteContext(
      { query: 'How should we implement authentication?', semantic: false },
      root,
      { database },
    );
    expect(result.results.map((row) => row.id)).toContain('authentication');
  });

  test('retains typed connections and stale warnings between independently selected seeds', async () => {
    database.exec(
      "ALTER TABLE note_relationships ADD COLUMN type TEXT DEFAULT 'related_to'; ALTER TABLE note_relationships ADD COLUMN status TEXT DEFAULT 'accepted';",
    );
    note('seed-a', 'quasar design');
    note('seed-b', 'quasar incident');
    link('seed-a', 'seed-b');
    database.exec(
      "UPDATE note_relationships SET type='contradicts'; UPDATE notes SET revision=2 WHERE id='seed-b';",
    );
    const result = await retrieveNoteContext({ query: 'quasar', semantic: false }, root, {
      database,
    });
    expect(result.results.every((row) => row.path.length === 0)).toBe(true);
    expect(result.connections).toContainEqual(
      expect.objectContaining({
        fromId: 'seed-a',
        toId: 'seed-b',
        type: 'contradicts',
        stale: true,
      }),
    );
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ noteId: 'seed-b', reason: 'stale_relationship' }),
    );
  });

  test('reserves room for a linked counterpoint when lexical seeds fill the result limit', async () => {
    database.exec(
      "ALTER TABLE note_relationships ADD COLUMN type TEXT DEFAULT 'related_to'; ALTER TABLE note_relationships ADD COLUMN status TEXT DEFAULT 'accepted';",
    );
    for (let i = 0; i < 8; i++) note(`seed-${i}`, 'quasar design');
    note('counterpoint', 'Prior design was superseded by later evidence.');
    link('seed-0', 'counterpoint');
    database.exec("UPDATE note_relationships SET type='contradicts';");
    const result = await retrieveNoteContext({ query: 'quasar', limit: 6, semantic: false }, root, {
      database,
    });
    expect(result.results).toHaveLength(6);
    expect(result.results.some((row) => row.id === 'counterpoint')).toBe(true);
    expect(result.results[0].sources).toContain('lexical');
  });
  test('returns excerpt revisions and directed paths without writing, including incoming and cycle handling', async () => {
    note('seed', 'quasar research ' + 'x'.repeat(8000));
    note('neighbor', 'Relevant supporting evidence');
    note('incoming', 'Counterpoint evidence');
    note('deep', 'Second-hop evidence');
    link('seed', 'neighbor');
    link('incoming', 'seed', false);
    link('neighbor', 'deep');
    link('deep', 'seed');
    const before = database.query('SELECT total_changes() AS value').get();
    const result = await retrieveNoteContext(
      { query: 'quasar', maxHops: 2, limit: 12, excerptChars: 128, maxChars: 512, semantic: false },
      root,
      { database },
    );
    expect(result.results.map((row) => row.id).sort()).toEqual([
      'deep',
      'incoming',
      'neighbor',
      'seed',
    ]);
    expect(new Set(result.results.map((row) => row.id)).size).toBe(result.results.length);
    expect(result.results.find((row) => row.id === 'neighbor')?.path[0]).toMatchObject({
      fromId: 'seed',
      toId: 'neighbor',
      direction: 'outgoing',
      kind: 'association',
      provenance: 'user',
      fromRevision: 1,
      toRevision: 1,
      relationshipRevision: 1,
    });
    expect(result.results.find((row) => row.id === 'incoming')?.path[0].direction).toBe('incoming');
    expect(result.results.every((row) => row.excerpt.length <= 128 && row.revision === 1)).toBe(
      true,
    );
    expect(result.budget.used.excerptChars).toBeLessThanOrEqual(512);
    expect(result.budget.used.outputChars).toBe(JSON.stringify(result).length);
    expect(result.truncation.reasons).toContain('excerpts');
    expect(database.query('SELECT total_changes() AS value').get()).toEqual(before);
  });

  test('scope and trash filtering precede graph traversal and embedding export', async () => {
    note('local', 'automobile');
    note('foreign', 'private foreign vehicle', '/elsewhere');
    note('trash', 'private trash', root, true);
    const forged =
      'project-document:' +
      Buffer.from(JSON.stringify(['/elsewhere', 'private.md'])).toString('base64url');
    note(forged, 'private forged vehicle');
    link('local', 'foreign');
    link('local', 'trash');
    link('local', forged);
    const sent: string[] = [];
    embeddings((texts) => sent.push(...texts));
    await rebuildNoteSemanticIndex(root, { optIn: true }, { database });
    const result = await retrieveNoteContext(
      { query: 'vehicle', seedIds: ['foreign', 'trash', forged, 'local'] },
      root,
      { database },
    );
    expect(result.results.map((row) => row.id)).toEqual(['local']);
    expect(sent.join(' ')).not.toContain('private');
    expect(result.retrieval.semantic).toBe('used');
  });

  test('fuses lexical and semantic evidence; conflicts discard notes edited during transport', async () => {
    note('lexical', 'vehicle literal');
    note('semantic', 'automobile concept');
    embeddings();
    await rebuildNoteSemanticIndex(root, { optIn: true }, { database });
    let changed = false;
    embeddings(() => {
      if (!changed) {
        changed = true;
        database
          .query("UPDATE notes SET content = 'new revision', revision = 2 WHERE id = 'lexical'")
          .run();
      }
    });
    const result = await retrieveNoteContext({ query: 'vehicle', maxHops: 0 }, root, { database });
    expect(result.results.map((row) => row.id)).toEqual(['semantic']);
    expect(result.results[0].sources).toContain('semantic');
    expect(result.conflicts).toContainEqual({
      noteId: 'lexical',
      reason: 'revision_changed',
      expectedRevision: 1,
      currentRevision: 2,
    });
  });

  test('falls back locally on embedding failure and never exports ask/block permission bodies', async () => {
    note('local', 'vehicle local');
    embeddings();
    await rebuildNoteSemanticIndex(root, { optIn: true }, { database });
    globalThis.fetch = (async () =>
      new Response('secret transport error', { status: 401 })) as typeof fetch;
    const fallback = await retrieveNoteContext({ query: 'vehicle' }, root, { database });
    expect(fallback.retrieval.semantic).toBe('unavailable');
    expect(fallback.results[0].sources).toContain('lexical');
    let calls = 0;
    embeddings(() => {
      calls++;
    });
    for (const permission of ['ask', 'block'] as const) {
      saveNotesAgentPermissions(root, { tools: { read_note: permission } } as Parameters<
        typeof saveNotesAgentPermissions
      >[1]);
      const result = await retrieveNoteContext({ query: 'vehicle' }, root, { database });
      expect(result.retrieval.semantic).toBe('permission_denied');
      expect(result.results[0].id).toBe('local');
    }
    expect(calls).toBe(0);
  });

  test('honors hard fanout/visit/output envelopes and zero-hop retrieval', async () => {
    note('seed', 'uniquequery');
    for (let i = 0; i < 100; i++) {
      note(`node-${i}`, 'x'.repeat(10000));
      link('seed', `node-${i}`);
    }
    const result = await retrieveNoteContext(
      {
        query: 'uniquequery',
        maxHops: 2,
        limit: 12,
        maxChars: 256,
        excerptChars: 2000,
        semantic: false,
      },
      root,
      { database },
    );
    expect(result.budget.used.visited).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.visited);
    expect(result.budget.used.edges).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.edges);
    expect(result.budget.used.excerptChars).toBeLessThanOrEqual(256);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(NOTE_CONTEXT_LIMITS.outputChars);
    expect(result.truncation.reasons).toContain('fanout');
    expect(result.truncation.reasons).toContain('excerpt_budget');
    const zero = await retrieveNoteContext(
      { query: 'uniquequery', maxHops: 0, semantic: false },
      root,
      { database },
    );
    expect(zero.results.map((row) => row.id)).toEqual(['seed']);
    expect(zero.budget.used.edges).toBe(0);
  });

  test('flags stale association evidence and returns current endpoint revisions', async () => {
    note('seed', 'quasar');
    note('neighbor', 'supporting evidence');
    link('seed', 'neighbor');
    database.query("UPDATE notes SET revision = 2 WHERE id = 'neighbor'").run();
    const result = await retrieveNoteContext({ query: 'quasar', semantic: false }, root, {
      database,
    });
    const neighbor = result.results.find((row) => row.id === 'neighbor')!;
    expect(neighbor.revision).toBe(2);
    expect(neighbor.path[0]).toMatchObject({
      stale: true,
      sourceRevision: 1,
      targetRevision: 1,
      fromRevision: 1,
      toRevision: 2,
    });
    expect(neighbor.explanation).toContain('Stale relationship');
    expect(result.conflicts).toContainEqual({
      noteId: 'neighbor',
      relatedNoteId: 'seed',
      reason: 'stale_relationship',
      expectedRevision: 1,
      currentRevision: 2,
    });
  });

  test('astral Unicode cannot double the candidate or excerpt budget', async () => {
    note('unicode', 'quasar ' + '😀'.repeat(9000));
    const sent: string[] = [];
    embeddings((texts) => sent.push(...texts));
    const result = await retrieveNoteContext({ query: 'quasar', excerptChars: 128 }, root, {
      database,
    });
    expect(
      sent
        .filter((text) => text !== 'quasar')
        .every(
          (text) => text.length <= NOTE_CONTEXT_LIMITS.candidateChars + 'unicode\\n\\n'.length,
        ),
    ).toBe(true);
    expect(result.results[0].excerpt.length).toBeLessThanOrEqual(128);
    expect(result.results[0].truncated).toBe(true);
    expect(result.truncation.reasons).toContain('candidate_windows');
  });

  test('canceling an in-flight semantic request returns no late result', async () => {
    note('local', 'automobile');
    embeddings();
    await rebuildNoteSemanticIndex(root, { optIn: true }, { database });
    const controller = new AbortController();
    embeddings(() => controller.abort());
    await expect(
      retrieveNoteContext({ query: 'vehicle' }, root, { database, signal: controller.signal }),
    ).rejects.toThrow('canceled');
  });

  test('validates malformed, over-budget, and canceled calls', async () => {
    for (const input of [
      { query: '' },
      { query: 'x', limit: Infinity },
      { query: 'x', maxHops: 3 },
      { query: 'x', maxChars: NaN },
      { query: 'x', seedIds: Array(9).fill('x') },
      { query: 'x', excerptChars: 1.2 },
    ])
      await expect(retrieveNoteContext(input, root, { database })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieveNoteContext({ query: 'x' }, root, { database, signal: controller.signal }),
    ).rejects.toThrow('canceled');
  });
});
