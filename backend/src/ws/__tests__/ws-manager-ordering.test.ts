import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ServerWebSocket } from 'bun';
import { OrderedEventLog, setOrderedEventLogForTests } from '../ordered-event-log';
import { WSManager, type WSClientData } from '../ws-manager';

function createLog(): { sqlite: Database; log: OrderedEventLog } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE session_event_cursors (
      session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1,
      next_sequence INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    CREATE TABLE ordered_session_events (
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      sequence INTEGER NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL,
      agent_id TEXT, parent_sequence INTEGER, payload TEXT NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(session_id, epoch, sequence), UNIQUE(session_id, event_id)
    );
    CREATE TABLE session_event_causes (
      session_id TEXT NOT NULL, epoch INTEGER NOT NULL, cause_key TEXT NOT NULL,
      sequence INTEGER NOT NULL, PRIMARY KEY(session_id, epoch, cause_key)
    );
  `);
  return { sqlite, log: new OrderedEventLog(sqlite) };
}

const managers: WSManager[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  setOrderedEventLogForTests(null);
  for (const database of databases.splice(0)) database.close();
});

describe('WSManager canonical ordering', () => {
  test('persists sequence before serializing and publishing to a subscribed client', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);
    const sent: string[] = [];
    const socket = {
      data: { id: 'client-1' },
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => {},
    } as unknown as ServerWebSocket<WSClientData>;
    manager.add(socket);
    manager.subscribeClientToSession('client-1', 'session-1');

    manager.broadcastToSession('session-1', {
      type: 'stream.thinking',
      timestamp: 20,
      payload: { agentId: 'kory-manager', thinking: 'reason' },
    });
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 10,
      payload: { agentId: 'kory-manager', content: 'answer' },
    });

    const delivered = sent.map((value) => JSON.parse(value));
    expect(delivered.map((message) => message.sequence)).toEqual([1, 2]);
    expect(delivered.map((message) => message.timestamp)).toEqual([20, 10]);
    expect(
      sqlite
        .query('SELECT sequence, dispatched FROM ordered_session_events ORDER BY sequence')
        .all(),
    ).toEqual([
      { sequence: 1, dispatched: 1 },
      { sequence: 2, dispatched: 1 },
    ]);
  });

  test('replays missed events after refresh and resumes from an acknowledged cursor', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 10,
      payload: { agentId: 'kory-manager', content: 'before refresh' },
    });
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 20,
      payload: { agentId: 'kory-manager', content: 'while disconnected' },
    });

    const sent: string[] = [];
    const socket = {
      data: { id: 'client-reloaded' },
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => {},
    } as unknown as ServerWebSocket<WSClientData>;
    manager.add(socket);
    manager.subscribeClientToSession('client-reloaded', 'session-1', {
      epoch: 1,
      sequence: 1,
    });

    const replay = sent.map((value) => JSON.parse(value));
    expect(replay.map((message) => message.sequence)).toEqual([2]);
    expect(replay[0].replayed).toBe(true);
    expect(replay[0].payload.content).toBe('while disconnected');
  });

  test('replays tool calls, results, and file edits to a freshly reloaded client', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    manager.broadcastToSession('session-1', {
      type: 'stream.tool_call',
      timestamp: 10,
      payload: { agentId: 'kory-manager', toolCall: { id: 'call-1', name: 'write_file' } },
    });
    manager.broadcastToSession('session-1', {
      type: 'stream.file_delta',
      timestamp: 20,
      payload: {
        agentId: 'kory-manager',
        path: 'src/app.ts',
        delta: 'saved content',
        totalLength: 13,
        operation: 'edit',
      },
    });
    manager.broadcastToSession('session-1', {
      type: 'stream.tool_result',
      timestamp: 30,
      payload: {
        agentId: 'kory-manager',
        toolResult: { callId: 'call-1', name: 'write_file', output: 'ok', isError: false },
      },
    });

    const sent: string[] = [];
    const socket = {
      data: { id: 'client-fresh' },
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => {},
    } as unknown as ServerWebSocket<WSClientData>;
    manager.add(socket);
    manager.subscribeClientToSession('client-fresh', 'session-1');

    const replay = sent.map((value) => JSON.parse(value));
    expect(replay.map((message) => message.type)).toEqual([
      'stream.tool_call',
      'stream.file_delta',
      'stream.tool_result',
    ]);
    expect(replay[2].parentSequence).toBe(replay[0].sequence);
    expect(replay.every((message) => message.replayed === true)).toBe(true);
  });

  test('does not replay events for an erased session on reconnect', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    // Persist events for session-1 (including a session.updated that would
    // resurrect the chat in the sidebar if replayed after deletion).
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 10,
      payload: { agentId: 'kory-manager', content: 'hello' },
    });
    manager.broadcastToSession('session-1', {
      type: 'session.updated',
      timestamp: 20,
      payload: { session: { id: 'session-1', title: 'Test' } },
    });

    // Erase the session — forgetSession adds it to erasedSessions and
    // drops all existing subscriptions.
    manager.forgetSession('session-1');

    // A client reconnects and tries to subscribe to the deleted session.
    const sent: string[] = [];
    const socket = {
      data: { id: 'client-reconnect' },
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => {},
    } as unknown as ServerWebSocket<WSClientData>;
    manager.add(socket);
    manager.subscribeClientToSession('client-reconnect', 'session-1');

    // No events should be replayed — the session was erased.
    expect(sent).toEqual([]);

    // The session should NOT be in the client's subscribed set.
    // (subscribeClientToSession returns early before adding it.)
    // Verify by broadcasting a new event — it should not be delivered.
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 30,
      payload: { agentId: 'kory-manager', content: 'post-delete' },
    });
    expect(sent).toEqual([]);
  });

  test('does not deliver new broadcasts to an erased session', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const socket = {
      data: { id: 'client-1' },
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: () => {},
    } as unknown as ServerWebSocket<WSClientData>;
    manager.add(socket);
    manager.subscribeClientToSession('client-1', 'session-1');

    // Client receives events before erasure.
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 10,
      payload: { agentId: 'kory-manager', content: 'before' },
    });
    expect(sent.length).toBe(1);

    // Erase the session.
    manager.forgetSession('session-1');

    // Post-erasure broadcast should NOT be delivered.
    manager.broadcastToSession('session-1', {
      type: 'session.updated',
      timestamp: 20,
      payload: { session: { id: 'session-1', title: 'should not appear' } },
    });
    expect(sent.length).toBe(1); // still only the pre-erasure event
  });
});
