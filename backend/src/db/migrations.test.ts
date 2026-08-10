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
    for (const migration of MIGRATIONS.filter(({ version }) => version !== '0026')) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, Date.now(), 'already-applied'],
      );
    }

    expect(await new MigrationRunner(database).migrate()).toBe(1);
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
    for (const migration of MIGRATIONS.filter(({ version }) => version !== '0026')) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, Date.now(), 'already-applied'],
      );
    }

    expect(await new MigrationRunner(database).migrate()).toBe(1);
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
    for (const migration of MIGRATIONS.filter(({ version }) => version !== '0027')) {
      database.run(
        'INSERT INTO _migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.description, Date.now(), 'already-applied'],
      );
    }

    expect(await new MigrationRunner(database).migrate()).toBe(1);
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
});
