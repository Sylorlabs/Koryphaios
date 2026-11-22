/**
 * Compressed, content-hash-deduplicated revision history.
 *
 * Revision text lives in `note_revision_blobs` exactly once per distinct body
 * (zstd at level 9); `note_revisions` rows are immutable metadata pointing at a
 * blob. A note "has history" once it has at least one revision row. Project
 * documents start untracked — their history is the file itself — and become
 * tracked the first time they are edited through Koryphaios. DB-native notes
 * are tracked from their create snapshot.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { projectDocumentIdentity } from './note-document';

/** Persist `text` once and return the blob id. Callers already hold the body,
 * so blob writes never touch the filesystem or `notes.content`. */
export function writeRevisionBlob(text: string, database: Database = getDb()): number {
  const raw = Buffer.from(text, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  database.run(
    `INSERT OR IGNORE INTO note_revision_blobs (hash, codec, raw_bytes, data)
     VALUES (?, 'zstd', ?, ?)`,
    [hash, raw.length, Bun.zstdCompressSync(raw, { level: 9 })],
  );
  const row = database
    .query<{ id: number }, [string]>('SELECT id FROM note_revision_blobs WHERE hash = ?')
    .get(hash);
  if (!row) throw new Error('note_revision_blobs insert did not produce a row');
  return row.id;
}

/** Delete blobs no revision row references. Run once per batch/operation that
 * removes `note_revisions` rows — directly or via the notes delete cascade. */
export function gcRevisionBlobs(database: Database = getDb()): number {
  return database.run(
    `DELETE FROM note_revision_blobs
     WHERE id NOT IN (SELECT content_blob_id FROM note_revisions)`,
  ).changes;
}

interface StoredRevisionColumns {
  revision: number;
  project_root: string | null;
  title: string;
  folder_path: string;
  tags: string;
  pinned: number;
  include_in_context: number;
  format: string;
  trashed_at: number | null;
  trash_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** Snapshot the note row's current state, supplying the body the caller
 * already holds (never re-read from `notes.content`, which is '' for
 * file-backed documents). Equivalent to the old `revisionSnapshotSql`, minus
 * the content column read. */
export function snapshotNoteRowById(
  noteId: string,
  operation: string,
  content: string,
  database: Database = getDb(),
  snapshotAt = Date.now(),
): void {
  const row = database
    .query<StoredRevisionColumns, [string]>(
      `SELECT revision, project_root, title, folder_path, tags, pinned,
        include_in_context, format, trashed_at, trash_reason, created_at, updated_at
       FROM notes WHERE id = ?`,
    )
    .get(noteId);
  if (!row) return;
  const identity = projectDocumentIdentity(noteId);
  snapshotNoteRevision(
    {
      noteId,
      revision: row.revision,
      projectRoot: row.project_root ?? identity?.projectRoot ?? '',
      title: row.title,
      content,
      folderPath: row.folder_path,
      tags: row.tags,
      pinned: row.pinned,
      includeInContext: row.include_in_context,
      format: row.format,
      sourcePath: identity?.sourcePath ?? null,
      trashedAt: row.trashed_at,
      trashReason: row.trash_reason,
      noteCreatedAt: row.created_at,
      noteUpdatedAt: row.updated_at,
    },
    operation,
    database,
    snapshotAt,
  );
}

/** The single reader for stored revision text. Codec is validated and the
 * decoded length checked against the recorded raw size. */
export function readRevisionContent(blobId: number, database: Database = getDb()): string {
  const row = database
    .query<{ codec: string; raw_bytes: number; data: Uint8Array }, [number]>(
      'SELECT codec, raw_bytes, data FROM note_revision_blobs WHERE id = ?',
    )
    .get(blobId);
  if (!row) throw new Error(`note_revision_blobs row ${blobId} is missing`);
  const raw =
    row.codec === 'zstd'
      ? Bun.zstdDecompressSync(row.data)
      : row.codec === 'none'
        ? row.data
        : (() => {
            throw new Error(`note_revision_blobs row ${blobId} uses unknown codec ${row.codec}`);
          })();
  if (raw.byteLength !== row.raw_bytes) {
    throw new Error(
      `note_revision_blobs row ${blobId} decoded to ${raw.byteLength} bytes, expected ${row.raw_bytes}`,
    );
  }
  return new TextDecoder('utf-8').decode(raw);
}

/** A note has history once at least one revision row exists. */
export function isNoteTracked(noteId: string, database: Database = getDb()): boolean {
  return !!database
    .query<{ ok: number }, [string]>(
      'SELECT EXISTS(SELECT 1 FROM note_revisions WHERE note_id = ?) AS ok',
    )
    .get(noteId)?.ok;
}

export interface NoteRevisionSnapshot {
  noteId: string;
  revision: number;
  projectRoot: string;
  title: string;
  /** The body being snapshotted — supplied by the caller, never re-read. */
  content: string;
  folderPath: string;
  tags: string;
  pinned: number;
  includeInContext: number;
  format: string;
  sourcePath: string | null;
  /** Stored units, matching the notes columns: trashed_at is epoch ms,
   * note_created_at / note_updated_at are epoch seconds. */
  trashedAt: number | null;
  trashReason: string | null;
  noteCreatedAt: number;
  noteUpdatedAt: number;
}

/** Insert one immutable revision row, deduplicating its body through the blob
 * table. `INSERT OR IGNORE` keeps the (note_id, revision) contract: the first
 * snapshot at a revision wins, exactly like the old UNIQUE key. */
export function snapshotNoteRevision(
  snapshot: NoteRevisionSnapshot,
  operation: string,
  database: Database = getDb(),
  snapshotAt = Date.now(),
): void {
  const blobId = writeRevisionBlob(snapshot.content, database);
  database.run(
    `INSERT OR IGNORE INTO note_revisions (
      note_id, revision, project_root, operation, title, content_blob_id,
      content_bytes, folder_path, tags, pinned, include_in_context, format,
      source_path, trashed_at, trash_reason, note_created_at, note_updated_at,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.noteId,
      snapshot.revision,
      snapshot.projectRoot,
      operation,
      snapshot.title,
      blobId,
      Buffer.byteLength(snapshot.content, 'utf8'),
      snapshot.folderPath,
      snapshot.tags,
      snapshot.pinned,
      snapshot.includeInContext,
      snapshot.format,
      snapshot.sourcePath,
      snapshot.trashedAt,
      snapshot.trashReason,
      snapshot.noteCreatedAt,
      snapshot.noteUpdatedAt,
      snapshotAt,
    ],
  );
}
