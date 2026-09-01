import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, MigrationRunner } from './migrations';
import { OrderedEventLog } from '../ws/ordered-event-log';

const openDatabases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function migration(version: string) {
  const found = MIGRATIONS.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`Migration ${version} is missing`);
  return found;
}

function createRunMigrationBase(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

describe('database migration repairs', () => {
  test('refuses to ledger 0032 over a malformed pre-existing run table', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    database.exec(`CREATE TABLE session_runs (session_id TEXT PRIMARY KEY);`);

    const runner = new MigrationRunner(database);
    await expect(runner.applyMigration(migration('0032'))).rejects.toThrow(
      'session_runs.run_id is missing',
    );

    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0032'").get(),
    ).toBeNull();
    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_events'",
        )
        .get(),
    ).toBeNull();
  });

  test('finishes a partially applied 0033, backfills sessions, and seeds future sessions', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    database.exec(`INSERT INTO sessions (id) VALUES ('existing');`);

    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0032'))).toBe(true);
    database.exec(`
      ALTER TABLE session_runs ADD COLUMN continuation_id TEXT;
      ALTER TABLE user_inputs ADD COLUMN run_id TEXT;
    `);

    expect(await runner.applyMigration(migration('0033'))).toBe(true);
    expect(
      database
        .query(
          `SELECT session_id, run_id, revision, phase, status, continuation_id
           FROM session_runs WHERE session_id = 'existing'`,
        )
        .get(),
    ).toEqual({
      session_id: 'existing',
      run_id: null,
      revision: 0,
      phase: 'idle',
      status: 'idle',
      continuation_id: null,
    });

    database.exec(`INSERT INTO sessions (id) VALUES ('future');`);
    expect(
      database
        .query(
          `SELECT session_id, revision, phase, status
           FROM session_runs WHERE session_id = 'future'`,
        )
        .get(),
    ).toEqual({ session_id: 'future', revision: 0, phase: 'idle', status: 'idle' });
    expect(
      (database.query('PRAGMA table_info(user_inputs)').all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toEqual(expect.arrayContaining(['run_id', 'run_revision', 'status']));
    expect(await runner.applyMigration(migration('0033'))).toBe(false);
  });

  test('rolls back additive 0033 work when a continuation table is incompatible', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    const runner = new MigrationRunner(database);
    await runner.applyMigration(migration('0032'));
    database.exec(`CREATE TABLE session_run_continuations (id TEXT PRIMARY KEY);`);

    await expect(runner.applyMigration(migration('0033'))).rejects.toThrow();
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0033'").get(),
    ).toBeNull();
    expect(
      (database.query('PRAGMA table_info(session_runs)').all() as Array<{ name: string }>).some(
        ({ name }) => name === 'continuation_id',
      ),
    ).toBe(false);
  });

  test('finishes a partially applied 0037 and backfills exact live process ownership', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    const runner = new MigrationRunner(database);
    await runner.applyMigration(migration('0032'));
    await runner.applyMigration(migration('0033'));
    database.exec(`
      CREATE TABLE supervised_processes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
      INSERT INTO sessions (id) VALUES ('process-session');
      INSERT INTO supervised_processes (id, session_id) VALUES
        ('process-a', 'process-session'),
        ('process-b', 'process-session');
      INSERT INTO session_run_continuations (
        id, session_id, run_id, wait_revision, kind, state, payload, created_at, updated_at
      ) VALUES (
        'continuation-a', 'process-session', 'run-a', 2, 'process_set', 'pending',
        '{"processIds":["process-b","process-a","process-a"]}', 10, 10
      );

      CREATE TABLE session_run_continuation_processes (
        continuation_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        PRIMARY KEY (continuation_id, process_id),
        FOREIGN KEY(continuation_id)
          REFERENCES session_run_continuations(id) ON DELETE CASCADE,
        FOREIGN KEY(process_id)
          REFERENCES supervised_processes(id) ON DELETE RESTRICT
      );
      INSERT INTO session_run_continuation_processes (continuation_id, process_id)
      VALUES ('continuation-a', 'process-a');
    `);

    expect(await runner.applyMigration(migration('0037'))).toBe(true);
    expect(
      database
        .query(
          `SELECT continuation_id, process_id
           FROM session_run_continuation_processes ORDER BY process_id`,
        )
        .all(),
    ).toEqual([
      { continuation_id: 'continuation-a', process_id: 'process-a' },
      { continuation_id: 'continuation-a', process_id: 'process-b' },
    ]);
    const foreignKeys = database
      .query('PRAGMA foreign_key_list(session_run_continuation_processes)')
      .all() as Array<{ table: string; from: string; on_delete: string }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'session_run_continuations',
          from: 'continuation_id',
          on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'supervised_processes',
          from: 'process_id',
          on_delete: 'RESTRICT',
        }),
      ]),
    );
    expect(() =>
      database.query(`DELETE FROM supervised_processes WHERE id = 'process-a'`).run(),
    ).toThrow('FOREIGN KEY constraint failed');
    expect(
      database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_session_run_continuation_processes_process'`,
        )
        .get(),
    ).toBeTruthy();
    expect(await runner.applyMigration(migration('0037'))).toBe(false);

    database.query(`DELETE FROM session_run_continuations WHERE id = 'continuation-a'`).run();
    expect(
      database
        .query<{ count: number }, []>(
          'SELECT COUNT(*) AS count FROM session_run_continuation_processes',
        )
        .get()?.count,
    ).toBe(0);
  });

  test('refuses to ledger 0037 over malformed ownership foreign keys', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    const runner = new MigrationRunner(database);
    await runner.applyMigration(migration('0032'));
    await runner.applyMigration(migration('0033'));
    database.exec(`
      CREATE TABLE supervised_processes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE session_run_continuation_processes (
        continuation_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        PRIMARY KEY (continuation_id, process_id)
      );
    `);

    await expect(runner.applyMigration(migration('0037'))).rejects.toThrow(
      'must reference session_run_continuations.id ON DELETE CASCADE',
    );
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0037'").get(),
    ).toBeNull();
  });

  test('refuses to ledger 0037 when a live payload cannot be fully backfilled', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    const runner = new MigrationRunner(database);
    await runner.applyMigration(migration('0032'));
    await runner.applyMigration(migration('0033'));
    database.exec(`
      CREATE TABLE supervised_processes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      INSERT INTO sessions (id) VALUES ('process-session');
      INSERT INTO session_run_continuations (
        id, session_id, run_id, wait_revision, kind, state, payload, created_at, updated_at
      ) VALUES (
        'stranded-continuation', 'process-session', 'run-a', 2, 'process_set', 'pending',
        '{"processIds":["missing-process"]}', 10, 10
      );
    `);

    await expect(runner.applyMigration(migration('0037'))).rejects.toThrow(
      'ownership does not match live waits',
    );
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0037'").get(),
    ).toBeNull();
    expect(
      database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'session_run_continuation_processes'`,
        )
        .get(),
    ).toBeNull();
  });

  test('finishes an unledgered 0038 without replacing a pending restart handoff', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    database.exec(`
      INSERT INTO sessions (id) VALUES ('handoff-session');
      ${migration('0038').up}
      INSERT INTO session_run_handoffs (
        id, session_id, kind, source_run_id, source_run_revision,
        question_id, question_payload, answer, state, attempt_count,
        created_at, updated_at
      ) VALUES (
        'handoff-a', 'handoff-session', 'resume_answered_question', 'run-a', 2,
        'question-a',
        '{"questionId":"question-a","question":"Which runtime?","options":["Desktop"],"allowOther":true}',
        'Desktop', 'pending', 0, 100, 100
      );
      DROP INDEX idx_session_run_handoffs_claimable;
      DROP INDEX idx_session_run_handoffs_session;
    `);

    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0038'))).toBe(true);
    expect(
      database
        .query(
          `SELECT id, session_id, question_id, answer, state, attempt_count
           FROM session_run_handoffs WHERE id = 'handoff-a'`,
        )
        .get(),
    ).toEqual({
      id: 'handoff-a',
      session_id: 'handoff-session',
      question_id: 'question-a',
      answer: 'Desktop',
      state: 'pending',
      attempt_count: 0,
    });
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'index' AND name IN (
             'idx_session_run_handoffs_claimable', 'idx_session_run_handoffs_session'
           )`,
        )
        .get()?.count,
    ).toBe(2);
    expect(await runner.applyMigration(migration('0038'))).toBe(false);
  });

  test('refuses to ledger 0038 over a malformed pre-existing handoff table', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    createRunMigrationBase(database);
    database.exec(`
      CREATE TABLE session_run_handoffs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER
      );
    `);

    const runner = new MigrationRunner(database);
    await expect(runner.applyMigration(migration('0038'))).rejects.toThrow(
      'session_run_handoffs.kind is missing',
    );
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0038'").get(),
    ).toBeNull();
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'idx_session_run_handoffs_%'`,
        )
        .get()?.count,
    ).toBe(0);
  });

  test('refuses startup when a ledgered restart-handoff index was removed', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    const initialRunner = new MigrationRunner(database);
    const restartHandoffMigrationIndex = MIGRATIONS.findIndex(({ version }) => version === '0038');
    expect(restartHandoffMigrationIndex).toBeGreaterThanOrEqual(0);
    for (const item of MIGRATIONS.slice(0, restartHandoffMigrationIndex + 1)) {
      expect(await initialRunner.applyMigration(item)).toBe(true);
    }

    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0038'").get(),
    ).toBeTruthy();
    database.exec('DROP INDEX idx_session_run_handoffs_claimable;');

    const freshRunner = new MigrationRunner(database);
    await expect(freshRunner.migrate()).rejects.toThrow(
      'session_run_handoffs needs index (state, lease_expires_at, created_at)',
    );
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0039'").get(),
    ).toBeNull();

    database.exec(`
      CREATE INDEX idx_session_run_handoffs_claimable
        ON session_run_handoffs(state, lease_expires_at, created_at);
    `);
    expect(await new MigrationRunner(database).migrate()).toBe(
      MIGRATIONS.length - restartHandoffMigrationIndex - 1,
    );

    database.exec('DROP INDEX idx_session_run_handoffs_claimable;');
    await expect(new MigrationRunner(database).migrate()).rejects.toThrow(
      'session_run_handoffs needs index (state, lease_expires_at, created_at)',
    );
  });

  test('creates and re-attests the authoritative session-turn command ledger', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    const runner = new MigrationRunner(database);
    expect(await runner.migrate()).toBe(MIGRATIONS.length);

    const columns = database
      .query<{ name: string }, []>('PRAGMA table_info(session_turn_commands)')
      .all()
      .map(({ name }) => name);
    expect(columns).toEqual([
      'command_key',
      'session_id',
      'source',
      'source_command_id',
      'input_hash',
      'user_message_id',
      'response_message_id',
      'run_id',
      'status',
      'terminal_reason',
      'created_at',
      'updated_at',
      'finished_at',
    ]);

    database.exec('DROP INDEX idx_session_turn_commands_session_status;');
    await expect(new MigrationRunner(database).migrate()).rejects.toThrow(
      'session_turn_commands needs index (session_id, status, updated_at)',
    );
  });

  test('creates the durable Notes workspace schema and preserves its stable local owner', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE notes (id TEXT PRIMARY KEY);
    `);
    const runner = new MigrationRunner(database);

    expect(await runner.applyMigration(migration('0039'))).toBe(true);
    const principal = database
      .query<{ id: string; kind: string }, []>(
        `SELECT id, kind FROM note_draft_principals WHERE kind = 'local'`,
      )
      .get();
    expect(principal?.id).toMatch(/^local-[a-f0-9]{32}$/);
    expect(principal?.kind).toBe('local');
    expect(await runner.applyMigration(migration('0039'))).toBe(false);
    expect(
      database
        .query<{ id: string }, []>(`SELECT id FROM note_draft_principals WHERE kind = 'local'`)
        .get()?.id,
    ).toBe(principal?.id);

    expect(
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'note_drafts', 'note_property_documents', 'note_properties',
             'note_property_items', 'note_property_schemas', 'note_bases',
             'note_base_revisions'
           )`,
        )
        .get()?.count,
    ).toBe(7);
  });

  test('creates and re-attests the whole-vault restore commit witness', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    const runner = new MigrationRunner(database);

    expect(await runner.applyMigration(migration('0041'))).toBe(true);
    expect(await runner.applyMigration(migration('0041'))).toBe(false);
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info(note_vault_restore_commits)`)
      .all()
      .map((column) => column.name);
    expect(columns).toEqual([
      'archive_sha256',
      'project_root',
      'manifest_sha256',
      'plan_token',
      'committed_at',
    ]);
    expect(
      database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_note_vault_restore_commits_project'`,
        )
        .get()?.name,
    ).toBe('idx_note_vault_restore_commits_project');
  });

  test('creates re-attested feed persistence tables with session-cascade cleanup', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      INSERT INTO sessions (id) VALUES ('feed-session');
    `);
    const runner = new MigrationRunner(database);

    expect(await runner.applyMigration(migration('0042'))).toBe(true);
    expect(await runner.applyMigration(migration('0042'))).toBe(false);
    expect(
      database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_session_feed_tombstones_session'`,
        )
        .get()?.name,
    ).toBe('idx_session_feed_tombstones_session');

    database.exec(`
      INSERT INTO session_feed_entries
        (id, session_id, kind, text, timestamp, created_at, updated_at)
      VALUES ('client-error-1', 'feed-session', 'client_error', 'Useful client failure', 1, 1, 1);
      INSERT INTO session_feed_tombstones
        (session_id, target_key, visibility, created_at, updated_at)
      VALUES ('feed-session', 'event:1:4:4', 'deleted', 1, 1);
      DELETE FROM sessions WHERE id = 'feed-session';
    `);
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM session_feed_entries`)
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM session_feed_tombstones`)
        .get()?.count,
    ).toBe(0);
  });

  test('refuses to ledger 0039 over a malformed pre-existing recovery table', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE notes (id TEXT PRIMARY KEY);
      CREATE TABLE note_drafts (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        note_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const runner = new MigrationRunner(database);

    await expect(runner.applyMigration(migration('0039'))).rejects.toThrow(
      'note_drafts.base_revision is missing',
    );
    expect(
      database.query("SELECT version FROM _migrations WHERE version = '0039'").get(),
    ).toBeNull();
    expect(
      database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'note_property_documents'`,
        )
        .get(),
    ).toBeNull();
  });

  test('rechecks stale runners and enforces strong checksums without rejecting legacy rows', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kory-migration-runner-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'runner.sqlite');
    const firstDatabase = new Database(databasePath);
    const staleDatabase = new Database(databasePath);
    openDatabases.push(firstDatabase, staleDatabase);
    createRunMigrationBase(firstDatabase);

    const first = new MigrationRunner(firstDatabase);
    const stale = new MigrationRunner(staleDatabase);
    const firstPending = first.getPendingMigrations().find(({ version }) => version === '0032');
    const stalePending = stale.getPendingMigrations().find(({ version }) => version === '0032');
    expect(firstPending).toBeDefined();
    expect(stalePending).toBeDefined();

    expect(await first.applyMigration(firstPending!)).toBe(true);
    expect(await stale.applyMigration(stalePending!)).toBe(false);
    expect(
      firstDatabase.query("SELECT COUNT(*) AS count FROM _migrations WHERE version = '0032'").get(),
    ).toEqual({ count: 1 });

    firstDatabase.exec(
      "UPDATE _migrations SET checksum = 'sha256:tampered' WHERE version = '0032'",
    );
    expect(() => stale.getAppliedMigrations()).toThrow('checksum mismatch');

    // Historical unprefixed checksums are deliberately treated as legacy.
    firstDatabase.exec(
      "UPDATE _migrations SET checksum = 'legacy-checksum' WHERE version = '0032'",
    );
    expect(stale.getAppliedMigrations().some(({ version }) => version === '0032')).toBe(true);
  });

  test('upgrades existing message timestamps from seconds to milliseconds without double-scaling', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO messages (id, session_id, created_at) VALUES
        ('seconds', 'session', 1788121819),
        ('milliseconds', 'session', 1788121819669);
    `);
    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0031'))).toBe(true);
    expect(database.query('SELECT id, created_at FROM messages ORDER BY id').all()).toEqual([
      { id: 'milliseconds', created_at: 1788121819669 },
      { id: 'seconds', created_at: 1788121819000 },
    ]);

    // Running again does not make the converted value 1,000 times larger.
    expect(await runner.applyMigration(migration('0031'))).toBe(false);
    expect(database.query("SELECT created_at FROM messages WHERE id = 'seconds'").get()).toEqual({
      created_at: 1788121819000,
    });
  });

  test('applies the API usage and image history migration on a bare database', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    const runner = new MigrationRunner(database);
    await runner.migrate();

    const tables = database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_usage', 'image_history')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name).sort()).toEqual(['api_usage', 'image_history']);

    const indexes = database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_api_usage_ts', 'idx_api_usage_kind_ts', 'idx_image_history_ts')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name).sort()).toEqual([
      'idx_api_usage_kind_ts',
      'idx_api_usage_ts',
      'idx_image_history_ts',
    ]);

    // The kind CHECK constraint rejects unknown kinds.
    expect(() =>
      database
        .prepare(
          "INSERT INTO api_usage (id, ts, kind, provider, model) VALUES ('x', 1, 'bogus', 'p', 'm')",
        )
        .run(),
    ).toThrow();

    // Down-migration removes everything cleanly.
    const migration = MIGRATIONS.find(({ version }) => version === '0030');
    expect(migration).toBeDefined();
    expect(migration?.down).toBeDefined();
    database.exec(migration!.down!);
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_usage'")
        .all(),
    ).toHaveLength(0);
  });

  test('records durability migrations when their columns already exist', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE sessions (id TEXT PRIMARY KEY, conversation_revision INTEGER DEFAULT 0);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        context_revision INTEGER NOT NULL DEFAULT 0
      );
    `);
    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0022'))).toBe(true);
    expect(await runner.applyMigration(migration('0023'))).toBe(true);
    expect(
      database.query("SELECT version FROM _migrations WHERE version IN ('0022', '0023')").all(),
    ).toHaveLength(2);
    expect(
      database
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_compactions'",
        )
        .get(),
    ).toBeTruthy();
  });

  test('repairs the missing causal parent column without rebuilding event history', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE ordered_session_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        payload TEXT NOT NULL,
        dispatched INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    database.run(
      `INSERT INTO ordered_session_events(event_id, session_id, epoch, sequence, timestamp, type, payload, created_at)
       VALUES ('event-1', 'session-1', 1, 1, 1, 'stream.content', '{}', 1)`,
    );
    expect(await new MigrationRunner(database).applyMigration(migration('0025'))).toBe(true);
    expect(
      (
        database.query('PRAGMA table_info(ordered_session_events)').all() as Array<{ name: string }>
      ).some((column) => column.name === 'parent_sequence'),
    ).toBe(true);
    expect(database.query('SELECT event_id FROM ordered_session_events').get()).toEqual({
      event_id: 'event-1',
    });
  });

  test('repairs an early 0018 database before ordered events are initialized', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE session_event_cursors (
        session_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 1,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ordered_session_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        parent_sequence INTEGER,
        payload TEXT NOT NULL,
        dispatched INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, epoch, sequence),
        UNIQUE(session_id, event_id)
      );
    `);
    const now = Date.now();
    expect(() => new OrderedEventLog(database)).toThrow('no such table: session_event_causes');

    expect(await new MigrationRunner(database).applyMigration(migration('0020'))).toBe(true);
    const event = new OrderedEventLog(database).append({
      type: 'session.user_message',
      sessionId: 'session-1',
      timestamp: now,
      payload: { messageId: 'message-1', content: 'continue' },
    });

    expect(event.sequence).toBe(1);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_event_causes'",
        )
        .get()?.name,
    ).toBe('session_event_causes');
  });

  test('upgrades linear conversations into retained lineage without changing their active history', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        conversation_revision INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions(id, conversation_revision) VALUES
        ('session-a', 3),
        ('session-empty', 0);
      INSERT INTO messages(id, session_id, created_at) VALUES
        ('message-a', 'session-a', 100),
        ('message-b', 'session-a', 100),
        ('message-c', 'session-a', 200);
    `);
    expect(await new MigrationRunner(database).applyMigration(migration('0026'))).toBe(true);
    expect(
      database
        .query(
          `SELECT id, active_message_id, provider_conversation_revision
           FROM sessions ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'session-a',
        active_message_id: 'message-c',
        provider_conversation_revision: 3,
      },
      {
        id: 'session-empty',
        active_message_id: null,
        provider_conversation_revision: 0,
      },
    ]);
    expect(
      database
        .query(
          `SELECT id, parent_message_id FROM messages
           WHERE session_id = 'session-a' ORDER BY created_at, rowid`,
        )
        .all(),
    ).toEqual([
      { id: 'message-a', parent_message_id: null },
      { id: 'message-b', parent_message_id: 'message-a' },
      { id: 'message-c', parent_message_id: 'message-b' },
    ]);
  });

  test('finishes an interrupted lineage migration without overwriting durable heads or provider generations', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        conversation_revision INTEGER DEFAULT 0,
        active_message_id TEXT,
        provider_conversation_revision INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        parent_message_id TEXT
      );
      INSERT INTO sessions(
        id, conversation_revision, active_message_id, provider_conversation_revision
      ) VALUES ('session-a', 3, 'message-b', 9);
      INSERT INTO messages(id, session_id, created_at, parent_message_id) VALUES
        ('message-a', 'session-a', 100, NULL),
        ('message-b', 'session-a', 200, 'message-a'),
        ('retained-future', 'session-a', 300, 'message-b');
    `);
    expect(await new MigrationRunner(database).applyMigration(migration('0026'))).toBe(true);
    expect(
      database
        .query(
          `SELECT active_message_id, provider_conversation_revision FROM sessions
           WHERE id = 'session-a'`,
        )
        .get(),
    ).toEqual({ active_message_id: 'message-b', provider_conversation_revision: 9 });
    expect(
      database.query(`SELECT parent_message_id FROM messages WHERE id = 'retained-future'`).get(),
    ).toEqual({ parent_message_id: 'message-b' });
  });

  test('finishes an interrupted Notes scoping migration without rewriting existing notes', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        project_root TEXT
      );
      INSERT INTO notes(id, title, content, project_root)
      VALUES ('note-a', 'Existing note', 'preserve me', '/workspace/a');
    `);
    expect(await new MigrationRunner(database).applyMigration(migration('0027'))).toBe(true);
    const columns = database.query('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
    expect(columns.some(({ name }) => name === 'project_root')).toBe(true);
    expect(columns.some(({ name }) => name === 'revision')).toBe(true);
    expect(
      database.query(`SELECT id, content, revision FROM notes WHERE id = 'note-a'`).get(),
    ).toEqual({
      id: 'note-a',
      content: 'preserve me',
      revision: 1,
    });
    expect(
      database
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_project_root'`,
        )
        .get(),
    ).toBeTruthy();
  });

  test('adds recoverable Notes trash and backfills one immutable baseline per note', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        folder_path TEXT NOT NULL DEFAULT '/',
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        include_in_context INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL DEFAULT 'markdown',
        project_root TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        user_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO notes (
        id, title, content, folder_path, tags, pinned, include_in_context,
        format, project_root, revision, created_at, updated_at
      ) VALUES (
        'note-a', 'Existing note', 'preserve me', '/Decisions', '["durable"]',
        1, 1, 'markdown', '/workspace/a', 7, 100, 200
      );
    `);
    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0034'))).toBe(true);
    const columns = database.query('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain('trashed_at');
    expect(columns.map(({ name }) => name)).toContain('trash_reason');
    expect(
      database
        .query(
          `SELECT note_id, revision, project_root, content, content_bytes,
                  folder_path, pinned, include_in_context
           FROM note_revisions WHERE note_id = 'note-a'`,
        )
        .get(),
    ).toEqual({
      note_id: 'note-a',
      revision: 7,
      project_root: '/workspace/a',
      content: 'preserve me',
      content_bytes: 11,
      folder_path: '/Decisions',
      pinned: 1,
      include_in_context: 1,
    });
    expect(await runner.applyMigration(migration('0034'))).toBe(false);
  });

  test('adds the nullable archive marker without rewriting legacy chat data', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions(id, title, updated_at)
      VALUES ('legacy-chat', 'Preserve every message reference', 123456);
    `);
    const runner = new MigrationRunner(database);
    expect(await runner.applyMigration(migration('0036'))).toBe(true);
    expect(
      database
        .query('SELECT id, title, updated_at, archived_at FROM sessions WHERE id = ?')
        .get('legacy-chat'),
    ).toEqual({
      id: 'legacy-chat',
      title: 'Preserve every message reference',
      updated_at: 123456,
      archived_at: null,
    });
    const indexSql = database
      .query<{ name: string; sql: string }, []>(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_sessions_%' ORDER BY name`,
      )
      .all();
    expect(indexSql.map(({ name }) => name)).toEqual([
      'idx_sessions_active_updated',
      'idx_sessions_archived_at',
    ]);
    expect(indexSql[0]?.sql).toContain('WHERE archived_at IS NULL');
    expect(indexSql[1]?.sql).toContain('WHERE archived_at IS NOT NULL');
    expect(await runner.applyMigration(migration('0036'))).toBe(false);
  });

  test('repairs an interrupted archive migration without replacing an archive timestamp', async () => {
    const database = new Database(':memory:');
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE _migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        archived_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions(id, title, archived_at, updated_at)
      VALUES ('already-archived', 'Keep this marker', 987654321, 222);
    `);
    expect(await new MigrationRunner(database).applyMigration(migration('0036'))).toBe(true);
    expect(
      database
        .query('SELECT title, archived_at, updated_at FROM sessions WHERE id = ?')
        .get('already-archived'),
    ).toEqual({ title: 'Keep this marker', archived_at: 987654321, updated_at: 222 });
    expect(
      database
        .query(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'index' AND name IN (
             'idx_sessions_active_updated', 'idx_sessions_archived_at'
           )`,
        )
        .get(),
    ).toEqual({ count: 2 });
  });
});
