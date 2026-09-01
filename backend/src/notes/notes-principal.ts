import type { Database } from 'bun:sqlite';

type LocalNotesPrincipalRow = { id: string };

/**
 * Resolve the durable owner for private Notes state.
 *
 * Local bearer sessions are intentionally process-local and rotate whenever
 * the backend restarts. Recovery data therefore belongs to the single local
 * installation principal stored in the owner-only application database, not
 * to a bearer session ID supplied by a caller.
 */
export function getLocalNotesPrincipalId(database: Database): string {
  const rows = database
    .query<LocalNotesPrincipalRow, []>(
      `SELECT id
       FROM note_draft_principals
       WHERE kind = 'local'
       ORDER BY id
       LIMIT 2`,
    )
    .all();

  if (rows.length !== 1 || !rows[0]?.id) {
    throw new Error(
      'Notes principal invariant failed: expected exactly one durable local principal',
    );
  }
  return rows[0].id;
}
