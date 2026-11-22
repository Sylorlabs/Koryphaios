import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddingClient } from '../../memory/semantic-embeddings';
import {
  getNoteSemanticIndexStatus,
  rebuildNoteSemanticIndex,
  searchNoteSemanticIndex,
  NOTE_SEMANTIC_INDEX_DDL,
  NOTE_SEMANTIC_SEARCH_MAX_VECTORS,
} from '../note-semantic-index';
import { saveNotesAgentPermissions } from '../notes-settings';
import { retrieveNoteContext } from '../note-context';
import { setNoteSearchText } from '../note-search-index';

let database: Database, root: string, path: string, client: EmbeddingClient;
let sent: string[];
let during: (() => void) | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'note-index-')));
  path = join(root, 'test.sqlite');
  database = new Database(path);
  database.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT,content TEXT,revision INTEGER DEFAULT 1,project_root TEXT,trashed_at INTEGER,tags TEXT DEFAULT '[]',updated_at INTEGER DEFAULT 1,pinned INTEGER DEFAULT 0);
 CREATE TABLE note_links(from_note_id TEXT,to_note_id TEXT);
 CREATE TABLE note_relationships(from_note_id TEXT,to_note_id TEXT,project_root TEXT,provenance TEXT DEFAULT 'user',evidence TEXT DEFAULT '',weight REAL DEFAULT 1,revision INTEGER DEFAULT 1,source_revision INTEGER DEFAULT 1,target_revision INTEGER DEFAULT 1,type TEXT DEFAULT 'related_to',status TEXT DEFAULT 'accepted');
 ${NOTE_SEMANTIC_INDEX_DDL}
 CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, content='', contentless_delete=1, detail='column', tokenize='porter unicode61');
 CREATE TABLE notes_fts_rowids (fts_rowid INTEGER PRIMARY KEY, note_id TEXT NOT NULL UNIQUE);`);
  sent = [];
  during = undefined;
  client = makeClient();
});
afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});
function makeClient(model = 'model', apiKey = 'credential') {
  return new EmbeddingClient(
    { endpoint: 'https://test.example/embeddings', model, apiKey, dimensions: 2 },
    async (_, init) => {
      const texts = JSON.parse(init.body as string).input as string[];
      sent.push(...texts);
      during?.();
      return Response.json({
        data: texts.map((text, index) => ({
          index,
          embedding: /automobile|vehicle/.test(text) ? [1, 0] : [0, 1],
        })),
      });
    },
  );
}
function note(id: string, content = 'automobile', projectRoot = root) {
  database
    .query('INSERT INTO notes(id,title,content,project_root) VALUES(?,?,?,?)')
    .run(id, id, content, projectRoot);
  setNoteSearchText(id, id, content, '[]', database);
}
const opts = () => ({ database, client });

/** Instrument actual returned bodies, including all()/iterate() corpus passes. */
function observeBodyReads() {
  let reads = 0;
  const count = (row: unknown) => {
    if (row && typeof row === 'object' && 'content' in row) reads++;
    return row;
  };
  database = new Proxy(database, {
    get(target, property) {
      if (property === 'query')
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(target, property) {
              if (property === 'get') return (...args: never[]) => count(target.get(...args));
              if (property === 'all') return (...args: never[]) => target.all(...args).map(count);
              if (property === 'iterate')
                return function* (...args: never[]) {
                  for (const row of target.iterate(...args)) yield count(row);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return () => reads;
}
function observeQueries(onQuery: (sql: string) => void): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'query')
        return (sql: string) => {
          onQuery(sql);
          return target.query(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function seedVectors(count: number) {
  database.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `id-${String(i).padStart(4, '0')}`;
      note(id);
      database.query('INSERT INTO note_semantic_vectors VALUES(?,?,?,?,?,?,?)').run(
        root,
        id,
        client.identity,
        1,
        createHash('sha256')
          .update(JSON.stringify([id, 'automobile']))
          .digest('hex'),
        '[1,0]',
        1,
      );
    }
    database
      .query('INSERT INTO note_semantic_index_state VALUES(?,?,?,?,?)')
      .run(root, client.identity, '', 1, 1);
  })();
}

test('explicit persisted opt-in and vectors survive database reopen; reads only send query and do not write', async () => {
  note('one');
  expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).mode).toBe('disabled');
  expect(sent).toEqual([]);
  await expect(rebuildNoteSemanticIndex(root, {} as never, opts())).rejects.toThrow('opt-in');
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  database.close();
  database = new Database(path);
  client = makeClient();
  sent = [];
  const before = database.query('SELECT total_changes() AS count').get();
  expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
    mode: 'ready',
    indexedNotes: 1,
    coverage: 1,
  });
  const result = await searchNoteSemanticIndex(root, 'vehicle', opts());
  expect(result.hits.map((hit) => hit.id)).toEqual(['one']);
  expect(sent).toEqual(['vehicle']);
  expect(database.query('SELECT total_changes() AS count').get()).toEqual(before);
});

test('persistent bounded pages reach older notes beyond 256 and report partial coverage', async () => {
  for (let i = 0; i < 270; i++)
    note(`id-${String(i).padStart(3, '0')}`, i === 269 ? 'automobile' : 'banana');
  const first = await rebuildNoteSemanticIndex(root, { optIn: true, limit: 128 }, opts());
  expect(first).toMatchObject({
    processed: 128,
    hasMore: true,
    status: { mode: 'partial', indexedNotes: 128, eligibleNotes: 270, cursor: 'id-127' },
  });
  database.close();
  database = new Database(path);
  await rebuildNoteSemanticIndex(root, { optIn: true, limit: 128 }, opts());
  const last = await rebuildNoteSemanticIndex(root, { optIn: true, limit: 128 }, opts());
  expect(last).toMatchObject({
    processed: 14,
    hasMore: false,
    status: { mode: 'ready', coverage: 1, cursor: '' },
  });
  expect(
    (await searchNoteSemanticIndex(root, 'vehicle', opts())).hits.map((hit) => hit.id),
  ).toEqual(['id-269']);
});

test('edits including same-revision content edits, deletes, trash and scope changes invalidate vectors', async () => {
  for (const id of ['edit', 'same', 'delete', 'trash', 'scope']) note(id);
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  database.query("UPDATE notes SET content='changed',revision=2 WHERE id='edit'").run();
  database.query("UPDATE notes SET content='changed' WHERE id='same'").run();
  database.query("DELETE FROM notes WHERE id='delete'").run();
  database.query("UPDATE notes SET trashed_at=1 WHERE id='trash'").run();
  database.query("UPDATE notes SET project_root='/foreign' WHERE id='scope'").run();
  expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
    eligibleNotes: 2,
    indexedNotes: 1,
    staleNotes: 1,
    coverageBasis: 'revision_metadata',
  });
  expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).hits).toEqual([]);
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
    mode: 'ready',
    indexedNotes: 2,
  });
  // Bounded rebuilds do not sweep orphan/out-of-scope rows; reads reject them instead.
  expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).hits).toEqual([]);
});

test('foreign, trashed, forged encoded document IDs never leave scope, including mutation while rebuilding', async () => {
  note('a');
  note('b', 'SECRET');
  note('foreign', 'SECRET', '/foreign');
  note('trash', 'SECRET');
  note(
    'project-document:' +
      Buffer.from(JSON.stringify(['/foreign', 'note.md'])).toString('base64url'),
    'SECRET',
  );
  database.query("UPDATE notes SET trashed_at=1 WHERE id='trash'").run();
  during = () => {
    database.query("UPDATE notes SET project_root='/foreign' WHERE id='b'").run();
  };
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  expect(sent.join(' ')).not.toContain('SECRET');
  expect(getNoteSemanticIndexStatus(root, opts()).indexedNotes).toBe(1);
});

test('transport-time edits/deletion filter stored results and staged writes', async () => {
  note('one');
  during = () => {
    database.query("UPDATE notes SET content='new',revision=2 WHERE id='one'").run();
  };
  expect((await rebuildNoteSemanticIndex(root, { optIn: true }, opts())).indexed).toBe(0);
  during = undefined;
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  during = () => {
    database.query("DELETE FROM notes WHERE id='one'").run();
  };
  expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).hits).toEqual([]);
});

test('model and credential identity changes require explicit opt-in and reindexing', async () => {
  note('one');
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  for (const changed of [makeClient('new-model'), makeClient('model', 'new-key')]) {
    client = changed;
    sent = [];
    expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
      mode: 'not_opted_in',
      indexedNotes: 0,
      staleNotes: 0,
      countsAvailable: false,
    });
    expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).mode).toBe('disabled');
    expect(sent).toEqual([]);
    expect((await rebuildNoteSemanticIndex(root, { optIn: true }, opts())).indexed).toBe(1);
  }
});

test('Ask/Block prevent transport and live permission revocation prevents publication', async () => {
  note('one');
  for (const permission of ['ask', 'block'] as const) {
    saveNotesAgentPermissions(root, { tools: { read_note: permission } });
    expect((await rebuildNoteSemanticIndex(root, { optIn: true }, opts())).status.mode).toBe(
      'permission_denied',
    );
    expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).mode).toBe('permission_denied');
  }
  expect(sent).toEqual([]);
  saveNotesAgentPermissions(root, { tools: { read_note: 'allow' } });
  during = () => saveNotesAgentPermissions(root, { tools: { read_note: 'block' } });
  expect((await rebuildNoteSemanticIndex(root, { optIn: true }, opts())).indexed).toBe(0);
});

test('canceled rebuild preserves completed cursor but never writes the in-flight vector; resume succeeds', async () => {
  note('a');
  note('b');
  note('c');
  const controller = new AbortController();
  during = () => {
    if (sent.length === 2) controller.abort();
  };
  const canceled = await rebuildNoteSemanticIndex(
    root,
    { optIn: true },
    { ...opts(), signal: controller.signal },
  );
  expect(canceled).toMatchObject({
    canceled: true,
    indexed: 1,
    processed: 1,
    hasMore: true,
    status: { cursor: 'a', indexedNotes: 1 },
  });
  during = undefined;
  expect((await rebuildNoteSemanticIndex(root, { optIn: true }, opts())).indexed).toBe(2);
  const pre = new AbortController();
  pre.abort();
  sent = [];
  expect(
    (await rebuildNoteSemanticIndex(root, { optIn: true }, { ...opts(), signal: pre.signal }))
      .canceled,
  ).toBe(true);
  expect(sent).toEqual([]);
});

test('missing tables/config return honest unavailable/disabled fallback without writes', async () => {
  note('one');
  expect(getNoteSemanticIndexStatus(root, { database, client: null }).mode).toBe('disabled');
  database.exec('DROP TABLE note_semantic_index_state');
  expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
    available: false,
    mode: 'unavailable',
  });
  expect((await searchNoteSemanticIndex(root, 'vehicle', opts())).mode).toBe('unavailable');
  expect(sent).toEqual([]);
});

test('live model/credential changes and corrupted vectors cannot publish semantic evidence', async () => {
  note('one');
  const options = opts();
  during = () => {
    options.client = makeClient('changed', 'rotated');
  };
  expect((await rebuildNoteSemanticIndex(root, { optIn: true }, options)).indexed).toBe(0);
  during = undefined;
  await rebuildNoteSemanticIndex(root, { optIn: true }, opts());
  database.query("UPDATE note_semantic_vectors SET vector_json='[null,0]'").run();
  expect(getNoteSemanticIndexStatus(root, opts())).toMatchObject({
    mode: 'ready',
    indexedNotes: 1,
    staleNotes: 0,
    coverageBasis: 'revision_metadata',
  });
  sent = [];
  const result = await searchNoteSemanticIndex(root, 'vehicle', opts());
  expect(result.hits).toEqual([]);
  expect(result.exhaustive).toBe(true);
  expect(sent).toEqual(['vehicle']);
});

test('disabled, denied and not opted-in calls never query note bodies or vector data', async () => {
  for (let i = 0; i < 100; i++) note(`large-${i}`, 'x'.repeat(10000));
  const bodyReads = observeBodyReads();
  const queries: string[] = [];
  const observed = observeQueries((sql) => {
    queries.push(sql);
    if (/\bnotes\b|\bnote_semantic_vectors\b/i.test(sql)) throw new Error('Unexpected corpus read');
  });
  expect(getNoteSemanticIndexStatus(root, { database: observed, client: null })).toMatchObject({
    mode: 'disabled',
    countsAvailable: false,
  });
  expect(
    (await searchNoteSemanticIndex(root, 'vehicle', { database: observed, client: null })).mode,
  ).toBe('disabled');
  expect(
    (
      await rebuildNoteSemanticIndex(
        root,
        { optIn: true, limit: 1 },
        { database: observed, client: null },
      )
    ).processed,
  ).toBe(0);
  expect(queries).toEqual([]);
  expect(getNoteSemanticIndexStatus(root, { database: observed, client })).toMatchObject({
    mode: 'not_opted_in',
    countsAvailable: false,
  });
  expect(
    (await searchNoteSemanticIndex(root, 'vehicle', { database: observed, client })).mode,
  ).toBe('disabled');
  expect(queries.every((sql) => sql.includes('note_semantic_index_state'))).toBe(true);
  queries.length = 0;
  for (const permission of ['ask', 'block'] as const) {
    saveNotesAgentPermissions(root, { tools: { read_note: permission } });
    expect(getNoteSemanticIndexStatus(root, { database: observed, client }).mode).toBe(
      'permission_denied',
    );
    expect(
      (await searchNoteSemanticIndex(root, 'vehicle', { database: observed, client })).mode,
    ).toBe('permission_denied');
    expect(
      (
        await rebuildNoteSemanticIndex(
          root,
          { optIn: true, limit: 1 },
          { database: observed, client },
        )
      ).processed,
    ).toBe(0);
  }
  expect(queries).toEqual([]);
  expect(bodyReads()).toBe(0);
  expect(sent).toEqual([]);
});

test('active status is one metadata aggregate, never N+1 hashes or vector parsing', () => {
  seedVectors(800);
  database.query("UPDATE notes SET revision=2 WHERE id='id-0000'").run();
  database.query("UPDATE notes SET content='same-revision-tamper' WHERE id='id-0001'").run();
  database
    .query("UPDATE note_semantic_vectors SET vector_json='broken' WHERE note_id='id-0002'")
    .run();
  const reads = observeBodyReads();
  const queries: string[] = [];
  const observed = observeQueries((sql) => {
    queries.push(sql);
    if (/\bcontent\b|\bvector_json\b/i.test(sql)) throw new Error('Status must be metadata only');
  });
  expect(getNoteSemanticIndexStatus(root, { database: observed, client })).toMatchObject({
    countsAvailable: true,
    coverageBasis: 'revision_metadata',
    mode: 'partial',
    eligibleNotes: 800,
    indexedNotes: 799,
    staleNotes: 1,
  });
  expect(queries).toHaveLength(2); // persisted opt-in + single aggregate
  expect(reads()).toBe(0);
});

test('limit-one rebuild bounds body reads and writes even with a large corpus and stale vectors', async () => {
  seedVectors(800);
  database.query('UPDATE notes SET revision=2').run();
  const reads = observeBodyReads();
  const queries: string[] = [];
  const observed = observeQueries((sql) => queries.push(sql));
  const result = await rebuildNoteSemanticIndex(
    root,
    { optIn: true, limit: 1 },
    { database: observed, client },
  );
  expect(result).toMatchObject({
    processed: 1,
    indexed: 1,
    hasMore: true,
    status: { indexedNotes: 1, staleNotes: 799, cursor: 'id-0000' },
  });
  expect(reads()).toBe(2); // one input snapshot + post-transport hash validation
  expect(queries.filter((sql) => /\bDELETE\b/.test(sql))).toHaveLength(0);
  expect(queries.filter((sql) => /SELECT.*\bcontent\b/.test(sql))).toHaveLength(2);
  expect(sent).toHaveLength(1);
});

test('active vector search is hard-capped, cooperative and explicitly non-exhaustive', async () => {
  seedVectors(NOTE_SEMANTIC_SEARCH_MAX_VECTORS + 40);
  const reads = observeBodyReads();
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  try {
    const result = await searchNoteSemanticIndex(root, 'vehicle', {
      ...opts(),
      limit: 3,
      timeoutMs: 15000,
    });
    expect(result).toMatchObject({
      mode: 'used',
      exhaustive: false,
      truncated: true,
      status: {
        search: { reason: 'vector_limit', scannedVectors: NOTE_SEMANTIC_SEARCH_MAX_VECTORS },
      },
    });
    expect(result.hits).toHaveLength(3);
    expect(reads()).toBe(6); // hydrate only top candidates, then publication snapshot validation
    expect(turns).toBeGreaterThan(1);
    expect(sent).toEqual(['vehicle']);
  } finally {
    clearInterval(timer);
  }
});

test('search cap counts invalid/orphan vectors and exact final pages are exhaustive', async () => {
  seedVectors(32);
  let result = await searchNoteSemanticIndex(root, 'vehicle', { ...opts(), maxVectors: 32 });
  expect(result).toMatchObject({
    exhaustive: true,
    truncated: false,
    status: { search: { reason: 'complete', scannedVectors: 32 } },
  });
  database
    .query("UPDATE note_semantic_vectors SET vector_json='not-json' WHERE note_id < 'id-0030'")
    .run();
  result = await searchNoteSemanticIndex(root, 'vehicle', { ...opts(), maxVectors: 5 });
  expect(result.hits).toEqual([]);
  expect(result).toMatchObject({
    exhaustive: false,
    status: { search: { reason: 'vector_limit', scannedVectors: 5 } },
  });
});

test('oversized persisted vectors are bounded and cannot silently claim exhaustive search', async () => {
  seedVectors(2);
  database
    .query("UPDATE note_semantic_vectors SET vector_json=? WHERE note_id='id-0000'")
    .run(' '.repeat(600000) + '[1,0]');
  const result = await searchNoteSemanticIndex(root, 'vehicle', opts());
  expect(result).toMatchObject({
    mode: 'used',
    exhaustive: false,
    truncated: true,
    status: { search: { reason: 'vector_size_limit', scannedVectors: 2 } },
  });
  expect(result.hits.map((hit) => hit.id)).toEqual(['id-0001']);
});

test('active search cancellation and deadline interrupt cooperative vector scanning', async () => {
  seedVectors(160);
  const reads = observeBodyReads();
  for (const reason of ['canceled', 'timeout'] as const) {
    const controller = new AbortController();
    let pages = 0;
    const observed = observeQueries((sql) => {
      if (sql.includes('substr(vector_json')) pages++;
    });
    // Abort after transport, when the scan yields, not only before the request starts.
    during = () => {
      if (reason === 'canceled') setTimeout(() => controller.abort(), 0);
    };
    const start = Date.now();
    const result = await searchNoteSemanticIndex(root, 'vehicle', {
      database: observed,
      client,
      signal: controller.signal,
      timeoutMs: reason === 'timeout' ? 1 : 15000,
    });
    expect(result).toMatchObject({
      mode: 'unavailable',
      exhaustive: false,
      hits: [],
      status: { search: { reason } },
    });
    expect(result.status.search!.scannedVectors).toBeLessThan(160);
    expect(pages).toBeLessThanOrEqual(1);
    expect(Date.now() - start).toBeLessThan(1000);
  }
  expect(reads()).toBe(0);
});

test('ranked evidence still rejects full-content tampering beyond representation, foreign IDs and trash', async () => {
  seedVectors(5);
  database.query("UPDATE notes SET content=content || ? WHERE id='id-0000'").run('x'.repeat(10000));
  database.query("UPDATE notes SET project_root='/foreign' WHERE id='id-0001'").run();
  database.query("UPDATE notes SET trashed_at=1 WHERE id='id-0002'").run();
  const forged =
    'project-document:' +
    Buffer.from(JSON.stringify(['/foreign', 'secret.md'])).toString('base64url');
  // A forged ID with a valid body hash cannot be accepted merely because its SQL scope matches.
  note(forged);
  database.query('INSERT INTO note_semantic_vectors VALUES(?,?,?,?,?,?,?)').run(
    root,
    forged,
    client.identity,
    1,
    createHash('sha256')
      .update(JSON.stringify([forged, 'automobile']))
      .digest('hex'),
    '[1,0]',
    1,
  );
  const result = await searchNoteSemanticIndex(root, 'vehicle', opts());
  expect(result.hits.map((hit) => hit.id)).toEqual(['id-0003', 'id-0004']);
  expect(sent).toEqual(['vehicle']);
});

test('cooperative search rechecks earlier hits after interleaved edits and permission revocation', async () => {
  seedVectors(4);
  let scheduled = false;
  let action: () => void = () =>
    database.query("UPDATE notes SET content='changed' WHERE id='id-0000'").run();
  const observed = observeQueries((sql) => {
    if (!scheduled && /SELECT id,title,content/.test(sql)) {
      scheduled = true;
      setTimeout(() => action(), 0);
    }
  });
  const changed = await searchNoteSemanticIndex(root, 'vehicle', { database: observed, client });
  expect(changed.hits.map((hit) => hit.id)).toEqual(['id-0001', 'id-0002', 'id-0003']);
  scheduled = false;
  action = () => {
    saveNotesAgentPermissions(root, { tools: { read_note: 'block' } });
  };
  const revoked = await searchNoteSemanticIndex(root, 'vehicle', { database: observed, client });
  expect(revoked).toMatchObject({ mode: 'unavailable', exhaustive: false, hits: [] });
});

test('typed retrieval traverses accepted claims only and labels contradictions/supersession as claims', async () => {
  note('seed', 'quasar');
  for (const id of ['supports', 'contradicts', 'supersedes', 'proposed', 'rejected']) {
    note(id, 'different');
    database
      .query(
        'INSERT INTO note_relationships(from_note_id,to_note_id,project_root,type,status,evidence) VALUES(?,?,?,?,?,?)',
      )
      .run(
        'seed',
        id,
        root,
        ['proposed', 'rejected'].includes(id) ? 'supports' : id,
        ['proposed', 'rejected'].includes(id) ? id : 'accepted',
        'Recorded evidence',
      );
  }
  const result = await retrieveNoteContext({ query: 'quasar', semantic: false, limit: 12 }, root, {
    database,
  });
  expect(result.results.map((row) => row.id).sort()).toEqual([
    'contradicts',
    'seed',
    'supersedes',
    'supports',
  ]);
  for (const row of result.results.filter((row) => row.id !== 'seed')) {
    expect(row.path[0]).toMatchObject({
      type: row.id,
      status: 'accepted',
      evidence: 'Recorded evidence',
    });
    expect(row.explanation).toContain('not independently verified facts');
  }
});
