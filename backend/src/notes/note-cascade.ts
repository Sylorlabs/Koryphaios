/**
 * Hard delete for note rows and everything that references them. Used by the
 * storage compaction (ignored-directory mirrors, untracked missing-source
 * documents) and the project sync orphan pass — places where a row carries
 * no information that is not recoverable from the filesystem, so recoverable
 * trash is the wrong tool. The files on disk are never touched.
 *
 * Leaf module: imports only other leaf helpers so any notes subsystem can use
 * it without an import cycle.
 */

import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { removeNoteSearchText } from './note-search-index';
import { gcRevisionBlobs } from './note-revision-store';

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

/** Atomically delete `ids` from `notes` plus every dependent table (links,
 * relationships and their history, attachments, drafts, property rows,
 * semantic vectors, revisions, FTS row + map entry), then garbage-collect
 * revision blobs left orphaned by the delete. One transaction per call —
 * callers batch `ids` themselves. */
export function hardDeleteNoteRows(ids: string[], database: Database = getDb()): void {
  if (ids.length === 0) return;
  const marks = placeholders(ids.length);
  database.transaction(() => {
    database.run(
      `DELETE FROM note_links WHERE from_note_id IN (${marks}) OR to_note_id IN (${marks})`,
      [...ids, ...ids],
    );
    database.run(
      `DELETE FROM note_relationships WHERE from_note_id IN (${marks}) OR to_note_id IN (${marks})`,
      [...ids, ...ids],
    );
    database.run(
      `DELETE FROM note_relationship_history WHERE from_note_id IN (${marks}) OR to_note_id IN (${marks})`,
      [...ids, ...ids],
    );
    database.run(`DELETE FROM note_attachments WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_drafts WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_property_documents WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_properties WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_property_items WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_semantic_vectors WHERE note_id IN (${marks})`, ids);
    database.run(`DELETE FROM note_revisions WHERE note_id IN (${marks})`, ids);
    // The legacy table exists only until the compaction drain drops it.
    if (
      database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_revisions_legacy'`,
        )
        .get()
    ) {
      database.run(`DELETE FROM note_revisions_legacy WHERE note_id IN (${marks})`, ids);
    }
    for (const id of ids) removeNoteSearchText(id, database);
    database.run(`DELETE FROM notes WHERE id IN (${marks})`, ids);
    gcRevisionBlobs(database);
  })();
}
