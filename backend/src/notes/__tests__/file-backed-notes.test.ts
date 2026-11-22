import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(60000);
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, initDb } from '../../db';
import { ConflictError } from '../../errors/types';
import {
  getNote,
  getNoteRevision,
  listNoteRevisions,
  restoreNoteRevision,
  searchNotes,
  syncProjectDocuments,
  trashNote,
  updateNote,
} from '../notes-service';
import { projectDocumentId } from '../note-document';
import { writeRevisionBlob } from '../note-revision-store';
import {
  runNotesCompaction,
  runPendingStartupVacuum,
  startNotesCompaction,
} from '../notes-compaction';

let fixtureRoot = '';
let project = '';

function storedRow(id: string) {
  return (
    getDb()
      .query<
      {
        content: string;
        content_hash: string | null;
        content_bytes: number | null;
        aliases: string;
        has_refs: number;
      },
      [string]
    >('SELECT content, content_hash, content_bytes, aliases, has_refs FROM notes WHERE id = ?')
      .get(id) ?? null
  );
}

function ftsRowidFor(noteId: string): number | undefined {
  return getDb()
    .query<{ fts_rowid: number }, [string]>(
      'SELECT fts_rowid FROM notes_fts_rowids WHERE note_id = ?',
    )
    .get(noteId)?.fts_rowid;
}

function revisionCount(noteId: string): number {
  return getDb()
    .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = ?')
    .get(noteId)!.c;
}

function blobCount(): number {
  return getDb().query<{ c: number }, []>('SELECT COUNT(*) AS c FROM note_revision_blobs').get()!.c;
}

beforeAll(async () => {
  await initDb();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-file-backed-'));
  project = join(fixtureRoot, 'project');
  mkdirSync(project, { recursive: true });
});

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('file-backed project documents', () => {
  test('stores only derived columns while getNote reads the source file', async () => {
    writeFileSync(
      join(project, 'alpha.md'),
      '---\naliases: [Alpha Prime]\n---\n# Alpha\n\nuniqueseedword body\n',
    );
    await syncProjectDocuments(project);

    const id = projectDocumentId(project, 'alpha.md');
    const row = storedRow(id);
    expect(row.content).toBe('');
    expect(row.content_hash).toBe(
      createHash('sha256')
        .update('---\naliases: [Alpha Prime]\n---\n# Alpha\n\nuniqueseedword body\n', 'utf8')
        .digest('hex'),
    );
    expect(row.content_bytes).toBeGreaterThan(0);
    expect(JSON.parse(row.aliases)).toEqual(['Alpha Prime']);
    expect(ftsRowidFor(id)).toBeGreaterThan(0);

    const note = await getNote(id, project);
    expect(note?.content).toContain('uniqueseedword body');
    // The alias index resolves through the stored aliases column.
    expect((await searchNotes('uniqueseedword', 10, project)).map((n) => n.id)).toContain(id);
  });

  test('skips .worktrees checkouts during the document scan', async () => {
    mkdirSync(join(project, '.worktrees', 'wt-1'), { recursive: true });
    writeFileSync(join(project, '.worktrees', 'wt-1', 'mirror.md'), '# Mirrored\n');
    const result = await syncProjectDocuments(project);
    const mirrorId = projectDocumentId(project, '.worktrees/wt-1/mirror.md');
    expect(storedRow(mirrorId)).toBeNull();
    expect(
      getDb()
        .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM notes WHERE id = ?')
        .get(mirrorId)!.c,
    ).toBe(0);
    expect(result.discovered).toBeGreaterThan(0);
  });

  test('detects external edits via content hash and raises sourceChanged', async () => {
    writeFileSync(join(project, 'beta.md'), '# Beta\n\noriginal\n');
    await syncProjectDocuments(project);
    const id = projectDocumentId(project, 'beta.md');
    const before = await getNote(id, project);

    // External edit: disk text no longer matches the indexed hash.
    writeFileSync(join(project, 'beta.md'), '# Beta\n\nexternally rewritten\n');
    await expect(
      updateNote(id, { content: 'user edit\n', expectedRevision: before!.revision }, project),
    ).rejects.toBeInstanceOf(ConflictError);

    // The conflict refresh adopted the disk text as the new indexed state.
    const after = await getNote(id, project);
    expect(after?.content).toContain('externally rewritten');
    expect(storedRow(id).content_hash).toBe(
      createHash('sha256').update('# Beta\n\nexternally rewritten\n', 'utf8').digest('hex'),
    );
  });

  test('tracking starts on the first Koryphaios edit and dedupes identical bodies', async () => {
    writeFileSync(join(project, 'gamma.md'), '# Gamma\n\nv1 body\n');
    await syncProjectDocuments(project);
    const id = projectDocumentId(project, 'gamma.md');

    // Imported/synced documents are untracked — zero revision rows.
    expect(revisionCount(id)).toBe(0);
    const blobsBefore = blobCount();

    await updateNote(id, { content: '# Gamma\n\nv2 body\n' }, project);
    // Baseline (pre-edit) + the new revision.
    expect(revisionCount(id)).toBe(2);
    const revisions = await listNoteRevisions(id, project);
    expect(revisions.map((r) => r.revision).sort((a, b) => a - b)).toEqual([1, 2]);
    // The baseline captured the pre-edit file text.
    const baseline = await getNoteRevision(id, 1, project);
    expect(baseline?.content).toBe('# Gamma\n\nv1 body\n');

    // An identical-body edit reuses the same blob.
    const tracked = await getNote(id, project);
    await updateNote(
      id,
      { content: '# Gamma\n\nv2 body\n', expectedRevision: tracked!.revision },
      project,
    );
    expect(revisionCount(id)).toBe(3);
    expect(blobCount() - blobsBefore).toBe(2);

    // Restore-revision round-trips byte-exact through zstd.
    const current = await getNote(id, project);
    await restoreNoteRevision(id, 1, current!.revision, project);
    expect((await getNote(id, project))?.content).toBe('# Gamma\n\nv1 body\n');
    expect(readFileSync(join(project, 'gamma.md'), 'utf8')).toBe('# Gamma\n\nv1 body\n');
    const blob = getDb()
      .query<{ codec: string; raw_bytes: number; data: Uint8Array }, []>(
        `SELECT codec, raw_bytes, data FROM note_revision_blobs LIMIT 1`,
      )
      .get()!;
    expect(blob.codec).toBe('zstd');
    expect(Bun.zstdDecompressSync(blob.data).byteLength).toBe(blob.raw_bytes);
  });

  test('records a revision for external changes only once a document is tracked', async () => {
    writeFileSync(join(project, 'delta.md'), '# Delta\n\nuntracked v1\n');
    writeFileSync(join(project, 'epsilon.md'), '# Epsilon\n\ntracked v1\n');
    await syncProjectDocuments(project);
    const untrackedId = projectDocumentId(project, 'delta.md');
    const trackedId = projectDocumentId(project, 'epsilon.md');

    // Track epsilon through a Koryphaios edit first.
    await updateNote(trackedId, { content: '# Epsilon\n\ntracked v2\n' }, project);
    expect(revisionCount(trackedId)).toBe(2);
    expect(revisionCount(untrackedId)).toBe(0);

    writeFileSync(join(project, 'delta.md'), '# Delta\n\nuntracked v2\n');
    writeFileSync(join(project, 'epsilon.md'), '# Epsilon\n\ntracked v3 external\n');
    await syncProjectDocuments(project);

    expect(revisionCount(untrackedId)).toBe(0);
    expect(revisionCount(trackedId)).toBe(3);
    const external = await getNoteRevision(trackedId, 3, project);
    expect(external?.operation).toBe('external_sync');
    expect(external?.content).toBe('# Epsilon\n\ntracked v3 external\n');
  });

  test('trash of an untracked document writes no history', async () => {
    writeFileSync(join(project, 'zeta.md'), '# Zeta\n\nthrowaway\n');
    await syncProjectDocuments(project);
    const id = projectDocumentId(project, 'zeta.md');
    await trashNote(id, project);
    expect(revisionCount(id)).toBe(0);
  });
});

describe('notes storage compaction', () => {
  test('purges mirrors, drains legacy revisions, backfills, and is idempotent', async () => {
    const db = getDb();
    // Fixture: a worktree mirror row, an untracked doc whose source is missing,
    // a tracked doc whose source is missing, a stray blob with no referencing
    // revision, and legacy revision chains (one single-version, one
    // multi-version).
    const mirrorId = projectDocumentId(project, '.worktrees/wt-1/dup.md');
    const orphanId = projectDocumentId(project, 'gone.md');
    const trackedOrphanId = projectDocumentId(project, 'tracked-gone.md');
    const docId = projectDocumentId(project, 'alpha.md');
    const run = (sql: string, params: unknown[]) =>
      db.prepare(sql).run(...(params as never[]));
    run(
      `INSERT OR IGNORE INTO notes (id, title, content, folder_path, tags, revision, created_at, updated_at)
       VALUES (?, ?, '', '/Project', '[]', 1, 1, 1)`,
      [orphanId, 'gone'],
    );
    run(
      `INSERT OR IGNORE INTO notes (id, title, content, folder_path, tags, revision, created_at, updated_at)
       VALUES (?, ?, 'retained body', '/Project', '[]', 2, 1, 1)`,
      [trackedOrphanId, 'tracked-gone'],
    );
    run(
      `INSERT INTO note_revisions (
        note_id, revision, project_root, operation, title, content_blob_id,
        content_bytes, folder_path, tags, pinned, include_in_context, format,
        note_created_at, note_updated_at, created_at
      ) VALUES (?, ?, ?, 'create', ?, ?, ?, '/Project', '[]', 0, 0, 'markdown', 1, 1, 1)`,
      [trackedOrphanId, 1, project, 'tracked-gone', writeRevisionBlob('retained body', db), 13],
    );
    writeRevisionBlob('stray blob nobody references', db);
    run(
      `INSERT OR IGNORE INTO notes (id, title, content, folder_path, tags, revision, created_at, updated_at)
       VALUES (?, ?, '', '/Project', '[]', 1, 1, 1)`,
      [mirrorId, 'dup'],
    );
    run(
      `INSERT INTO note_revisions_legacy (
        note_id, revision, project_root, operation, title, content, content_bytes,
        folder_path, tags, pinned, include_in_context, format, note_created_at,
        note_updated_at, created_at
      ) VALUES (?, ?, ?, 'create', ?, ?, ?, '/Project', '[]', 0, 0, 'markdown', 1, 1, 1)`,
      [mirrorId, 1, project, 'dup', 'mirrored body', 13],
    );
    run(
      `INSERT INTO note_revisions_legacy (
        note_id, revision, project_root, operation, title, content, content_bytes,
        folder_path, tags, pinned, include_in_context, format, note_created_at,
        note_updated_at, created_at
      ) VALUES (?, ?, ?, 'create', ?, ?, ?, '/Project', '[]', 0, 0, 'markdown', 1, 1, 1)`,
      [docId, 1, project, 'alpha', 'same body', 9],
    );
    run(
      `INSERT INTO note_revisions_legacy (
        note_id, revision, project_root, operation, title, content, content_bytes,
        folder_path, tags, pinned, include_in_context, format, note_created_at,
        note_updated_at, created_at
      ) VALUES (?, ?, ?, 'update', ?, ?, ?, '/Project', '[]', 0, 0, 'markdown', 1, 2, 2)`,
      [docId, 2, project, 'alpha', 'different body', 14],
    );

    const report = await runNotesCompaction(db);

    // Mirror row and everything hanging off it is gone; the file was untouched.
    expect(
      db.query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM notes WHERE id = ?').get(mirrorId)!
        .c,
    ).toBe(0);
    expect(
      db
        .query<{ c: number }, [string]>(
          'SELECT COUNT(*) AS c FROM notes_fts_rowids WHERE note_id = ?',
        )
        .get(mirrorId)!.c,
    ).toBe(0);

    // Untracked + missing source is hard-deleted; tracked keeps its row.
    expect(
      db.query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM notes WHERE id = ?').get(orphanId)!
        .c,
    ).toBe(0);
    expect(
      db
        .query<{ c: number }, [string]>(
          'SELECT COUNT(*) AS c FROM notes WHERE id = ?',
        )
        .get(trackedOrphanId)!.c,
    ).toBe(1);
    expect(report.purgedOrphanRows).toBeGreaterThan(0);

    // Every surviving blob is referenced — the stray was collected (its id may
    // have been reused by a later drain insert, so assert the invariant, not
    // the id).
    expect(
      db
        .query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM note_revision_blobs
           WHERE id NOT IN (SELECT content_blob_id FROM note_revisions)`,
        )
        .get()!.c,
    ).toBe(0);
    expect(blobCount()).toBeGreaterThan(0);

    // The multi-version chain survived byte-exact through the blob store.
    expect(
      db
        .query<{ c: number }, [string]>(
          'SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = ?',
        )
        .get(docId)!.c,
    ).toBe(2);
    // Legacy table drained and dropped.
    expect(
      db
        .query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'note_revisions_legacy'`,
        )
        .get()!.c,
    ).toBe(0);

    // Backfill: derived fields populated, file-backed rows keep content ''.
    const alpha = storedRow(docId);
    expect(alpha.content).toBe('');
    expect(alpha.content_hash).not.toBeNull();
    expect(report.notesBackfilled).toBeGreaterThan(0);
    // The background run stops short of VACUUM — a multi-minute rebuild must
    // never freeze /api/health. The deferred one-time vacuum runs at the next
    // startup instead (runPendingStartupVacuum).
    expect(report.vacuumed).toBe(false);
    expect(runPendingStartupVacuum(db)).toBe(true);
    expect(runPendingStartupVacuum(db)).toBe(false);

    // Re-run is a no-op.
    const second = await runNotesCompaction(db);
    expect(second.notesBackfilled).toBe(0);
    expect(second.purgedMirrorRows).toBe(0);
  });

  test('startNotesCompaction defers its first batch and yields between batches', async () => {
    const db = getDb();
    const run = (sql: string, params: unknown[]) =>
      db.prepare(sql).run(...(params as never[]));
    // >2 delete chunks of ignored-directory mirrors (BATCH_PURGE is 50).
    for (let i = 0; i < 450; i++) {
      const id = projectDocumentId(project, `.worktrees/flood/doc-${i}.md`);
      run(
        `INSERT OR IGNORE INTO notes (id, title, content, folder_path, tags, revision, created_at, updated_at)
         VALUES (?, ?, '', '/Project', '[]', 1, 1, 1)`,
        [id, `flood-${i}`],
      );
    }
    const countFloods = () =>
      db
        .query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM notes WHERE title LIKE 'flood-%'`,
        )
        .get()!.c;
    // Any earlier compaction in this file left the state machine done; reset it
    // so this test observes a fresh run regardless of test order.
    db.run('DELETE FROM notes_compaction_state');

    startNotesCompaction(db);
    // The call returns before a single batch executes — the purge (and its
    // synchronous cascade) must never run inside the caller's microtask.
    expect(countFloods()).toBe(450);

    // With 450 mirror rows (>2 batches) the event loop must be serviced
    // between batches: a setImmediate callback fires before compaction ends.
    let finished = false;
    let serviced = false;
    const watcher = (async () => {
      while (!finished) {
        await new Promise((resolve) => setImmediate(resolve));
        serviced = true;
      }
    })();
    await runNotesCompaction(db);
    finished = true;
    await watcher;

    expect(serviced).toBe(true);
    expect(countFloods()).toBe(0);
  });
});
