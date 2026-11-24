import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ServerWebSocket } from 'bun';
import {
  EVENT_RETENTION_KEEP_PER_SESSION,
  OrderedEventLog,
  REPLAY_ENVELOPE_BYTES,
  setOrderedEventLogForTests,
} from '../ordered-event-log';
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

const DELTA_HIGH = 4 * 1024 * 1024;

function setup() {
  const { sqlite, log } = createLog();
  databases.push(sqlite);
  setOrderedEventLogForTests(log);
  const manager = new WSManager();
  managers.push(manager);
  return { sqlite, log, manager };
}

function socket(id: string, sent: string[], buffered: { value: number }) {
  return {
    data: { id },
    readyState: 1,
    send: (value: string) => sent.push(value),
    close: () => {},
    getBufferedAmount: () => buffered.value,
  } as unknown as ServerWebSocket<WSClientData>;
}

function parsed(sent: string[]): any[] {
  return sent.map((value) => JSON.parse(value));
}

/** Serialized size one event occupies in a replay page, as ordered-event-log counts it. */
function pageBytes(payload: object): number {
  return Buffer.byteLength(JSON.stringify(payload)) + REPLAY_ENVELOPE_BYTES;
}

function appendEvent(log: OrderedEventLog, sessionId: string, type: string, payload: object) {
  return log.append({ type, sessionId, timestamp: Date.now(), payload } as any);
}

describe('byte-budgeted replay pages (B6)', () => {
  test('a single oversized event forms its own page and cannot stall replay', () => {
    const { log } = setup();
    appendEvent(log, 's1', 'agent.status', { big: 'x'.repeat(600 * 1024) });
    appendEvent(log, 's1', 'stream.delta', { agentId: 'a', content: 'small' });
    appendEvent(log, 's1', 'stream.delta', { agentId: 'a', content: 'small' });

    const first = log.getPage('s1', 1, 0, { maxEvents: 256, maxBytes: 512 * 1024 });
    expect(first.map((e) => e.sequence)).toEqual([1]);
    const second = log.getPage('s1', 1, 1, { maxEvents: 256, maxBytes: 512 * 1024 });
    expect(second.map((e) => e.sequence)).toEqual([2, 3]);
  });

  test('many small events are split by serialized bytes, not only by count', () => {
    const { log } = setup();
    for (let i = 0; i < 100; i++)
      appendEvent(log, 's1', 'stream.delta', { agentId: 'a', content: 'y'.repeat(1000) });

    const budget = { maxEvents: 256, maxBytes: 10_000 };
    let after = 0;
    const pages: number[] = [];
    const seen: number[] = [];
    while (after < 100) {
      const page = log.getPage('s1', 1, after, budget);
      pages.push(page.length);
      for (const event of page) seen.push(event.sequence!);
      after = page[page.length - 1].sequence!;
    }
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(Math.max(...pages)).toBeLessThan(10);
    expect(pages.length).toBeGreaterThan(1);
  });

  test('a page never ends inside an assistant turn that started within the page', () => {
    const { log } = setup();
    const turnA = { agentId: 'a', messageId: 'turn-a', content: 'a'.repeat(1000) };
    const turnB = { agentId: 'a', messageId: 'turn-b', content: 'b'.repeat(1000) };
    for (let i = 0; i < 3; i++) appendEvent(log, 's1', 'stream.delta', turnA);
    for (let i = 0; i < 3; i++) appendEvent(log, 's1', 'stream.delta', turnB);

    // Four events fit the budget, but the fourth opens turn-b and would strand it half-delivered.
    const page = log.getPage('s1', 1, 0, { maxEvents: 256, maxBytes: 4 * pageBytes(turnA) });
    expect(page.map((e) => e.payload)).toEqual(
      [0, 1, 2].map(() => expect.objectContaining({ messageId: 'turn-a' })),
    );
  });

  test('an oversized turn that starts the page is still cut so the byte budget holds', () => {
    const { log } = setup();
    const big = { agentId: 'a', messageId: 'turn-big', content: 'c'.repeat(1000) };
    for (let i = 0; i < 6; i++) appendEvent(log, 's1', 'stream.delta', big);
    const page = log.getPage('s1', 1, 0, { maxEvents: 256, maxBytes: 4 * pageBytes(big) });
    expect(page).toHaveLength(4);
  });
});

describe('backpressure merges stream deltas for slow sockets (B6)', () => {
  test('merged deltas keep text, order, turn identity, and interleave correctly with lifecycle events', () => {
    const { manager } = setup();
    const sent: string[] = [];
    const buffered = { value: DELTA_HIGH + 1 };
    manager.add(socket('slow', sent, buffered));
    manager.subscribeClientToSession('slow', 'session-1');

    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'Hel' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 2,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'lo ' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 3,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'world' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'stream.complete',
      timestamp: 4,
      payload: { agentId: 'kory', messageId: 'turn-1' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 5,
      payload: { agentId: 'kory', messageId: 'turn-2', content: 'again' },
    } as any);
    expect(sent).toEqual([]);

    buffered.value = 0;
    (manager as any).drainPendingTerminalEvents();

    const frames = parsed(sent);
    expect(frames.map((f) => f.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((f) => f.type)).toEqual([
      'session.replay_skipped',
      'session.replay_skipped',
      'stream.delta',
      'stream.complete',
      'stream.delta',
    ]);
    const deltas = frames.filter((f) => f.type === 'stream.delta');
    expect(deltas[0].payload).toMatchObject({ content: 'Hello world', messageId: 'turn-1' });
    expect(deltas[1].payload).toMatchObject({ content: 'again', messageId: 'turn-2' });
    expect(deltas.map((d) => d.payload.content).join('')).toBe('Hello worldagain');
  });

  test('a lifecycle event goes out immediately after the session pending deltas, never held or merged', () => {
    const { manager } = setup();
    const sent: string[] = [];
    const buffered = { value: DELTA_HIGH + 1 };
    manager.add(socket('slow', sent, buffered));
    manager.subscribeClientToSession('slow', 'session-1');

    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'ab' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 2,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'cd' },
    } as any);
    // Still over the threshold: the lifecycle events must not wait for the drain.
    manager.broadcastToSession('session-1', {
      type: 'turn.provider_completed',
      timestamp: 3,
      payload: { messageId: 'turn-1' },
    } as any);
    manager.broadcastToSession('session-1', {
      type: 'run.settled',
      timestamp: 4,
      payload: { runId: 'run-1' },
    } as any);

    const client = (manager as any).clients.get('slow');
    expect(client.deliveryQueue).toEqual([]);
    expect(client.pendingTerminalEvents).toEqual([]);
    const frames = parsed(sent);
    expect(frames.map((f) => [f.type, f.sequence])).toEqual([
      ['session.replay_skipped', 1],
      ['stream.delta', 2],
      ['turn.provider_completed', 3],
      ['run.settled', 4],
    ]);
    expect(frames[1].payload).toMatchObject({ content: 'abcd', messageId: 'turn-1' });
  });

  test('deltas keep flowing below the delta threshold, even above the 64 KiB overload guard', () => {
    const { manager } = setup();
    const sent: string[] = [];
    const buffered = { value: 512 * 1024 };
    manager.add(socket('busy', sent, buffered));
    manager.subscribeClientToSession('busy', 'session-1');

    manager.broadcastToSession('session-1', {
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory', messageId: 'turn-1', content: 'live' },
    } as any);
    expect(parsed(sent).map((f) => [f.type, f.sequence])).toEqual([['stream.delta', 1]]);
  });
});

describe('retention and prune marks (B7)', () => {
  // KEEP+100 events per session keeps the prune mark at sequence 100 and the
  // first retained event at 101 regardless of the retention constant.
  const APPENDED = EVENT_RETENTION_KEEP_PER_SESSION + 100;
  test('prune keeps the newest events per session and recent events, and records the mark', () => {
    const { sqlite, log } = setup();
    for (let i = 0; i < APPENDED; i++)
      appendEvent(log, 'old', 'stream.delta', { agentId: 'a', content: 'x' });
    for (let i = 0; i < APPENDED; i++)
      appendEvent(log, 'recent', 'stream.delta', { agentId: 'a', content: 'x' });
    sqlite.run('UPDATE ordered_session_events SET created_at = 0 WHERE session_id = ?', ['old']);

    const { deleted } = log.prune(Date.now());
    expect(deleted).toBe(100);
    const kept = log.getAfter('old', 1, 0, 2_048);
    expect(kept).toHaveLength(EVENT_RETENTION_KEEP_PER_SESSION);
    expect(kept[0].sequence).toBe(101);
    expect(log.getPruneMark('old')).toEqual({ epoch: 1, sequence: 100 });

    // Recent events beyond the count window are not pruned.
    expect(log.getAfter('recent', 1, 0, 2_048)).toHaveLength(APPENDED);
    expect(log.getPruneMark('recent')).toBeNull();

    // A second pass finds nothing new and never lowers the mark.
    expect(log.prune(Date.now()).deleted).toBe(0);
    expect(log.getPruneMark('old')).toEqual({ epoch: 1, sequence: 100 });
  });

  /** Prunes the oldest 100 events of session `s1` so the mark lands at sequence 100 of epoch 1. */
  function prunedSession(sqlite: Database, log: OrderedEventLog) {
    for (let i = 0; i < APPENDED; i++)
      appendEvent(log, 's1', 'stream.delta', { agentId: 'a', content: 'x' });
    sqlite.run('UPDATE ordered_session_events SET created_at = 0');
    log.prune(Date.now());
    expect(log.getPruneMark('s1')).toEqual({ epoch: 1, sequence: 100 });
  }

  test('a stale cursor below the mark in the same epoch gets the marker first, then replays from the mark', () => {
    const { sqlite, log, manager } = setup();
    prunedSession(sqlite, log);

    const sent: string[] = [];
    manager.add(socket('stale', sent, { value: 0 }));
    manager.subscribeClientToSession('stale', 's1', { epoch: 1, sequence: 30 });

    const frames = parsed(sent);
    expect(frames[0]).toEqual({
      type: 'session.history_pruned',
      sessionId: 's1',
      epoch: 1,
      timestamp: expect.any(Number),
      payload: { epoch: 1, throughSequence: 100 },
    });
    expect(frames[0]).not.toHaveProperty('sequence');
    expect(frames[1].sequence).toBe(101);
    expect(frames.some((f) => f.type === 'session.timeline_rewritten')).toBe(false);
    expect(log.getCursor('s1').epoch).toBe(1);
  });

  test('a fresh renderer (no cursor) gets the marker and replays from the mark, without rotating the epoch', () => {
    const { sqlite, log, manager } = setup();
    prunedSession(sqlite, log);

    const sent: string[] = [];
    manager.add(socket('fresh', sent, { value: 0 }));
    manager.subscribeClientToSession('fresh', 's1');

    const frames = parsed(sent);
    expect(frames[0]).toMatchObject({
      type: 'session.history_pruned',
      epoch: 1,
      payload: { epoch: 1, throughSequence: 100 },
    });
    expect(frames[0]).not.toHaveProperty('sequence');
    expect(frames[1]).toMatchObject({ sequence: 101, epoch: 1 });
    expect(frames.some((f) => f.type === 'session.timeline_rewritten')).toBe(false);
    expect(log.getCursor('s1').epoch).toBe(1);
  });

  test('a fresh renderer on a different epoch cursor also gets the marker and starts at the mark', () => {
    const { sqlite, log, manager } = setup();
    prunedSession(sqlite, log);

    const sent: string[] = [];
    manager.add(socket('other-epoch', sent, { value: 0 }));
    manager.subscribeClientToSession('other-epoch', 's1', { epoch: 7, sequence: 400 });

    const frames = parsed(sent);
    expect(frames[0]).toMatchObject({
      type: 'session.history_pruned',
      payload: { throughSequence: 100 },
    });
    expect(frames[1].sequence).toBe(101);
    expect(log.getCursor('s1').epoch).toBe(1);
  });

  test('a cursor at or above the prune mark replays without a marker', () => {
    const { sqlite, log, manager } = setup();
    prunedSession(sqlite, log);

    const sent: string[] = [];
    manager.add(socket('caught-up', sent, { value: 0 }));
    manager.subscribeClientToSession('caught-up', 's1', { epoch: 1, sequence: 100 });

    const frames = parsed(sent);
    expect(frames.some((f) => f.type === 'session.history_pruned')).toBe(false);
    expect(frames.some((f) => f.type === 'session.timeline_rewritten')).toBe(false);
    expect(frames[0].sequence).toBe(101);
    expect(log.getCursor('s1').epoch).toBe(1);
  });

  test('a mark from an older epoch does not affect current-epoch replay', () => {
    const { sqlite, log, manager } = setup();
    prunedSession(sqlite, log);
    // Epoch 2 starts after the prune; its own history is unpruned.
    log.resetEpoch('s1');
    for (let i = 0; i < 3; i++)
      appendEvent(log, 's1', 'stream.delta', { agentId: 'a', content: 'y' });
    expect(log.getCursor('s1').epoch).toBe(2);

    const sent: string[] = [];
    manager.add(socket('normal', sent, { value: 0 }));
    manager.subscribeClientToSession('normal', 's1', { epoch: 1, sequence: 5 });

    const frames = parsed(sent);
    expect(frames.some((f) => f.type === 'session.history_pruned')).toBe(false);
    expect(frames.map((f) => [f.epoch, f.sequence])).toEqual([
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
  });
});

describe('replay stays in order across byte-budgeted pages', () => {
  test('a large history replays completely and in sequence order', () => {
    const { log, manager } = setup();
    for (let i = 0; i < 30; i++)
      appendEvent(log, 's1', 'stream.delta', {
        agentId: 'a',
        messageId: `t${i}`,
        content: 'z'.repeat(100 * 1024),
      });
    const sent: string[] = [];
    manager.add(socket('replay', sent, { value: 0 }));
    manager.subscribeClientToSession('replay', 's1', { epoch: 1, sequence: 0 });
    expect(parsed(sent).map((f) => f.sequence)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});
