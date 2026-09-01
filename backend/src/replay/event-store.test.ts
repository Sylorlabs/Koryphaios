import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentEvent } from './types';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const { getDb, initDb } = await import('../db');
const { EventStore } = await import('./event-store');

const suffix = crypto.randomUUID();
const appendSessionId = `replay-append-${suffix}`;
const sourceSessionId = `replay-source-${suffix}`;
const targetSessionId = `replay-target-${suffix}`;
const sessionIds = [appendSessionId, sourceSessionId, targetSessionId];
const store = new EventStore();

function event(id: string, sessionId: string, sequence: number): AgentEvent {
  return {
    id,
    sessionId,
    sequence,
    timestamp: Date.now() + sequence,
    type: 'state_change',
    payload: { sequence },
  };
}

beforeAll(async () => {
  await initDb();
  const insert = getDb().query(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  for (const sessionId of sessionIds) {
    insert.run(sessionId, 'Replay transaction test', Date.now(), Date.now());
  }
});

beforeEach(() => {
  const clear = getDb().query('DELETE FROM replay_events WHERE session_id = ?');
  for (const sessionId of sessionIds) clear.run(sessionId);
});

afterAll(() => {
  const sqlite = getDb();
  const clearEvents = sqlite.query('DELETE FROM replay_events WHERE session_id = ?');
  const clearSession = sqlite.query('DELETE FROM sessions WHERE id = ?');
  for (const sessionId of sessionIds) {
    clearEvents.run(sessionId);
    clearSession.run(sessionId);
  }
});

describe('EventStore SQLite transaction boundaries', () => {
  test('rolls back the whole append batch when a later event violates uniqueness', async () => {
    await expect(
      store.appendMany(appendSessionId, [
        event(`append-first-${suffix}`, appendSessionId, 1),
        event(`append-conflict-${suffix}`, appendSessionId, 1),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/i);

    expect(await store.getEvents(appendSessionId)).toEqual([]);
  });

  test('rolls back earlier copied events when the target conflicts later in the batch', async () => {
    await store.appendMany(sourceSessionId, [
      event(`source-first-${suffix}`, sourceSessionId, 1),
      event(`source-second-${suffix}`, sourceSessionId, 2),
    ]);
    await store.append(targetSessionId, event(`target-existing-${suffix}`, targetSessionId, 2));

    await expect(store.copyEvents(sourceSessionId, targetSessionId)).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );

    expect((await store.getEvents(targetSessionId)).map((entry) => entry.sequence)).toEqual([2]);
  });
});
