import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const projectRoot = mkdtempSync(join(tmpdir(), 'kory-notes-transaction-'));
const { getDb, initDb } = await import('../../db');
const { createNote } = await import('../notes-service');

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
});

describe('Notes SQLite transaction boundaries', () => {
  test('rolls back note creation when the same transaction cannot persist its revision snapshot', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const triggerName = `test_note_revision_abort_${suffix}`;
    const title = `Atomic rollback ${suffix}`;
    const sqlite = getDb();
    sqlite.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON note_revisions
      WHEN NEW.title = '${title}'
      BEGIN
        SELECT RAISE(ABORT, 'forced revision snapshot failure');
      END;
    `);

    try {
      await expect(
        createNote({ title, content: 'This row must not survive.' }, projectRoot),
      ).rejects.toThrow();

      const persisted = sqlite
        .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM notes WHERE title = ?')
        .get(title);
      expect(persisted?.count).toBe(0);
    } finally {
      sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      sqlite.query<void, [string]>('DELETE FROM notes WHERE title = ?').run(title);
    }
  });
});
