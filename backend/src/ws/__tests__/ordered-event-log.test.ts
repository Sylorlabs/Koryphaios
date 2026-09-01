import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WSMessage } from '@koryphaios/shared';
import { OrderedEventLog } from '../ordered-event-log';

function initializeSchema(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE session_event_cursors (
      session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1,
      next_sequence INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE ordered_session_events (
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
      agent_id TEXT, parent_sequence INTEGER, payload TEXT NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, UNIQUE(session_id, epoch, sequence),
      UNIQUE(session_id, event_id)
    );
    CREATE TABLE session_event_causes (
      session_id TEXT NOT NULL, epoch INTEGER NOT NULL, cause_key TEXT NOT NULL,
      sequence INTEGER NOT NULL, PRIMARY KEY(session_id, epoch, cause_key)
    );
  `);
}

function createLog(): { sqlite: Database; log: OrderedEventLog } {
  const sqlite = new Database(':memory:');
  initializeSchema(sqlite);
  return { sqlite, log: new OrderedEventLog(sqlite) };
}

function event(sessionId: string, text: string): WSMessage {
  return {
    type: 'stream.delta',
    sessionId,
    timestamp: Date.now(),
    payload: { agentId: 'kory-manager', content: text },
  };
}

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('OrderedEventLog', () => {
  test('allocates a gapless durable sequence independently per session', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);

    const first = log.append(event('s1', 'a'));
    const other = log.append(event('s2', 'x'));
    const second = log.append(event('s1', 'b'));

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(other.sequence).toBe(1);
    expect(first.eventId).not.toBe(second.eventId);
    expect(log.getCursor('s1')).toEqual({ epoch: 1, latestSequence: 2 });
  });

  test('reuses a caller-supplied event id without allocating a duplicate sequence', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    const message = { ...event('s1', 'once'), eventId: 'outbox-event-1' };

    const first = log.append(message);
    const retried = log.append(message);

    expect(retried).toEqual(first);
    expect(log.getCursor('s1')).toEqual({ epoch: 1, latestSequence: 1 });
    expect(sqlite.query('SELECT COUNT(*) AS count FROM ordered_session_events').get()).toEqual({
      count: 1,
    });
  });

  test('rejects reusing a caller-supplied event id for different content', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    log.append({ ...event('s1', 'first'), eventId: 'outbox-event-1' });

    expect(() => log.append({ ...event('s1', 'different'), eventId: 'outbox-event-1' })).toThrow(
      'different content',
    );
  });

  test('replays strictly after the acknowledged cursor and is idempotency-ready', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    log.append(event('s1', 'one'));
    const second = log.append(event('s1', 'two'));
    const third = log.append(event('s1', 'three'));

    const replay = log.getAfter('s1', 1, 1);
    expect(replay.map((item) => item.sequence)).toEqual([2, 3]);
    expect(replay.map((item) => (item.payload as { content: string }).content)).toEqual([
      'two',
      'three',
    ]);
    expect(replay[0].eventId).toBe(second.eventId);
    expect(replay[1].eventId).toBe(third.eventId);
  });

  test('recovers the full operational transcript when a frontend has no cursor', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    log.append({
      type: 'kory.thought',
      sessionId: 's1',
      timestamp: 100,
      payload: { thought: 'Inspecting the project', phase: 'analyzing' },
    });
    log.append(event('s1', 'Partial answer'));
    log.append({
      type: 'stream.thinking',
      sessionId: 's1',
      timestamp: 300,
      payload: { agentId: 'worker-1', thinking: 'Checking the failure path' },
    });

    expect(log.getAfter('s1', 1, 0).map((item) => item.type)).toEqual([
      'kory.thought',
      'stream.delta',
      'stream.thinking',
    ]);
  });

  test('reopens a durable system error after the backend database connection restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kory-ordered-events-'));
    const file = join(root, 'events.db');
    try {
      const firstDatabase = new Database(file);
      initializeSchema(firstDatabase);
      const firstLog = new OrderedEventLog(firstDatabase);
      firstLog.append({
        type: 'system.error',
        sessionId: 'restart-session',
        timestamp: 123,
        payload: { error: 'Provider failed before relaunch.' },
      });
      firstDatabase.close();

      const restartedDatabase = new Database(file);
      const restartedLog = new OrderedEventLog(restartedDatabase);
      const replay = restartedLog.getAfter('restart-session', 1, 0);
      restartedDatabase.close();

      expect(replay).toHaveLength(1);
      expect(replay[0]).toMatchObject({
        type: 'system.error',
        sessionId: 'restart-session',
        epoch: 1,
        sequence: 1,
        payload: { error: 'Provider failed before relaunch.' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records outbox dispatch only after publication', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    const appended = log.append(event('s1', 'one'));
    const before = sqlite.query('SELECT dispatched FROM ordered_session_events').get() as {
      dispatched: number;
    };
    expect(before.dispatched).toBe(0);

    log.markDispatched(appended.eventId);
    const after = sqlite.query('SELECT dispatched FROM ordered_session_events').get() as {
      dispatched: number;
    };
    expect(after.dispatched).toBe(1);
  });

  test('rejects a tool result without its call and binds valid results to the parent sequence', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    const result = (): WSMessage => ({
      type: 'stream.tool_result',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { agentId: 'kory-manager', toolResult: { callId: 'call-1', output: 'ok' } },
    });
    expect(() => log.append(result())).toThrow('without causal parent');

    const call = log.append({
      type: 'stream.tool_call',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { agentId: 'kory-manager', toolCall: { id: 'call-1', name: 'read' } },
    });
    const orderedResult = log.append(result());
    expect(orderedResult.parentSequence).toBe(call.sequence);
  });

  test('binds legacy result id payloads at the canonical boundary', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    const call = log.append({
      type: 'stream.tool_call',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { agentId: 'worker', toolCall: { id: 'legacy-1', name: 'bash' } },
    });
    const result = log.append({
      type: 'stream.tool_result',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { agentId: 'worker', toolResult: { id: 'legacy-1', output: 'ok' } },
    });
    expect(result.parentSequence).toBe(call.sequence);
  });

  test('fails closed for tool events without a causal identity and leaves no sequence gap', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    expect(() =>
      log.append({
        type: 'stream.tool_result',
        sessionId: 's1',
        timestamp: Date.now(),
        payload: { agentId: 'worker', toolResult: { output: 'orphan' } },
      }),
    ).toThrow('without a causal identity');
    expect(log.append(event('s1', 'next')).sequence).toBe(1);
  });

  test('rotates epochs after a timeline rewrite and rejects old causal state', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    log.append({
      type: 'stream.tool_call',
      sessionId: 's1',
      timestamp: Date.now(),
      payload: { toolCall: { id: 'old-call' } },
    });

    expect(log.resetEpoch('s1')).toEqual({ epoch: 2, latestSequence: 0 });
    const next = log.append(event('s1', 'new timeline'));
    expect({ epoch: next.epoch, sequence: next.sequence }).toEqual({ epoch: 2, sequence: 1 });
    expect(() =>
      log.append({
        type: 'stream.tool_result',
        sessionId: 's1',
        timestamp: Date.now(),
        payload: { toolResult: { callId: 'old-call' } },
      }),
    ).toThrow('without causal parent');
  });

  test('atomically opens a rewritten epoch with its durable sequence-one control row', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    log.append(event('s1', 'discarded branch'));

    const control = log.rewriteTimeline('s1', 456);

    expect(control).toMatchObject({
      type: 'session.timeline_rewritten',
      sessionId: 's1',
      epoch: 2,
      sequence: 1,
      timestamp: 456,
      payload: { eventEpoch: 2, reason: 'conversation_rewind' },
    });
    expect(log.getCursor('s1')).toEqual({ epoch: 2, latestSequence: 1 });
    expect(log.getAfter('s1', 2, 0)).toEqual([control]);
    expect(log.append(event('s1', 'replacement branch'))).toMatchObject({ epoch: 2, sequence: 2 });
  });
});
