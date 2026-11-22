/**
 * One-time, resumable storage compaction for file-backed notes (migration 0059).
 *
 * Runs in the background after migrations. It is idempotent and resumable:
 * progress lives in `notes_compaction_state`, every step is batched, and the
 * loop yields between batches so `/api/health` stays responsive on large
 * vaults. Steps:
 *
 *   a. Purge `project-document:` rows whose source path sits under an ignored
 *      or hidden directory (`.worktrees`, `.codex`, `node_modules` …) — pure
 *      mirrors of files that stay on disk.
 *   b. Drain `note_revisions_legacy` into the blob store. A chain is kept only
 *      when it holds ≥2 distinct bodies or the note is DB-native; then the
 *      legacy table is dropped.
 *   c. Hard-delete untracked project documents whose source file no longer
 *      exists — nothing is lost that the filesystem did not already lose.
 *   d. Backfill every note: body from its source file (else stored content),
 *      derived columns, contentless-FTS row, and `content = ''` where the file
 *      backs the body.
 *   e. `PRAGMA auto_vacuum = INCREMENTAL` then `VACUUM`, once — deferred to the
 *      NEXT startup, where it runs synchronously before the port binds and is
 *      reported as the `database-vacuum` startup phase. Keeping it out of the
 *      background loop means a multi-gigabyte vacuum can never freeze
 *      /api/health after listen.
 */

import { existsSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { serverLog } from '../logger';
import {
  isIgnoredDocumentPath,
  projectDocumentIdentity,
  readNoteBody,
  resolveProjectDocument,
  storedNoteContent,
  noteContentFields,
} from './note-document';
import { hardDeleteNoteRows } from './note-cascade';
import { setNoteSearchText } from './note-search-index';
import { isNoteTracked, writeRevisionBlob } from './note-revision-store';

const STATE_KEY = 'compaction';
const BATCH_NOTES = 200;
const BATCH_REVISION_CHAINS = 50;
/** Rows scanned per purge call. */
const PURGE_SCAN_BATCH = 500;
/** Rows hard-deleted per purge call. `hardDeleteNoteRows` costs ~7ms/row on a
 * large DB, so the delete chunk stays small enough that /api/health answers
 * between calls even when the scan page is much larger. */
const BATCH_PURGE = 50;
const RECLAIM_THRESHOLD_BYTES = 16 * 1024 * 1024;

type CompactionStep =
  | 'purge_mirrors'
  | 'drain_revisions'
  | 'purge_orphans'
  | 'backfill_notes'
  | 'vacuum'
  | 'done';

interface CompactionState {
  step: CompactionStep;
  /** Last processed key (note id for a/c/d, legacy note_id for b). */
  cursor: string;
  /** Steps schema version — a `done` state from an older run re-enters at
   * purge_mirrors once so newly added steps execute. */
  v?: number;
}

export interface NotesCompactionReport {
  purgedMirrorRows: number;
  purgedOrphanRows: number;
  revisionChainsKept: number;
  revisionChainsDropped: number;
  revisionRowsKept: number;
  notesBackfilled: number;
  vacuumed: boolean;
  stepMs: Record<string, number>;
}

const COMPACTION_VERSION = 2;

function loadState(db: Database): CompactionState {
  const row = db
    .query<{ value: string }, [string]>(
      'SELECT value FROM notes_compaction_state WHERE key = ?',
    )
    .get(STATE_KEY);
  const initial = { step: 'purge_mirrors' as const, cursor: '', v: COMPACTION_VERSION };
  if (!row) return initial;
  try {
    const state = JSON.parse(row.value) as CompactionState;
    // A database that already finished an older compaction re-runs once from
    // the top so new steps (hidden-dir purge, untracked-orphan delete) apply.
    if (state.step === 'done' && (state.v ?? 1) < COMPACTION_VERSION) return initial;
    return state;
  } catch {
    return initial;
  }
}

function saveState(db: Database, state: CompactionState): void {
  db.run(
    'INSERT INTO notes_compaction_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [STATE_KEY, JSON.stringify(state)],
  );
}

function yieldBetweenBatches(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sourceUnderIgnoredDir(noteId: string): boolean {
  const identity = projectDocumentIdentity(noteId);
  if (!identity) return false;
  return isIgnoredDocumentPath(identity.sourcePath);
}

/** Step a — hard-delete ignored/hidden-directory project-document mirrors and
 * every row that references them. The files stay on disk; these rows are
 * duplicates. Each call scans one page of up to PURGE_SCAN_BATCH ids but
 * hard-deletes at most BATCH_PURGE of them; when a page holds more matches
 * than that, the cursor stops at the last deleted id (deleted rows drop out
 * of the scan, so nothing is skipped or revisited) and the next call deletes
 * the next chunk. A restart resumes from the persisted cursor and the event
 * loop is serviced between calls. */
async function purgeIgnoredMirrors(
  db: Database,
  state: CompactionState,
  report: NotesCompactionReport,
): Promise<'done' | 'yield'> {
  const rows = db
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM notes WHERE id LIKE 'project-document:%' AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(state.cursor, PURGE_SCAN_BATCH);
  if (rows.length === 0) return 'done';
  const victims = rows.map((row) => row.id).filter(sourceUnderIgnoredDir);
  const chunk = victims.slice(0, BATCH_PURGE);
  if (chunk.length > 0) {
    hardDeleteNoteRows(chunk, db);
    report.purgedMirrorRows += chunk.length;
  }
  const stoppedEarly = victims.length > BATCH_PURGE;
  state.cursor = stoppedEarly ? chunk[chunk.length - 1]! : rows[rows.length - 1]!.id;
  saveState(db, state);
  return !stoppedEarly && rows.length < PURGE_SCAN_BATCH ? 'done' : 'yield';
}

interface LegacyRevisionRow {
  note_id: string;
  revision: number;
  project_root: string;
  operation: string;
  title: string;
  content: string;
  content_bytes: number;
  folder_path: string;
  tags: string;
  pinned: number;
  include_in_context: number;
  format: string;
  source_path: string | null;
  trashed_at: number | null;
  trash_reason: string | null;
  note_created_at: number;
  note_updated_at: number;
  created_at: number;
}

/** Step b — drain legacy revisions into the deduplicated blob store. A chain is
 * kept only with ≥2 distinct bodies or for a DB-native note; project-document
 * chains whose every body is identical carry no information the file lacks. */
async function drainLegacyRevisions(
  db: Database,
  state: CompactionState,
  report: NotesCompactionReport,
): Promise<'done' | 'yield'> {
  // A re-run after an older compaction already dropped the table.
  if (
    !db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_revisions_legacy'`,
      )
      .get()
  )
    return 'done';
  const chains = db
    .query<{ note_id: string }, [string, number]>(
      `SELECT DISTINCT note_id FROM note_revisions_legacy WHERE note_id > ? ORDER BY note_id LIMIT ?`,
    )
    .all(state.cursor, BATCH_REVISION_CHAINS)
    .map((row) => row.note_id);
  if (chains.length === 0) return 'done';

  db.transaction(() => {
    for (const noteId of chains) {
      const rows = db
        .query<LegacyRevisionRow, [string]>(
          `SELECT * FROM note_revisions_legacy WHERE note_id = ? ORDER BY revision`,
        )
        .all(noteId);
      const note = db
        .query<{ id: string }, [string]>('SELECT id FROM notes WHERE id = ?')
        .get(noteId);
      const distinct = new Set(rows.map((row) => row.content));
      const keep =
        !!note && (distinct.size >= 2 || !noteId.startsWith('project-document:'));
      if (keep) {
        for (const row of rows) {
          const blobId = writeRevisionBlob(row.content, db);
          db.run(
            `INSERT OR IGNORE INTO note_revisions (
              note_id, revision, project_root, operation, title, content_blob_id,
              content_bytes, folder_path, tags, pinned, include_in_context, format,
              source_path, trashed_at, trash_reason, note_created_at,
              note_updated_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.note_id,
              row.revision,
              row.project_root,
              row.operation,
              row.title,
              blobId,
              row.content_bytes,
              row.folder_path,
              row.tags,
              row.pinned,
              row.include_in_context,
              row.format,
              row.source_path,
              row.trashed_at,
              row.trash_reason,
              row.note_created_at,
              row.note_updated_at,
              row.created_at,
            ],
          );
          report.revisionRowsKept++;
        }
        report.revisionChainsKept++;
      } else {
        report.revisionChainsDropped++;
      }
      db.run('DELETE FROM note_revisions_legacy WHERE note_id = ?', [noteId]);
      state.cursor = noteId;
    }
  })();
  saveState(db, state);
  return chains.length < BATCH_REVISION_CHAINS ? 'done' : 'yield';
}

/** Step c — hard-delete untracked project documents whose source file is gone.
 * An untracked row's only copy of its body was the file itself, so nothing
 * recoverable is lost; tracked rows keep `source_removed` trash instead.
 * Scan-page + delete-chunk cursor batching identical to the mirror purge. */
async function purgeOrphanedUntracked(
  db: Database,
  state: CompactionState,
  report: NotesCompactionReport,
): Promise<'done' | 'yield'> {
  const rows = db
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM notes WHERE id LIKE 'project-document:%' AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(state.cursor, PURGE_SCAN_BATCH);
  if (rows.length === 0) return 'done';
  const victims = rows
    .map((row) => row.id)
    .filter((id) => {
      const source = resolveProjectDocument(id);
      if (source && existsSync(source)) return false;
      return !isNoteTracked(id, db);
    });
  const chunk = victims.slice(0, BATCH_PURGE);
  if (chunk.length > 0) {
    hardDeleteNoteRows(chunk, db);
    report.purgedOrphanRows += chunk.length;
  }
  const stoppedEarly = victims.length > BATCH_PURGE;
  state.cursor = stoppedEarly ? chunk[chunk.length - 1]! : rows[rows.length - 1]!.id;
  saveState(db, state);
  return !stoppedEarly && rows.length < PURGE_SCAN_BATCH ? 'done' : 'yield';
}

/** Step d — backfill derived columns and the contentless index for every note
 * past the cursor. */
async function backfillNotes(
  db: Database,
  state: CompactionState,
  report: NotesCompactionReport,
): Promise<'done' | 'yield'> {
  const rows = db
    .query<
      { id: string; title: string; content: string; tags: string },
      [string, number]
    >(`SELECT id, title, content, tags FROM notes WHERE id > ? ORDER BY id LIMIT ?`)
    .all(state.cursor, BATCH_NOTES);
  if (rows.length === 0) return 'done';

  db.transaction(() => {
    for (const row of rows) {
      const body = readNoteBody(row);
      const fields = noteContentFields(body);
      db.run(
        `UPDATE notes SET content = ?, content_hash = ?, content_bytes = ?, aliases = ?, has_refs = ? WHERE id = ?`,
        [
          storedNoteContent(row.id, body),
          fields.contentHash,
          fields.contentBytes,
          fields.aliases,
          fields.hasRefs,
          row.id,
        ],
      );
      setNoteSearchText(row.id, row.title, body, row.tags, db);
      state.cursor = row.id;
      report.notesBackfilled++;
    }
  })();
  saveState(db, state);
  return rows.length < BATCH_NOTES ? 'done' : 'yield';
}

/** Whether the 0059 schema (and therefore this worker) applies to this DB. */
export function notesCompactionApplies(db: Database = getDb()): boolean {
  return !!db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes_compaction_state'`,
    )
    .get();
}

/** Free pages left behind by later bulk deletes (large sync removals). Called
 * after batched deletes once `auto_vacuum = INCREMENTAL` is armed by the
 * one-time startup vacuum (runPendingStartupVacuum). */
export function reclaimFreePagesIfNeeded(db: Database = getDb()): number {
  const pageSize = db.query<{ v: number }, []>('PRAGMA page_size').get()!.v;
  const freelist = db.query<{ v: number }, []>('PRAGMA freelist_count').get()!.v;
  if (freelist * pageSize <= RECLAIM_THRESHOLD_BYTES) return 0;
  db.run('PRAGMA incremental_vacuum');
  return freelist * pageSize;
}

/** Run the compaction to completion, resuming from persisted state. Safe to
 * call concurrently — the second caller returns the current progress report. */
let running: Promise<NotesCompactionReport> | null = null;

export function runNotesCompaction(db: Database = getDb()): Promise<NotesCompactionReport> {
  if (running) return running;
  const report: NotesCompactionReport = {
    purgedMirrorRows: 0,
    purgedOrphanRows: 0,
    revisionChainsKept: 0,
    revisionChainsDropped: 0,
    revisionRowsKept: 0,
    notesBackfilled: 0,
    vacuumed: false,
    stepMs: {},
  };
  running = (async () => {
    // Never do synchronous work in the caller's microtask: `startNotesCompaction`
    // must return before the first batch, and the HTTP server must be able to
    // answer /api/health while compaction runs.
    await yieldBetweenBatches();
    const state = loadState(db);
    // 'vacuum' is terminal for the background loop: the actual VACUUM is
    // deferred to the next startup (runPendingStartupVacuum) so a multi-minute
    // rebuild never freezes /api/health on a live server.
    while (state.step !== 'done' && state.step !== 'vacuum') {
      const stepStarted = Date.now();
      const stepRan = state.step;
      switch (state.step) {
        case 'purge_mirrors': {
          if ((await purgeIgnoredMirrors(db, state, report)) === 'done') {
            state.step = 'drain_revisions';
            state.cursor = '';
            saveState(db, state);
          }
          break;
        }
        case 'drain_revisions': {
          if ((await drainLegacyRevisions(db, state, report)) === 'done') {
            db.run('DROP TABLE IF EXISTS note_revisions_legacy');
            state.step = 'purge_orphans';
            state.cursor = '';
            saveState(db, state);
          }
          break;
        }
        case 'purge_orphans': {
          if ((await purgeOrphanedUntracked(db, state, report)) === 'done') {
            state.step = 'backfill_notes';
            state.cursor = '';
            saveState(db, state);
          }
          break;
        }
        case 'backfill_notes': {
          if ((await backfillNotes(db, state, report)) === 'done') {
            state.step = 'vacuum';
            state.cursor = '';
            saveState(db, state);
          }
          break;
        }
      }
      report.stepMs[stepRan] = (report.stepMs[stepRan] ?? 0) + (Date.now() - stepStarted);
      await yieldBetweenBatches();
    }
    return report;
  })()
    .then((result) => result)
    .finally(() => {
      running = null;
    });
  return running;
}

/** Step e, deferred: the one-time VACUUM the background loop schedules but
 * never runs. bootstrap calls this before the port binds — synchronous there
 * is fine because the `database-vacuum` startup-phase marker keeps the
 * desktop informed that the process is alive and working. Returns true when a
 * vacuum actually ran (and the compaction is now fully done). */
export function runPendingStartupVacuum(db: Database = getDb()): boolean {
  if (!notesCompactionApplies(db)) return false;
  if (loadState(db).step !== 'vacuum') return false;
  db.run('PRAGMA auto_vacuum = INCREMENTAL');
  db.run('VACUUM');
  saveState(db, { step: 'done', cursor: '', v: COMPACTION_VERSION });
  return true;
}

/** Startup seam: kick the worker in the background; failures are logged, never
 * fatal — a partially compacted DB is still fully functional. The kickoff is
 * deferred so the first batch never contends with the burst of first-load
 * requests that race a freshly bound port. */
export function startNotesCompaction(db: Database = getDb()): void {
  if (!notesCompactionApplies(db)) return;
  const timer = setTimeout(() => {
    void runNotesCompaction(db).then(
      (report) => serverLog.info(report, 'notes storage compaction finished'),
      (err: unknown) =>
        serverLog.error(
          { err: err instanceof Error ? err.message : String(err) },
          'notes storage compaction failed — it will resume on next start',
        ),
    );
  }, 15_000);
  timer.unref?.();
}
