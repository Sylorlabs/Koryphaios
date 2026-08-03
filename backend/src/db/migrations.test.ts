import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS, MigrationRunner } from './migrations';
import { OrderedEventLog } from '../ws/ordered-event-log';

const openDatabases: Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('database migration repairs', () => {
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
});
