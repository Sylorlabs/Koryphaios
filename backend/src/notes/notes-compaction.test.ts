import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../db/migrations';
import { projectDocumentId } from './note-document';
import {
  notesCompactionApplies,
  runNotesCompaction,
  runPendingStartupVacuum,
} from './notes-compaction';

let db: Database;
let fixtureRoot = '';
let project = '';

function insertMirrorRows(count: number): string[] {
  const ids: string[] = [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notes (id, title, content, folder_path, tags, revision, created_at, updated_at)
     VALUES (?, ?, '', '/Project', '[]', 1, 1, 1)`,
  );
  for (let i = 0; i < count; i++) {
    const id = projectDocumentId(project, `.worktrees/flood/doc-${i}.md`);
    stmt.run(id, `flood-${i}`);
    ids.push(id);
  }
  return ids;
}

function projectDocumentCount(): number {
  return db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM notes WHERE id LIKE 'project-document:%'`)
    .get()!.c;
}

function compactionStep(): string {
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM notes_compaction_state WHERE key = ?`)
    .get('compaction');
  return row ? (JSON.parse(row.value) as { step: string }).step : '(missing)';
}

beforeAll(async () => {
  db = new Database(':memory:');
  await runMigrations(db);
  fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-compaction-'));
  project = join(fixtureRoot, 'project');
});

afterAll(() => {
  db.close();
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('notes storage compaction loop', () => {
  test('runNotesCompaction does no work synchronously in the caller', async () => {
    db.run('DELETE FROM notes_compaction_state');
    insertMirrorRows(3);
    expect(projectDocumentCount()).toBe(3);

    const pending = runNotesCompaction(db);
    // The IIFE must yield before its first batch: observed synchronously, the
    // purge cascade has not run yet.
    expect(projectDocumentCount()).toBe(3);

    await pending;
    expect(projectDocumentCount()).toBe(0);
  });

  test('the mirror purge deletes more than one delete-chunk across yields', async () => {
    db.run('DELETE FROM notes_compaction_state');
    // >2 hard-delete chunks (BATCH_PURGE is 50): finishing requires several
    // cursor-paged calls, not one synchronous sweep.
    insertMirrorRows(120);

    let serviced = false;
    let finished = false;
    const watcher = (async () => {
      while (!finished) {
        await new Promise((resolve) => setImmediate(resolve));
        serviced = true;
      }
    })();

    const report = await runNotesCompaction(db);
    finished = true;
    await watcher;

    expect(serviced).toBe(true);
    expect(report.purgedMirrorRows).toBe(120);
    expect(projectDocumentCount()).toBe(0);
    // The run stops at 'vacuum': the actual VACUUM is deferred to startup.
    expect(compactionStep()).toBe('vacuum');
    expect(report.vacuumed).toBe(false);
  });

  test('runPendingStartupVacuum completes the run exactly once', () => {
    db.run(
      `INSERT INTO notes_compaction_state (key, value) VALUES ('compaction', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ step: 'vacuum', cursor: '', v: 2 })],
    );

    expect(runPendingStartupVacuum(db)).toBe(true);
    expect(compactionStep()).toBe('done');
    // Once done, there is nothing left to vacuum.
    expect(runPendingStartupVacuum(db)).toBe(false);
  });

  test('runPendingStartupVacuum is a no-op without the 0059 schema or pending state', () => {
    const bare = new Database(':memory:');
    try {
      expect(notesCompactionApplies(bare)).toBe(false);
      expect(runPendingStartupVacuum(bare)).toBe(false);
    } finally {
      bare.close();
    }

    db.run('DELETE FROM notes_compaction_state');
    expect(runPendingStartupVacuum(db)).toBe(false);
  });
});
