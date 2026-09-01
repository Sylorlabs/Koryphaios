import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../errors/types';
import {
  NoteDraftService,
  type CreateNoteDraftInput,
  type NoteDraftServiceOptions,
} from '../note-draft-service';
import { getLocalNotesPrincipalId } from '../notes-principal';

const databases: Database[] = [];
const temporaryRoots: string[] = [];

function createSchema(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE note_draft_principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL UNIQUE CHECK (kind IN ('local')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      project_root TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      trashed_at INTEGER
    );
    CREATE TABLE note_revisions (
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      project_root TEXT NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT,
      PRIMARY KEY (note_id, revision)
    );
    CREATE TABLE note_drafts (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES note_draft_principals(id) ON DELETE RESTRICT,
      project_root TEXT NOT NULL,
      note_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
      draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),
      base_title TEXT NOT NULL,
      source_path_at_base TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
      folder_path TEXT NOT NULL,
      tags TEXT NOT NULL,
      pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
      include_in_context INTEGER NOT NULL CHECK (include_in_context IN (0, 1)),
      format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_note_drafts_scope_updated
      ON note_drafts(principal_id, project_root, updated_at);
    CREATE INDEX idx_note_drafts_scope_note
      ON note_drafts(principal_id, project_root, note_id, updated_at);
    INSERT INTO note_draft_principals (id, kind, created_at)
    VALUES ('local-principal-test', 'local', 1);
  `);
}

function openDatabase(path = ':memory:'): Database {
  const database = new Database(path);
  databases.push(database);
  createSchema(database);
  return database;
}

function project(name: string): string {
  return resolve(tmpdir(), `kory-note-draft-${name}`);
}

function insertNote(
  database: Database,
  options: {
    id?: string;
    projectRoot?: string | null;
    revision?: number;
    title?: string;
    content?: string;
    trashedAt?: number | null;
    sourcePath?: string | null;
  } = {},
): string {
  const id = options.id ?? `note-${crypto.randomUUID()}`;
  const projectRoot = options.projectRoot ?? project('default');
  const revision = options.revision ?? 1;
  const title = options.title ?? 'Authoritative note';
  database.run(
    `INSERT INTO notes (id, title, content, project_root, revision, trashed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      options.content ?? 'authoritative body',
      projectRoot,
      revision,
      options.trashedAt ?? null,
    ],
  );
  database.run(
    `INSERT INTO note_revisions (note_id, revision, project_root, title, source_path)
     VALUES (?, ?, ?, ?, ?)`,
    [id, revision, projectRoot, title, options.sourcePath ?? null],
  );
  return id;
}

function draftInput(
  noteId: string,
  overrides: Partial<CreateNoteDraftInput> = {},
): CreateNoteDraftInput {
  return {
    noteId,
    baseRevision: 1,
    title: 'Draft title',
    content: 'unsaved body',
    folderPath: '/Drafts',
    tags: ['private', 'recovery'],
    pinned: true,
    includeInContext: false,
    format: 'markdown',
    ...overrides,
  };
}

function service(database: Database, options: NoteDraftServiceOptions = {}): NoteDraftService {
  let nextId = 0;
  let now = 10_000;
  return new NoteDraftService(database, {
    legacyProjectRoot: project('legacy'),
    contentLimitForProject: () => 5_000_000,
    idFactory: () => `draft-${++nextId}`,
    now: () => ++now,
    ...options,
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A persistence test may already have closed this handle.
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('crash-durable Notes drafts', () => {
  test('uses one durable local principal and fails closed when the migration invariant is absent', () => {
    const database = openDatabase();
    expect(getLocalNotesPrincipalId(database)).toBe('local-principal-test');
    expect(service(database).getLocalPrincipalId()).toBe('local-principal-test');

    database.run(`DELETE FROM note_draft_principals WHERE kind = 'local'`);
    expect(() => getLocalNotesPrincipalId(database)).toThrow(
      'expected exactly one durable local principal',
    );
  });

  test('persists a complete private branch and returns metadata-only lists', () => {
    const database = openDatabase();
    const projectRoot = project('complete');
    const noteId = insertNote(database, { projectRoot, title: 'Base title' });
    const drafts = service(database);

    const created = drafts.createDraft(
      draftInput(noteId, { content: 'private ✨ body', tags: ['z', 'a'] }),
      projectRoot,
    );
    expect(created).toMatchObject({
      id: 'draft-1',
      noteId,
      baseRevision: 1,
      draftRevision: 1,
      baseTitle: 'Base title',
      content: 'private ✨ body',
      contentBytes: Buffer.byteLength('private ✨ body'),
      tags: ['z', 'a'],
      state: 'recoverable',
      currentRevision: 1,
    });
    expect(created.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.createdAt).toEqual(new Date(10_001));

    const listed = drafts.listDrafts(projectRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('content');
    expect(listed[0]).not.toHaveProperty('tags');
    expect(drafts.getDraft(created.id, projectRoot)?.content).toBe('private ✨ body');
  });

  test('isolates every read and mutation by principal-owned project scope', () => {
    const database = openDatabase();
    const firstProject = project('scope-first');
    const secondProject = project('scope-second');
    const firstNote = insertNote(database, { projectRoot: firstProject });
    const secondNote = insertNote(database, { projectRoot: secondProject });
    const drafts = service(database);
    const created = drafts.createDraft(draftInput(firstNote), firstProject);

    expect(drafts.listDrafts(secondProject)).toEqual([]);
    expect(drafts.getDraft(created.id, secondProject)).toBeNull();
    expect(() =>
      drafts.updateDraft(
        created.id,
        {
          expectedDraftRevision: 1,
          title: 'Cross-scope overwrite',
          content: 'must not land',
          folderPath: '/',
          tags: [],
          pinned: false,
          includeInContext: false,
          format: 'markdown',
        },
        secondProject,
      ),
    ).toThrow(NotFoundError);
    expect(() => drafts.discardDraft(created.id, 1, secondProject)).toThrow(NotFoundError);
    expect(() => drafts.createDraft(draftInput(secondNote), firstProject)).toThrow(NotFoundError);
    expect(drafts.getDraft(created.id, firstProject)?.content).toBe('unsaved body');
  });

  test('uses optimistic draft revisions for updates and discards without losing newer data', () => {
    const database = openDatabase();
    const projectRoot = project('cas');
    const noteId = insertNote(database, { projectRoot });
    const drafts = service(database);
    const created = drafts.createDraft(draftInput(noteId), projectRoot);
    const updated = drafts.updateDraft(
      created.id,
      {
        expectedDraftRevision: created.draftRevision,
        title: 'Latest title',
        content: 'latest body',
        folderPath: '/Latest',
        tags: ['latest'],
        pinned: false,
        includeInContext: true,
        format: 'html',
      },
      projectRoot,
    );
    expect(updated).toMatchObject({
      draftRevision: 2,
      title: 'Latest title',
      content: 'latest body',
      folderPath: '/Latest',
      tags: ['latest'],
      pinned: false,
      includeInContext: true,
      format: 'html',
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());

    try {
      drafts.updateDraft(
        created.id,
        {
          expectedDraftRevision: 1,
          title: 'Stale',
          content: 'stale overwrite',
          folderPath: '/',
          tags: [],
          pinned: false,
          includeInContext: false,
          format: 'markdown',
        },
        projectRoot,
      );
      throw new Error('Expected stale draft conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toEqual({
        expectedDraftRevision: 1,
        currentDraftRevision: 2,
      });
    }
    expect(() => drafts.discardDraft(created.id, 1, projectRoot)).toThrow(ConflictError);
    expect(drafts.getDraft(created.id, projectRoot)?.content).toBe('latest body');

    drafts.discardDraft(created.id, 2, projectRoot);
    expect(drafts.getDraft(created.id, projectRoot)).toBeNull();
  });

  test('derives recoverable, conflict, trashed, and orphaned states without changing either side', () => {
    const database = openDatabase();
    const projectRoot = project('states');
    const noteId = insertNote(database, { projectRoot, content: 'server v1' });
    const drafts = service(database);
    const created = drafts.createDraft(
      draftInput(noteId, { content: 'unsaved client branch' }),
      projectRoot,
    );
    expect(created.state).toBe('recoverable');

    database.run(`UPDATE notes SET content = 'server v2', revision = 2 WHERE id = ?`, [noteId]);
    expect(drafts.getDraft(created.id, projectRoot)).toMatchObject({
      state: 'conflict',
      currentRevision: 2,
      content: 'unsaved client branch',
    });

    database.run(`UPDATE notes SET trashed_at = 12345, revision = 3 WHERE id = ?`, [noteId]);
    expect(drafts.getDraft(created.id, projectRoot)).toMatchObject({
      state: 'trashed',
      currentRevision: 3,
    });

    database.run(`DELETE FROM notes WHERE id = ?`, [noteId]);
    expect(drafts.getDraft(created.id, projectRoot)).toMatchObject({
      state: 'orphaned',
      content: 'unsaved client branch',
    });
    expect(database.query(`SELECT COUNT(*) AS count FROM note_drafts`).get()).toEqual({ count: 1 });
  });

  test('never mutates authoritative notes or immutable history', () => {
    const database = openDatabase();
    const projectRoot = project('non-authoritative');
    const noteId = insertNote(database, { projectRoot, content: 'authoritative' });
    const drafts = service(database);
    const created = drafts.createDraft(
      draftInput(noteId, { title: 'Unsaved', content: 'private unsaved content' }),
      projectRoot,
    );
    drafts.updateDraft(
      created.id,
      {
        expectedDraftRevision: 1,
        title: 'Still unsaved',
        content: 'new private content',
        folderPath: '/Private',
        tags: ['private'],
        pinned: false,
        includeInContext: false,
        format: 'markdown',
      },
      projectRoot,
    );

    expect(
      database
        .query(`SELECT title, content, revision, trashed_at FROM notes WHERE id = ?`)
        .get(noteId),
    ).toEqual({
      title: 'Authoritative note',
      content: 'authoritative',
      revision: 1,
      trashed_at: null,
    });
    expect(
      database.query(`SELECT title, revision FROM note_revisions WHERE note_id = ?`).all(noteId),
    ).toEqual([{ title: 'Authoritative note', revision: 1 }]);
  });

  test('enforces UTF-8 content, branch, project, and aggregate limits without eviction', () => {
    const database = openDatabase();
    const projectRoot = project('limits');
    const first = insertNote(database, { projectRoot });
    const second = insertNote(database, { projectRoot });

    const byteLimited = service(database, { contentLimitForProject: () => 4 });
    expect(() =>
      byteLimited.createDraft(draftInput(first, { content: '✨✨' }), projectRoot),
    ).toThrow(PayloadTooLargeError);
    expect(byteLimited.listDrafts(projectRoot)).toEqual([]);

    const capped = service(database, {
      maxDraftsPerNote: 1,
      maxDraftsPerProject: 2,
      maxAggregateBytes: 8,
    });
    const firstDraft = capped.createDraft(draftInput(first, { content: '1234' }), projectRoot);
    expect(() =>
      capped.createDraft(draftInput(first, { content: 'x', title: 'Second branch' }), projectRoot),
    ).toThrow(ConflictError);
    const secondDraft = capped.createDraft(draftInput(second, { content: '5678' }), projectRoot);
    expect(() =>
      capped.updateDraft(
        firstDraft.id,
        {
          expectedDraftRevision: firstDraft.draftRevision,
          title: 'Too large in aggregate',
          content: '12345',
          folderPath: '/',
          tags: [],
          pinned: false,
          includeInContext: false,
          format: 'markdown',
        },
        projectRoot,
      ),
    ).toThrow(ConflictError);
    expect(capped.getDraft(firstDraft.id, projectRoot)?.content).toBe('1234');
    expect(capped.getDraft(secondDraft.id, projectRoot)?.content).toBe('5678');

    const third = insertNote(database, { projectRoot });
    expect(() => capped.createDraft(draftInput(third, { content: '' }), projectRoot)).toThrow(
      ConflictError,
    );
    expect(capped.listDrafts(projectRoot)).toHaveLength(2);
  });

  test('validates future bases and derives safe project-document source identity', () => {
    const database = openDatabase();
    const projectRoot = project('project-document');
    const noteId =
      'project-document:' +
      Buffer.from(JSON.stringify([projectRoot, 'notes/design.md'])).toString('base64url');
    insertNote(database, { id: noteId, projectRoot, sourcePath: 'notes/design.md' });
    const drafts = service(database);

    expect(() => drafts.createDraft(draftInput(noteId, { baseRevision: 2 }), projectRoot)).toThrow(
      ValidationError,
    );
    expect(drafts.createDraft(draftInput(noteId), projectRoot).sourcePathAtBase).toBe(
      'notes/design.md',
    );
  });

  test('survives database close and reopen while bearer-independent ownership stays stable', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-note-draft-db-'));
    temporaryRoots.push(root);
    const path = join(root, 'drafts.db');
    const initialDatabase = openDatabase(path);
    const projectRoot = project('restart');
    const noteId = insertNote(initialDatabase, { projectRoot });
    const initial = service(initialDatabase);
    const created = initial.createDraft(
      draftInput(noteId, { content: 'survives full backend restart' }),
      projectRoot,
    );
    initialDatabase.close();

    const reopened = new Database(path);
    databases.push(reopened);
    const restarted = service(reopened, { idFactory: () => 'not-used' });
    expect(restarted.getLocalPrincipalId()).toBe('local-principal-test');
    expect(restarted.getDraft(created.id, projectRoot)).toMatchObject({
      content: 'survives full backend restart',
      draftRevision: 1,
      state: 'recoverable',
    });
  });
});
