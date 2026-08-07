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

// 64KB — matches BACKPRESSURE_THRESHOLD in ws-manager.ts.
const BACKPRESSURE_THRESHOLD = 64 * 1024;

function createOverloadedSocket(
  sent: string[],
  bufferedAmount: { value: number },
  id = 'client-1',
): ServerWebSocket<WSClientData> {
  return {
    data: { id },
    readyState: 1,
    send: (value: string) => sent.push(value),
    close: () => {},
    getBufferedAmount: () => bufferedAmount.value,
  } as unknown as ServerWebSocket<WSClientData>;
}

describe('WSManager terminal-event delivery and backpressure', () => {
  test('terminal events are queued when client is overloaded', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    manager.broadcast({
      type: 'stream.complete',
      timestamp: 1,
      payload: { agentId: 'kory-manager' },
    });

    // The terminal event must NOT be sent immediately while overloaded.
    expect(sent).toEqual([]);

    // It must be queued in pendingTerminalEvents for retry.
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(1);
    expect(client.pendingTerminalEvents[0].type).toBe('stream.complete');
    expect(client.overloaded).toBe(true);
  });

  test('terminal events are retried when backpressure clears', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    manager.broadcast({
      type: 'stream.complete',
      timestamp: 1,
      payload: { agentId: 'kory-manager' },
    });
    expect(sent).toEqual([]);

    // Backpressure clears — client drains its buffer.
    bufferedAmount.value = 0;
    (manager as any).retryTerminalEvents('client-1', (manager as any).clients.get('client-1'));

    const delivered = sent.map((value) => JSON.parse(value));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe('stream.complete');

    // The queue should be drained after a successful retry.
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(0);
    expect(client.overloaded).toBe(false);
  });

  test('background process exits are guaranteed under backpressure', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    manager.broadcast({
      type: 'process.exited',
      timestamp: 1,
      sessionId: 'session-1',
      payload: { id: 'build-1', status: 'exited', exitCode: 0 },
    });

    expect(sent).toEqual([]);
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(1);
    expect(client.pendingTerminalEvents[0].type).toBe('process.exited');
  });

  test('non-terminal events are skipped when overloaded', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    manager.broadcast({
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory-manager', content: 'partial' },
    });

    // Not sent immediately.
    expect(sent).toEqual([]);

    // Not queued — non-terminal events are dropped for overloaded clients.
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(0);
    expect(client.overloaded).toBe(true);

    // A retry tick should deliver nothing.
    bufferedAmount.value = 0;
    (manager as any).retryTerminalEvents('client-1', client);
    expect(sent).toEqual([]);
  });

  test('terminal events are delivered even after non-terminal events are skipped', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    // Non-terminal first, then terminal — both while overloaded.
    manager.broadcast({
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory-manager', content: 'partial' },
    });
    manager.broadcast({
      type: 'stream.complete',
      timestamp: 2,
      payload: { agentId: 'kory-manager' },
    });

    // Neither is sent immediately.
    expect(sent).toEqual([]);

    const client = (manager as any).clients.get('client-1');
    // Only the terminal event is queued; the delta was dropped.
    expect(client.pendingTerminalEvents).toHaveLength(1);
    expect(client.pendingTerminalEvents[0].type).toBe('stream.complete');

    // Clear backpressure and retry.
    bufferedAmount.value = 0;
    (manager as any).retryTerminalEvents('client-1', client);

    const delivered = sent.map((value) => JSON.parse(value));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe('stream.complete');
    // The delta must not appear — it was skipped, not queued.
    expect(delivered.find((m) => m.type === 'stream.delta')).toBeUndefined();
  });

  test('multiple terminal events are all queued and retried', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    manager.broadcast({
      type: 'stream.complete',
      timestamp: 1,
      payload: { agentId: 'kory-manager' },
    });
    manager.broadcast({
      type: 'agent.completed',
      timestamp: 2,
      payload: { agentId: 'kory-manager' },
    });
    manager.broadcast({
      type: 'agent.error',
      timestamp: 3,
      payload: { agentId: 'kory-manager', message: 'boom' },
    });

    // None sent while overloaded.
    expect(sent).toEqual([]);

    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents.map((e: any) => e.type)).toEqual([
      'stream.complete',
      'agent.completed',
      'agent.error',
    ]);

    // Clear backpressure and retry — all three should be delivered in order.
    bufferedAmount.value = 0;
    (manager as any).retryTerminalEvents('client-1', client);

    const delivered = sent.map((value) => JSON.parse(value));
    expect(delivered.map((m) => m.type)).toEqual([
      'stream.complete',
      'agent.completed',
      'agent.error',
    ]);
    expect(client.pendingTerminalEvents).toHaveLength(0);
  });

  test('agent.status with terminal status is queued under backpressure', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    // A worker finishes via agent.status: done — this is the real terminal
    // path runAgentThread emits. It must be queued, not dropped.
    manager.broadcast({
      type: 'agent.status',
      timestamp: 1,
      sessionId: 'session-1',
      payload: { agentId: 'worker-1', status: 'done' },
    });

    expect(sent).toEqual([]);
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(1);
    expect(client.pendingTerminalEvents[0].type).toBe('agent.status');

    // Backpressure clears — the terminal status must be delivered.
    bufferedAmount.value = 0;
    (manager as any).retryTerminalEvents('client-1', client);
    const delivered = sent.map((value) => JSON.parse(value));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe('agent.status');
    expect(delivered[0].payload.status).toBe('done');
  });

  test('agent.status with active status is NOT queued under backpressure', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const sent: string[] = [];
    const bufferedAmount = { value: BACKPRESSURE_THRESHOLD + 1 };
    const socket = createOverloadedSocket(sent, bufferedAmount);
    manager.add(socket);

    // An active status is NOT terminal — it must be dropped, not queued,
    // so the retry queue doesn't fill with stale intermediate statuses.
    manager.broadcast({
      type: 'agent.status',
      timestamp: 1,
      sessionId: 'session-1',
      payload: { agentId: 'worker-1', status: 'thinking' },
    });

    expect(sent).toEqual([]);
    const client = (manager as any).clients.get('client-1');
    expect(client.pendingTerminalEvents).toHaveLength(0);
  });
});
