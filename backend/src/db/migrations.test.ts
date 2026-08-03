import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS, MigrationRunner } from './migrations';
import { OrderedEventLog } from '../ws/ordered-event-log';

const openDatabases: Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('database migration repairs', () => {
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
    for (const migration of MIGRATIONS.filter(
      ({ version }) => version !== '0022' && version !== '0023',
    )) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, Date.now(), 'already-applied'],
      );
    }

    expect(await new MigrationRunner(database).migrate()).toBe(2);
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
    for (const migration of MIGRATIONS.filter(({ version }) => version !== '0025')) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, Date.now(), 'already-applied'],
      );
    }

    expect(await new MigrationRunner(database).migrate()).toBe(1);
    expect(
      (database.query('PRAGMA table_info(ordered_session_events)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'parent_sequence',
      ),
    ).toBe(true);
    expect(database.query('SELECT event_id FROM ordered_session_events').get()).toEqual({ event_id: 'event-1' });
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
    for (const migration of MIGRATIONS.filter(({ version }) => version !== '0020')) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, now, 'already-applied'],
      );
    }

    expect(() => new OrderedEventLog(database)).toThrow('no such table: session_event_causes');

    expect(await new MigrationRunner(database).migrate()).toBe(1);
    const event = new OrderedEventLog(database).append({
      type: 'session.user_message',
      sessionId: 'session-1',
      timestamp: now,
      payload: { messageId: 'message-1', content: 'continue' },
    });

    expect(event.sequence).toBe(1);
    expect(
      database
        .query<
          { name: string },
          []
        >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_event_causes'")
        .get()?.name,
    ).toBe('session_event_causes');
  });
});
