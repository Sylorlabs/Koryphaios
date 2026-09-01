import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

const { db } = await import('../../db');
const { MIGRATIONS } = await import('../../db/migrations');
const { SessionRunStore } = await import('../../runs/session-run-store');
const processDatabase = await import('../database');

const originalClient = (db as unknown as { $client: Database }).$client;
const drizzleSession = (db as unknown as { session?: { client?: Database } }).session;
const originalSessionClient = drizzleSession?.client;
const sqlite = new Database(':memory:');

function pointProcessDatabaseAt(client: Database): void {
  (db as unknown as { $client: Database }).$client = client;
  if (drizzleSession) drizzleSession.client = client;
}

beforeAll(() => {
  sqlite.exec('PRAGMA foreign_keys = ON;');
  pointProcessDatabaseAt(sqlite);
  processDatabase.resetSchemaEnsured();
  processDatabase.initProcessSupervisorTables();
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      active_message_id TEXT,
      provider_conversation_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
  for (const version of ['0032', '0033', '0037', '0043']) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`${version} migration missing`);
    sqlite.exec(migration.up);
  }
});

afterAll(() => {
  pointProcessDatabaseAt(originalClient);
  if (drizzleSession && originalSessionClient) drizzleSession.client = originalSessionClient;
  processDatabase.resetSchemaEnsured();
  sqlite.close();
});

describe('process cleanup continuation ownership', () => {
  test('retains referenced terminal rows, permits resume, then releases them for cleanup', async () => {
    const now = Date.now();
    const oldSeconds = Math.floor((now - 10 * 24 * 60 * 60 * 1_000) / 1_000);
    sqlite.exec(`
      INSERT INTO sessions (id, title, created_at, updated_at)
      VALUES ('cleanup-session', 'Cleanup ownership', 1, 1);
      INSERT INTO supervised_processes (
        id, name, command, command_replayable, cwd, pid, session_id, status,
        restart_count, max_restarts, restart_policy, created_at, updated_at, ended_at,
        provenance, supervision, is_background
      ) VALUES
        (
          'referenced-terminal', 'referenced', 'true', 1, '/tmp', 0,
          'cleanup-session', 'exited', 0, 0, 'never', ${oldSeconds}, ${oldSeconds},
          ${oldSeconds}, 'agent-tool', 'owned-child', 1
        ),
        (
          'unreferenced-terminal', 'unreferenced', 'true', 1, '/tmp', 0,
          'cleanup-session', 'exited', 0, 0, 'never', ${oldSeconds}, ${oldSeconds},
          ${oldSeconds}, 'agent-tool', 'owned-child', 1
        );
    `);
    const store = new SessionRunStore(sqlite);
    store.transition('cleanup-session', { kind: 'start', runId: 'cleanup-run' }, now - 1_000);
    const waiting = store.parkForProcesses(
      'cleanup-session',
      'cleanup-run',
      1,
      ['referenced-terminal'],
      'wait for durable terminal evidence',
      now - 500,
    );

    expect(await processDatabase.cleanupOldProcesses(7)).toBe(1);
    expect(
      sqlite.query<{ id: string }, []>(`SELECT id FROM supervised_processes ORDER BY id`).all(),
    ).toEqual([{ id: 'referenced-terminal' }]);

    const resumed = store.resumeProcessWait(
      'cleanup-session',
      'cleanup-run',
      waiting.payload.snapshot.revision,
      now,
    );
    expect(resumed.processIds).toEqual(['referenced-terminal']);
    expect(resumed.payload.snapshot).toMatchObject({ phase: 'analyzing', status: 'active' });

    // Resuming claims the durable wake; it does not prove the provider has
    // consumed the process result. Keep the evidence until that run ends.
    expect(await processDatabase.cleanupOldProcesses(7)).toBe(0);
    store.transition(
      'cleanup-session',
      {
        kind: 'complete',
        expectedRunId: 'cleanup-run',
        expectedRevision: resumed.payload.snapshot.revision,
        reason: 'process_result_consumed',
      },
      now + 1,
    );
    expect(await processDatabase.cleanupOldProcesses(7)).toBe(1);
    expect(
      sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM supervised_processes')
        .get()?.count,
    ).toBe(0);
  });

  test('rejects unsafe retention windows before issuing cleanup SQL', async () => {
    await expect(processDatabase.cleanupOldProcesses(-1)).rejects.toThrow(
      'daysToKeep must be an integer between 0 and 3650',
    );
    await expect(processDatabase.cleanupOldProcesses(3_651)).rejects.toThrow(
      'daysToKeep must be an integer between 0 and 3650',
    );
    await expect(processDatabase.cleanupOldProcesses(0.5)).rejects.toThrow(
      'daysToKeep must be an integer between 0 and 3650',
    );
  });
});
