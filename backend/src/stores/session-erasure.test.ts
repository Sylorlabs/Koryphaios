import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eraseCreditUsageTransaction, eraseSessionDataTransaction } from './session-erasure';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; mainPath: string; creditPath: string; sqlite: Database } {
  const root = mkdtempSync(join(tmpdir(), 'kory-session-erasure-'));
  roots.push(root);
  const mainPath = join(root, 'main.db');
  const creditPath = join(root, 'credit.db');
  const sqlite = new Database(mainPath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE supervised_processes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE process_events (id INTEGER PRIMARY KEY, process_id TEXT NOT NULL);
    CREATE TABLE process_health_checks (process_id TEXT PRIMARY KEY);
    CREATE TABLE collaboration_sessions (id TEXT PRIMARY KEY, base_session_id TEXT NOT NULL);
    CREATE TABLE session_participants (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE persistent_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY, resource_type TEXT, resource_id TEXT
    );
    CREATE TABLE audit_log_archive (
      id INTEGER PRIMARY KEY, resource_type TEXT, resource_id TEXT
    );
    CREATE TABLE goals (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
      linked_session_ids TEXT NOT NULL, activity TEXT NOT NULL, execution TEXT,
      blocker TEXT, active_duration_ms INTEGER NOT NULL DEFAULT 0,
      active_started_at INTEGER, updated_at INTEGER NOT NULL
    );
  `);
  for (const table of [
    'abort_controllers',
    'active_workers',
    'messages',
    'ordered_session_events',
    'replay_events',
    'routing_audit_log',
    'session_changes',
    'session_compactions',
    'session_event_causes',
    'session_event_cursors',
    'session_tags',
    'session_usage',
    'spend_cap_pauses',
    'tasks',
    'user_inputs',
  ]) {
    sqlite.exec(`CREATE TABLE ${table} (id TEXT, session_id TEXT NOT NULL)`);
  }
  const credit = new Database(creditPath);
  credit.exec(`
    CREATE TABLE credit_usage (id INTEGER PRIMARY KEY, session_id TEXT, payload TEXT);
  `);
  credit.close();
  return { root, mainPath, creditPath, sqlite };
}

function seed(sqlite: Database, creditPath: string): void {
  sqlite.exec(`
    INSERT INTO sessions VALUES ('target', NULL), ('keep', NULL), ('child', 'target');
    INSERT INTO supervised_processes VALUES ('process-target', 'target'), ('process-keep', 'keep');
    INSERT INTO process_events VALUES (1, 'process-target'), (2, 'process-keep');
    INSERT INTO process_health_checks VALUES ('process-target'), ('process-keep');
    INSERT INTO collaboration_sessions VALUES ('collab-target', 'target'), ('collab-keep', 'keep');
    INSERT INTO session_participants VALUES ('participant-target', 'collab-target'), ('participant-keep', 'collab-keep');
    INSERT INTO persistent_sessions VALUES ('target'), ('keep');
    INSERT INTO audit_logs VALUES (1, 'session', 'target'), (2, 'credential', 'target'), (3, 'session', 'keep');
    INSERT INTO audit_log_archive VALUES (1, 'chat', 'target'), (2, 'credential', 'target'), (3, 'chat', 'keep');
    INSERT INTO goals VALUES (
      'goal-target', 'session', 'target', 'paused', '["target"]',
      '[{"id":"a","sessionId":"target"}]', NULL, NULL, 0, NULL, 1
    );
    INSERT INTO goals VALUES (
      'goal-shared', 'project', NULL, 'running', '["target","keep"]',
      '[{"id":"target-event","sessionId":"target"},{"id":"keep-event","sessionId":"keep"}]',
      '{"sessionId":"target","provider":"synthetic","model":"offline"}', NULL, 10, 1, 1
    );
  `);
  for (const table of [
    'abort_controllers',
    'active_workers',
    'messages',
    'ordered_session_events',
    'replay_events',
    'routing_audit_log',
    'session_changes',
    'session_compactions',
    'session_event_causes',
    'session_event_cursors',
    'session_tags',
    'session_usage',
    'spend_cap_pauses',
    'tasks',
    'user_inputs',
  ]) {
    sqlite.query(`INSERT INTO ${table} VALUES (?, ?), (?, ?)`).run(
      `${table}-target`,
      'target',
      `${table}-keep`,
      'keep',
    );
  }
  const credit = new Database(creditPath);
  credit
    .query('INSERT INTO credit_usage VALUES (1, ?, ?), (2, ?, ?), (3, NULL, ?)')
    .run('target', 'TARGET-CREDIT-SENTINEL', 'keep', 'KEEP-CREDIT-SENTINEL', 'GLOBAL-CREDIT');
  credit.close();
}

function count(sqlite: Database, table: string, where = '1 = 1', value?: string): number {
  const row = sqlite
    .query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(...(value === undefined ? [] : [value])) as { count: number };
  return Number(row.count);
}

describe('atomic session erasure', () => {
  test('single-session deletion removes every sentinel and preserves other sessions across restart', () => {
    const { mainPath, creditPath, sqlite } = fixture();
    seed(sqlite, creditPath);

    const report = eraseSessionDataTransaction(sqlite, {
      kind: 'selected',
      sessionIds: ['target'],
    });
    const creditWriter = new Database(creditPath);
    expect(
      eraseCreditUsageTransaction(creditWriter, {
        kind: 'selected',
        sessionIds: ['target'],
      }),
    ).toBe(1);
    creditWriter.close();
    expect(report.deletedSessions).toBe(1);
    expect(report.updatedGoals).toBe(1);
    sqlite.close();

    const restarted = new Database(mainPath);
    for (const table of [
      'abort_controllers',
      'active_workers',
      'messages',
      'ordered_session_events',
      'replay_events',
      'routing_audit_log',
      'session_changes',
      'session_compactions',
      'session_event_causes',
      'session_event_cursors',
      'session_tags',
      'session_usage',
      'spend_cap_pauses',
      'tasks',
      'user_inputs',
    ]) {
      expect(count(restarted, table, 'session_id = ?', 'target')).toBe(0);
      expect(count(restarted, table, 'session_id = ?', 'keep')).toBe(1);
    }
    expect(count(restarted, 'sessions', 'id = ?', 'target')).toBe(0);
    expect(count(restarted, 'sessions', 'id = ?', 'keep')).toBe(1);
    expect(
      restarted.query('SELECT parent_id FROM sessions WHERE id = ?').get('child'),
    ).toEqual({ parent_id: null });
    expect(count(restarted, 'process_events', 'process_id = ?', 'process-target')).toBe(0);
    expect(count(restarted, 'process_events', 'process_id = ?', 'process-keep')).toBe(1);
    expect(count(restarted, 'process_health_checks', 'process_id = ?', 'process-target')).toBe(0);
    expect(count(restarted, 'session_participants', 'session_id = ?', 'collab-target')).toBe(0);
    expect(count(restarted, 'session_participants', 'session_id = ?', 'collab-keep')).toBe(1);
    expect(count(restarted, 'goals', 'id = ?', 'goal-target')).toBe(0);
    expect(restarted.query('SELECT * FROM goals WHERE id = ?').get('goal-shared')).toMatchObject({
      linked_session_ids: '["keep"]',
      activity: '[{"id":"keep-event","sessionId":"keep"}]',
      execution: null,
      status: 'paused',
      active_started_at: null,
    });
    expect(count(restarted, 'audit_logs', 'id = ?', '1')).toBe(0);
    expect(count(restarted, 'audit_logs', 'id = ?', '2')).toBe(1);
    expect(count(restarted, 'audit_logs', 'id = ?', '3')).toBe(1);
    expect(count(restarted, 'persistent_sessions', 'id = ?', 'target')).toBe(0);
    expect(count(restarted, 'persistent_sessions', 'id = ?', 'keep')).toBe(1);
    restarted.close();

    const credit = new Database(creditPath);
    expect(count(credit, 'credit_usage', 'session_id = ?', 'target')).toBe(0);
    expect(count(credit, 'credit_usage', 'session_id = ?', 'keep')).toBe(1);
    expect(count(credit, 'credit_usage', 'session_id IS NULL')).toBe(1);
    credit.close();
  });

  test('delete-all removes orphan session state while retaining global records', () => {
    const { creditPath, sqlite } = fixture();
    seed(sqlite, creditPath);
    sqlite.exec(`
      INSERT INTO messages VALUES ('orphan-message', 'orphan-session');
      INSERT INTO supervised_processes VALUES ('orphan-process', 'orphan-session');
      INSERT INTO process_events VALUES (9, 'orphan-process');
    `);

    const report = eraseSessionDataTransaction(sqlite, { kind: 'all' });
    const creditWriter = new Database(creditPath);
    expect(eraseCreditUsageTransaction(creditWriter, { kind: 'all' })).toBe(2);
    creditWriter.close();
    expect(report.deletedSessions).toBe(3);
    expect(count(sqlite, 'messages')).toBe(0);
    expect(count(sqlite, 'supervised_processes')).toBe(0);
    expect(count(sqlite, 'process_events')).toBe(0);
    expect(count(sqlite, 'session_participants')).toBe(0);
    expect(count(sqlite, 'collaboration_sessions')).toBe(0);
    expect(count(sqlite, 'persistent_sessions')).toBe(0);
    expect(count(sqlite, 'sessions')).toBe(0);
    expect(count(sqlite, 'audit_logs', "resource_type = 'credential'")).toBe(1);
    expect(count(sqlite, 'goals')).toBe(1);
    expect(sqlite.query('SELECT * FROM goals').get()).toMatchObject({
      id: 'goal-shared',
      session_id: null,
      linked_session_ids: '[]',
      activity: '[]',
      execution: null,
      status: 'paused',
    });
    sqlite.close();

    const credit = new Database(creditPath);
    expect(count(credit, 'credit_usage', 'session_id IS NOT NULL')).toBe(0);
    expect(count(credit, 'credit_usage', 'session_id IS NULL')).toBe(1);
    credit.close();
  });

  test('a storage failure rolls back the main and attached credit databases', () => {
    const { creditPath, sqlite } = fixture();
    seed(sqlite, creditPath);
    sqlite.exec(`
      CREATE TRIGGER fail_target_message_delete BEFORE DELETE ON messages
      WHEN old.session_id = 'target'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic erasure failure');
      END;
    `);

    expect(() =>
      eraseSessionDataTransaction(sqlite, { kind: 'selected', sessionIds: ['target'] }),
    ).toThrow(/synthetic erasure failure/);
    expect(count(sqlite, 'sessions', 'id = ?', 'target')).toBe(1);
    expect(count(sqlite, 'supervised_processes', 'session_id = ?', 'target')).toBe(1);
    expect(count(sqlite, 'process_events', 'process_id = ?', 'process-target')).toBe(1);
    expect(count(sqlite, 'messages', 'session_id = ?', 'target')).toBe(1);
    expect(count(sqlite, 'goals', 'id = ?', 'goal-target')).toBe(1);
    sqlite.close();

    const credit = new Database(creditPath);
    expect(count(credit, 'credit_usage', 'session_id = ?', 'target')).toBe(1);
    credit.close();
  });

  test('unknown future session-keyed storage fails closed before mutation', () => {
    const { creditPath, sqlite } = fixture();
    seed(sqlite, creditPath);
    sqlite.exec('CREATE TABLE future_session_secrets (id TEXT, session_id TEXT NOT NULL)');
    sqlite.exec("INSERT INTO future_session_secrets VALUES ('sentinel', 'target')");

    expect(() =>
      eraseSessionDataTransaction(sqlite, { kind: 'selected', sessionIds: ['target'] }),
    ).toThrow(/unrecognized session-keyed tables: future_session_secrets/);
    expect(count(sqlite, 'sessions', 'id = ?', 'target')).toBe(1);
    expect(count(sqlite, 'future_session_secrets', 'session_id = ?', 'target')).toBe(1);
    sqlite.close();
  });

  test('unknown future indirect session links fail closed before mutation', () => {
    const { creditPath, sqlite } = fixture();
    seed(sqlite, creditPath);
    sqlite.exec('CREATE TABLE future_process_trace (id TEXT, process_id TEXT NOT NULL)');

    expect(() =>
      eraseSessionDataTransaction(sqlite, { kind: 'selected', sessionIds: ['target'] }),
    ).toThrow(/future_process_trace\.process_id/);
    expect(count(sqlite, 'sessions', 'id = ?', 'target')).toBe(1);
    expect(count(sqlite, 'messages', 'session_id = ?', 'target')).toBe(1);
    sqlite.close();
  });
});
