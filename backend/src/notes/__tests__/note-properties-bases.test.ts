import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS } from '../../db/migrations';
import {
  assertProjectPropertyProjectionCurrent,
  getNotePropertyProjection,
  listNotePropertySchemas,
  repairProjectPropertyProjections,
} from '../note-properties-service';
import {
  createNoteBase,
  getNoteBase,
  listNoteBaseRevisions,
  listNoteBases,
  previewNoteBase,
  queryNoteBase,
  restoreNoteBase,
  trashNoteBase,
  updateNoteBase,
  validateNoteBaseDefinition,
  type NoteBaseDefinition,
} from '../note-bases-service';

const PROJECT_A = '/tmp/kory-notes-properties-a';
const PROJECT_B = '/tmp/kory-notes-properties-b';

let database: Database;

function createSchema(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      folder_path TEXT NOT NULL DEFAULT '/',
      tags TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0,
      include_in_context INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'markdown',
      project_root TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      trashed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const migration = MIGRATIONS.find((candidate) => candidate.version === '0039');
  if (!migration) throw new Error('0039 Notes properties/Bases migration is missing');
  db.exec(migration.up);
}

function insertNote(
  id: string,
  title: string,
  content: string,
  projectRoot = PROJECT_A,
  options: { revision?: number; trashed?: boolean } = {},
): void {
  database
    .query(
      `
      INSERT INTO notes (
        id, title, content, folder_path, tags, pinned, include_in_context,
        format, project_root, revision, trashed_at, created_at, updated_at
      ) VALUES (?, ?, ?, '/', '[]', 0, 0, 'markdown', ?, ?, ?, 1700000000, 1700000000)
    `,
    )
    .run(
      id,
      title,
      content,
      projectRoot,
      options.revision ?? 1,
      options.trashed ? Date.now() : null,
    );
}

const tableDefinition = (filter?: NoteBaseDefinition['filter']): NoteBaseDefinition => ({
  version: 1,
  ...(filter ? { filter } : {}),
  sort: [],
  view: {
    kind: 'table',
    fields: [
      { source: 'system', field: 'title' },
      { source: 'property', key: 'status', type: 'text' },
    ],
  },
});

beforeEach(() => {
  database = new Database(':memory:');
  createSchema(database);
});

afterEach(() => database.close());

describe('typed note property projection', () => {
  test('repairs supported values atomically and removes stale values on revision change', async () => {
    insertNote(
      'alpha',
      'Alpha',
      `---
status: Ready
priority: 3
done: true
due: 2026-08-30
tags:
  - Agentic
  - Notes
---
# Alpha`,
    );

    const first = await repairProjectPropertyProjections(PROJECT_A, database);
    expect(first.repaired).toBe(1);
    assertProjectPropertyProjectionCurrent(PROJECT_A, database);
    const projection = await getNotePropertyProjection('alpha', PROJECT_A, database);
    expect(projection.status).toBe('valid');
    expect(projection.properties).toEqual(
      expect.arrayContaining([
        { key: 'status', type: 'text', value: 'Ready' },
        { key: 'priority', type: 'number', value: 3 },
        { key: 'done', type: 'checkbox', value: true },
        { key: 'due', type: 'date', value: '2026-08-30' },
      ]),
    );
    expect(
      database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM note_property_items')
        .get()?.count,
    ).toBe(2);

    database
      .query('UPDATE notes SET content = ?, revision = 2 WHERE id = ?')
      .run('---\nstatus: Blocked\n---\n# Alpha', 'alpha');
    const second = await getNotePropertyProjection('alpha', PROJECT_A, database);
    expect(second.revision).toBe(2);
    expect(second.properties).toEqual([{ key: 'status', type: 'text', value: 'Blocked' }]);
    expect(
      database
        .query<{ revision: number }, [string]>(
          'SELECT projected_revision AS revision FROM note_property_documents WHERE note_id = ?',
        )
        .get('alpha')?.revision,
    ).toBe(2);
  });

  test('fails closed on malformed frontmatter and repairs after source correction', async () => {
    insertNote('broken', 'Broken', '---\nstatus: stale\n# no closing delimiter');
    const broken = await getNotePropertyProjection('broken', PROJECT_A, database);
    expect(broken.status).toBe('invalid');
    expect(broken.properties).toEqual([]);
    expect(broken.warnings[0]?.message).toMatch(/not closed|closing/i);

    database
      .query('UPDATE notes SET content = ?, revision = 2 WHERE id = ?')
      .run('---\nstatus: repaired\n---\n# fixed', 'broken');
    const repaired = await getNotePropertyProjection('broken', PROJECT_A, database);
    expect(repaired.status).toBe('valid');
    expect(repaired.properties).toEqual([{ key: 'status', type: 'text', value: 'repaired' }]);
  });

  test('never repairs or exposes a note from another project', async () => {
    insertNote('foreign', 'Foreign', '---\nstatus: foreign\n---\n', PROJECT_B);
    const report = await repairProjectPropertyProjections(PROJECT_A, database);
    expect(report.repaired).toBe(0);
    expect(
      database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM note_property_documents')
        .get()?.count,
    ).toBe(0);
    await expect(getNotePropertyProjection('foreign', PROJECT_A, database)).rejects.toThrow(
      /Note not found/,
    );
  });

  test('rebuilds a same-revision projection when a note moves between project scopes', async () => {
    insertNote('moved', 'Moved', '---\nstatus: scoped\n---\n');
    await repairProjectPropertyProjections(PROJECT_A, database);
    expect(
      database
        .query<{ projectRoot: string }, [string]>(
          `SELECT project_root AS projectRoot
           FROM note_property_documents WHERE note_id = ?`,
        )
        .get('moved')?.projectRoot,
    ).toBe(PROJECT_A);

    database.query('UPDATE notes SET project_root = ? WHERE id = ?').run(PROJECT_B, 'moved');
    const repaired = await repairProjectPropertyProjections(PROJECT_B, database);
    expect(repaired.repaired).toBe(1);
    expect((await getNotePropertyProjection('moved', PROJECT_B, database)).properties).toEqual([
      { key: 'status', type: 'text', value: 'scoped' },
    ]);
    expect(
      database
        .query<{ projectRoot: string }, [string]>(
          `SELECT project_root AS projectRoot
           FROM note_properties WHERE note_id = ?`,
        )
        .get('moved')?.projectRoot,
    ).toBe(PROJECT_B);
  });

  test('reports mixed observed types without coercing either source value', async () => {
    insertNote('numeric', 'Numeric', '---\nscore: 8\n---\n');
    insertNote('textual', 'Textual', '---\nscore: high\n---\n');
    const schemas = await listNotePropertySchemas(PROJECT_A, database);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      key: 'score',
      usageCount: 2,
      invalidCount: 1,
    });
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM note_properties WHERE normalized_key = 'score'`,
        )
        .get()?.count,
    ).toBe(2);
  });
});

describe('persistent saved Bases', () => {
  test('uses optimistic revisions, immutable history, Trash, and project isolation', () => {
    const created = createNoteBase(
      { name: 'Work ledger', definition: tableDefinition() },
      PROJECT_A,
      database,
    );
    expect(created.revision).toBe(1);
    expect(getNoteBase(created.id, PROJECT_B, {}, database)).toBeNull();
    expect(() =>
      updateNoteBase(created.id, { expectedRevision: 99, name: 'Wrong' }, PROJECT_A, database),
    ).toThrow(/changed after it was opened/i);

    const updated = updateNoteBase(
      created.id,
      { expectedRevision: 1, name: 'Evidence ledger' },
      PROJECT_A,
      database,
    );
    expect(updated.revision).toBe(2);
    const trashed = trashNoteBase(created.id, 2, PROJECT_A, database);
    expect(trashed.revision).toBe(3);
    expect(trashed.trashedAt).toBeInstanceOf(Date);
    expect(listNoteBases(PROJECT_A, {}, database)).toEqual([]);
    const restored = restoreNoteBase(created.id, 3, PROJECT_A, database);
    expect(restored.revision).toBe(4);
    expect(restored.trashedAt).toBeUndefined();
    expect(
      listNoteBaseRevisions(created.id, PROJECT_A, database).map((row) => row.operation),
    ).toEqual(['restore', 'trash', 'update', 'create']);

    // Names and IDs are isolated by resolved project scope.
    expect(
      createNoteBase(
        { name: 'Evidence ledger', definition: tableDefinition() },
        PROJECT_B,
        database,
      ).name,
    ).toBe('Evidence ledger');
  });

  test('rejects unbounded or untyped query definitions before persistence', () => {
    expect(() =>
      validateNoteBaseDefinition({ version: 1, sort: [], view: { kind: 'grid' } }),
    ).toThrow(/view kind/i);
    let nested: unknown = {
      kind: 'predicate',
      field: { source: 'system', field: 'title' },
      operator: 'eq',
      value: 'x',
    };
    for (let depth = 0; depth < 4; depth++) {
      nested = { kind: 'group', operator: 'and', filters: [nested] };
    }
    expect(() =>
      validateNoteBaseDefinition({
        version: 1,
        filter: nested,
        sort: [],
        view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
      }),
    ).toThrow(/depth/i);
    expect(() =>
      validateNoteBaseDefinition({
        version: 1,
        filter: {
          kind: 'predicate',
          field: { source: 'system', field: 'title; DROP TABLE notes' },
          operator: 'eq',
          value: 'x',
        },
        sort: [],
        view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
      }),
    ).toThrow(/unknown system field/i);
    expect(() =>
      validateNoteBaseDefinition({
        version: 1,
        filter: {
          kind: 'predicate',
          field: { source: 'system', field: 'updated' },
          operator: 'gte',
          value: 'not-a-date',
        },
        sort: [],
        view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
      }),
    ).toThrow(/valid ISO value/i);
  });

  test('sorts and filters offset date-times by their canonical instant', async () => {
    insertNote('early-instant', 'Early instant', '---\nreviewed: 2026-08-30T23:30:00+02:00\n---\n');
    insertNote('late-instant', 'Late instant', '---\nreviewed: 2026-08-30T22:00:00Z\n---\n');
    const result = await previewNoteBase(
      {
        version: 1,
        filter: {
          kind: 'predicate',
          field: { source: 'property', key: 'reviewed', type: 'datetime' },
          operator: 'gte',
          value: '2026-08-30T21:45:00Z',
        },
        sort: [
          {
            field: { source: 'property', key: 'reviewed', type: 'datetime' },
            direction: 'desc',
          },
        ],
        view: {
          kind: 'table',
          fields: [
            { source: 'system', field: 'title' },
            { source: 'property', key: 'reviewed', type: 'datetime' },
          ],
        },
      },
      {},
      PROJECT_A,
      database,
    );

    expect(result.rows.map((row) => row.id)).toEqual(['late-instant']);
  });

  test('filters, sorts, groups and pages over the indexed projection deterministically', async () => {
    insertNote('a', 'Alpha', '---\nstatus: ready\npriority: 2\n---\n');
    insertNote('b', 'Beta', '---\nstatus: blocked\npriority: 5\n---\n');
    insertNote('c', 'Charlie', '---\nstatus: ready\npriority: 7\n---\n');
    insertNote('z', 'Trashed', '---\nstatus: ready\npriority: 99\n---\n', PROJECT_A, {
      trashed: true,
    });
    const definition: NoteBaseDefinition = {
      version: 1,
      filter: {
        kind: 'group',
        operator: 'and',
        filters: [
          {
            kind: 'predicate',
            field: { source: 'property', key: 'status', type: 'text' },
            operator: 'eq',
            value: 'READY',
          },
          {
            kind: 'predicate',
            field: { source: 'property', key: 'priority', type: 'number' },
            operator: 'gte',
            value: 2,
          },
        ],
      },
      sort: [
        {
          field: { source: 'property', key: 'priority', type: 'number' },
          direction: 'desc',
        },
      ],
      groupBy: { source: 'property', key: 'status', type: 'text' },
      view: {
        kind: 'table',
        fields: [
          { source: 'system', field: 'title' },
          { source: 'property', key: 'status', type: 'text' },
          { source: 'property', key: 'priority', type: 'number' },
        ],
      },
    };
    const base = createNoteBase({ name: 'Ready work', definition }, PROJECT_A, database);
    const first = await queryNoteBase(base.id, { limit: 1 }, PROJECT_A, database);
    expect(first.rows.map((row) => row.id)).toEqual(['c']);
    expect(first.rows[0]?.properties).toEqual({ priority: 7, status: 'ready' });
    expect(first.rows[0]?.groupValue).toBe('ready');
    expect(first.hasMore).toBe(true);
    const second = await queryNoteBase(base.id, { limit: 1, offset: 1 }, PROJECT_A, database);
    expect(second.rows.map((row) => row.id)).toEqual(['a']);
    expect(second.hasMore).toBe(false);
  });

  test('repairs a newly changed note before returning the next Base result', async () => {
    insertNote('changing', 'Changing', '---\nstatus: open\n---\n');
    const base = createNoteBase(
      {
        name: 'Open work',
        definition: tableDefinition({
          kind: 'predicate',
          field: { source: 'property', key: 'status', type: 'text' },
          operator: 'eq',
          value: 'open',
        }),
      },
      PROJECT_A,
      database,
    );
    expect((await queryNoteBase(base.id, {}, PROJECT_A, database)).rows).toHaveLength(1);
    database
      .query('UPDATE notes SET content = ?, revision = revision + 1 WHERE id = ?')
      .run('---\nstatus: closed\n---\n', 'changing');
    expect((await queryNoteBase(base.id, {}, PROJECT_A, database)).rows).toHaveLength(0);
  });

  test('keeps missing list values out of negative predicates while empty remains explicit', async () => {
    insertNote('present', 'Present', '---\nlabels: [alpha]\n---\n');
    insertNote('empty', 'Empty', '---\nlabels: []\n---\n');
    insertNote('missing', 'Missing', '# no labels');
    const baseShape = {
      version: 1,
      sort: [{ field: { source: 'system', field: 'title' }, direction: 'asc' }],
      view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
    };
    const negative = await previewNoteBase(
      {
        ...baseShape,
        filter: {
          kind: 'predicate',
          field: { source: 'property', key: 'labels', type: 'list' },
          operator: 'not_contains',
          value: 'beta',
        },
      },
      {},
      PROJECT_A,
      database,
    );
    expect(negative.rows.map((row) => row.id)).toEqual(['empty', 'present']);

    const empty = await previewNoteBase(
      {
        ...baseShape,
        filter: {
          kind: 'predicate',
          field: { source: 'property', key: 'labels', type: 'list' },
          operator: 'is_empty',
        },
      },
      {},
      PROJECT_A,
      database,
    );
    expect(empty.rows.map((row) => row.id)).toEqual(['empty', 'missing']);
  });

  test('binds adversarial property keys as values instead of SQL', async () => {
    insertNote('safe', 'Safe', '---\nstatus: safe\n---\n');
    const result = await previewNoteBase(
      {
        version: 1,
        filter: {
          kind: 'predicate',
          field: { source: 'property', key: "status') OR 1=1 --", type: 'text' },
          operator: 'eq',
          value: 'safe',
        },
        sort: [],
        view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
      },
      {},
      PROJECT_A,
      database,
    );
    expect(result.rows).toEqual([]);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM notes').get()?.count,
    ).toBe(1);
  });
});
