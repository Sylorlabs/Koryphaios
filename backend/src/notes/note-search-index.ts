/**
 * The contentless notes full-text index and its note_id ↔ rowid map.
 *
 * `notes_fts` is a contentless FTS5 table (`content=''`, `contentless_delete=1`,
 * `detail='column'`): it stores tokens and rowids only, so indexing a document
 * never duplicates its text. `notes_fts_rowids` (from migration 0058) maps each
 * note id to its FTS rowid because a contentless index cannot return the id.
 * All writes go through rowid seeks; every mutation path calls these helpers
 * inside its own transaction.
 */

import type { Database } from 'bun:sqlite';
import { getDb } from '../db';

/** FROM/WHERE fragment joining `notes` to indexed FTS rows through the map.
 * `notes_fts MATCH <expr>` must be added by the caller (the column name is the
 * table name, so the alias-free form is required). */
export const NOTES_FTS_JOIN =
  'FROM notes_fts JOIN notes_fts_rowids ON notes_fts_rowids.fts_rowid = notes_fts.rowid JOIN notes ON notes.id = notes_fts_rowids.note_id';

/** Index `text` under `noteId`, replacing any stale rowid mapping. Safe to
 * call repeatedly — the delete makes it idempotent and self-healing. */
export function setNoteSearchText(
  noteId: string,
  title: string,
  text: string,
  tags: string,
  database: Database = getDb(),
): void {
  database.run(
    `DELETE FROM notes_fts
     WHERE rowid = (SELECT fts_rowid FROM notes_fts_rowids WHERE note_id = ?)`,
    [noteId],
  );
  database.run(`DELETE FROM notes_fts_rowids WHERE note_id = ?`, [noteId]);
  database.run(`INSERT INTO notes_fts_rowids (note_id) VALUES (?)`, [noteId]);
  database.run(
    `INSERT INTO notes_fts(rowid, title, content, tags)
     VALUES ((SELECT fts_rowid FROM notes_fts_rowids WHERE note_id = ?), ?, ?, ?)`,
    [noteId, title, text, tags],
  );
}

/** Remove a note's index row and its map entry (hard deletes and vault-wide
 * purges; ordinary trash intentionally stays indexed). */
export function removeNoteSearchText(noteId: string, database: Database = getDb()): void {
  database.run(
    `DELETE FROM notes_fts
     WHERE rowid = (SELECT fts_rowid FROM notes_fts_rowids WHERE note_id = ?)`,
    [noteId],
  );
  database.run(`DELETE FROM notes_fts_rowids WHERE note_id = ?`, [noteId]);
}
