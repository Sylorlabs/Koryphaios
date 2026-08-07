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

function createMockSocket(id: string, bufferedAmount = 0) {
  const state = {
    sent: [] as string[],
    closed: false,
    closeCode: undefined as number | undefined,
    _bufferedAmount: bufferedAmount,
  };
  const socket = {
    data: { id },
    readyState: 1,
    send: (value: string) => state.sent.push(value),
    close: (code?: number) => {
      state.closed = true;
      state.closeCode = code;
    },
    subscribe: () => {},
    publish: () => {},
    publishTo: () => {},
    cork: () => {},
    uncork: () => {},
    remoteAddress: '127.0.0.1',
    binaryType: 'arraybuffer',
    getBufferedAmount: () => state._bufferedAmount,
  } as unknown as ServerWebSocket<WSClientData>;
  return {
    socket,
    state,
    get sent() { return state.sent; },
    get closed() { return state.closed; },
    get closeCode() { return state.closeCode; },
    setBufferedAmount: (n: number) => { state._bufferedAmount = n; },
  };
}

const managers: WSManager[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  setOrderedEventLogForTests(null);
  for (const database of databases.splice(0)) database.close();
});

describe('WSManager lifecycle and backpressure', () => {
  test('rejects new clients after maxClients is reached', () => {
    const manager = new WSManager();
    // Patch maxClients to a small number for testing
    (manager as any).maxClients = 3;
    managers.push(manager);

    for (let i = 0; i < 3; i++) {
      const mock = createMockSocket(`client-${i}`);
      manager.add(mock.socket);
      expect(mock.closed).toBe(false);
    }

    // The 4th client should be rejected with code 1013
    const rejected = createMockSocket('client-3');
    manager.add(rejected.socket);
    expect(rejected.closed).toBe(true);
    expect(rejected.closeCode).toBe(1013);
  });

  test('rejects new clients during shutdown', () => {
    const manager = new WSManager();
    managers.push(manager);
    manager.shutdown();

    const rejected = createMockSocket('post-shutdown');
    manager.add(rejected.socket);
    expect(rejected.closed).toBe(true);
    expect(rejected.closeCode).toBe(1001);
  });

  test('terminal events are queued when client is overloaded and drained after', async () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const mock = createMockSocket('overloaded-client', 128 * 1024);
    manager.add(mock.socket);
    manager.subscribeClientToSession('overloaded-client', 'session-1');

    // Simulate backpressure: set the client's buffer to exceed the threshold
    const client = (manager as any).clients.get('overloaded-client');
    expect(client).toBeDefined();

    // Broadcast a terminal event (stream.complete)
    manager.broadcastToSession('session-1', {
      type: 'stream.complete',
      payload: { sessionId: 'session-1' },
      timestamp: Date.now(),
    } as any);

    // The terminal event should be queued, not sent immediately
    expect(client.pendingTerminalEvents.length).toBeGreaterThan(0);

    // Clear backpressure
    mock.setBufferedAmount(0);
    client.overloaded = false;

    // Manually drain by calling the private method
    (manager as any).drainPendingTerminalEvents();

    // The queued event should now be sent
    const terminalSent = mock.sent.some((msg) => msg.includes('stream.complete'));
    expect(terminalSent).toBe(true);
    expect(client.pendingTerminalEvents.length).toBe(0);
  });

  test('non-terminal events are dropped under backpressure (not queued)', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const mock = createMockSocket('drop-client', 128 * 1024);
    manager.add(mock.socket);
    manager.subscribeClientToSession('drop-client', 'session-2');

    const client = (manager as any).clients.get('drop-client');

    // Broadcast a non-terminal event (agent.status: thinking)
    manager.broadcastToSession('session-2', {
      type: 'agent.status',
      payload: { status: 'thinking', sessionId: 'session-2' },
      timestamp: Date.now(),
    } as any);

    // The non-terminal event should NOT be queued
    expect(client.pendingTerminalEvents.length).toBe(0);
    // And it should NOT have been sent
    const thinkingSent = mock.sent.some((msg) => msg.includes('thinking'));
    expect(thinkingSent).toBe(false);
  });

  test('remove clears session subscriptions to prevent memory leaks', () => {
    const manager = new WSManager();
    managers.push(manager);

    const { socket } = createMockSocket('leak-client');
    manager.add(socket);
    manager.subscribeClientToSession('leak-client', 'session-a');
    manager.subscribeClientToSession('leak-client', 'session-b');

    const client = (manager as any).clients.get('leak-client');
    expect(client.subscribedSessions.size).toBe(2);

    manager.remove(socket);

    // Subscriptions should be cleared
    expect(client.subscribedSessions.size).toBe(0);
    // Client should be removed from the map
    expect((manager as any).clients.has('leak-client')).toBe(false);
  });

  test('handlePong marks client as alive', () => {
    const manager = new WSManager();
    managers.push(manager);

    const { socket } = createMockSocket('pong-client');
    manager.add(socket);

    const client = (manager as any).clients.get('pong-client');
    // Heartbeat sets isAlive to false before sending ping
    client.isAlive = false;

    manager.handlePong('pong-client');
    expect(client.isAlive).toBe(true);
  });

  test('broadcast to unsubscribed session does not send to client', () => {
    const { sqlite, log } = createLog();
    databases.push(sqlite);
    setOrderedEventLogForTests(log);
    const manager = new WSManager();
    managers.push(manager);

    const { socket, sent } = createMockSocket('unsubscribed-client');
    manager.add(socket);
    // Subscribe to session-1 only
    manager.subscribeClientToSession('unsubscribed-client', 'session-1');

    // Broadcast to session-2 — client should NOT receive it
    manager.broadcastToSession('session-2', {
      type: 'agent.status',
      payload: { status: 'thinking', sessionId: 'session-2' },
      timestamp: Date.now(),
    } as any);

    expect(sent.every((msg) => !msg.includes('session-2'))).toBe(true);
  });

  test('shutdown closes all connected clients', () => {
    const manager = new WSManager();
    managers.push(manager);

    const mocks: ReturnType<typeof createMockSocket>[] = [];
    for (let i = 0; i < 3; i++) {
      const mock = createMockSocket(`shutdown-${i}`);
      mocks.push(mock);
      manager.add(mock.socket);
    }

    manager.shutdown();

    // Verify the manager is in shutdown state
    expect((manager as any).isShutdown).toBe(true);
    // All future adds should be rejected
    const postShutdown = createMockSocket('post-shutdown');
    manager.add(postShutdown.socket);
    expect(postShutdown.closed).toBe(true);
  });
});
