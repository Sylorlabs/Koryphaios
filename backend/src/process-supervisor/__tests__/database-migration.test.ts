import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrateLegacyProcessColumns } from '../database';

let sqlite: Database | undefined;

afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
});

describe('process lifecycle legacy migration', () => {
  test('adds the public contract and keeps old ownership explicitly unknown', () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE supervised_processes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO supervised_processes (id, name) VALUES ('legacy-process', 'old watcher');
    `);

    migrateLegacyProcessColumns(sqlite);
    // Idempotence is part of startup safety: a second initialization must not
    // try to add the same columns again.
    migrateLegacyProcessColumns(sqlite);

    const columns = sqlite.query('PRAGMA table_info(supervised_processes)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'provenance',
        'supervision',
        'is_background',
        'terminal_reason',
        'terminal_error',
        'stdout_snapshot',
        'stderr_snapshot',
        'command_replayable',
      ]),
    );
    expect(
      sqlite
        .query(
          'SELECT provenance, supervision, is_background AS isBackground, command_replayable AS commandReplayable FROM supervised_processes WHERE id = ?',
        )
        .get('legacy-process'),
    ).toEqual({
      provenance: 'legacy-unknown',
      supervision: 'legacy-unknown',
      isBackground: 0,
      commandReplayable: 0,
    });
  });
});
