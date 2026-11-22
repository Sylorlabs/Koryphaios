import { describe, expect, it, test } from 'vitest';
import { OrderedSessionEventIngress } from './ordered-session-events';

interface Event {
  sessionId?: string;
  epoch?: number;
  sequence?: number;
  value: string;
}

function event(sequence: number, value = `event-${sequence}`): Event {
  return { sessionId: 'session-1', epoch: 1, sequence, value };
}

describe('OrderedSessionEventIngress', () => {
  test('does not advance a reconnect cursor past a late ordered event', () => {
    const ingress = new OrderedSessionEventIngress<Event>();
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      expect(ingress.ingest(event(sequence))).toEqual([event(sequence)]);
    }
    const delivered = [
      ...ingress.ingest(event(10)),
      ...ingress.ingest(event(9)),
      ...ingress.ingest(event(11)),
    ];

    expect(delivered.map((item) => item.sequence)).toEqual([9, 10, 11]);
    expect(ingress.getCursor('session-1')).toEqual({ epoch: 1, sequence: 11 });
  });

  test('keeps an applied cursor across reconnect but lets replay fill a pending gap', () => {
    const ingress = new OrderedSessionEventIngress<Event>();
    expect(ingress.ingest(event(1))).toEqual([event(1)]);
    expect(ingress.ingest(event(3))).toEqual([]);

    ingress.clearPending();

    expect(ingress.ingest(event(2))).toEqual([event(2)]);
    expect(ingress.ingest(event(3))).toEqual([event(3)]);
    expect(ingress.getCursor('session-1')).toEqual({ epoch: 1, sequence: 3 });
  });

  test('requests one replay from the applied cursor and releases a terminal error after the gap', () => {
    const ingress = new OrderedSessionEventIngress<Event>();
    expect(ingress.ingestWithReplayRequest(event(1))).toEqual({ events: [event(1)] });

    const terminal = event(3, 'system.error');
    expect(ingress.ingestWithReplayRequest(terminal)).toEqual({
      events: [],
      replayFrom: { sessionId: 'session-1', epoch: 1, sequence: 1 },
    });
    // A terminal retry on the same socket must not cause a resubscribe storm.
    expect(ingress.ingestWithReplayRequest(terminal)).toEqual({ events: [] });

    // The cursor replay supplies the dropped nonterminal event. Ingress then
    // releases both it and the already-buffered terminal error in order.
    expect(ingress.ingestWithReplayRequest(event(2, 'stream.delta')).events).toEqual([
      event(2, 'stream.delta'),
      terminal,
    ]);
    expect(ingress.getCursor('session-1')).toEqual({ epoch: 1, sequence: 3 });
  });

  test('passes unsequenced control messages through immediately', () => {
    const ingress = new OrderedSessionEventIngress<Event>();
    const control = { value: 'control' };
    expect(ingress.ingest(control)).toEqual([control]);
  });

  test('rejects late rows from the discarded epoch after a timeline rewrite', () => {
    const ingress = new OrderedSessionEventIngress<Event>();
    expect(ingress.ingest(event(1))).toEqual([event(1)]);

    ingress.resetSessionToEpoch('session-1', 2);

    expect(ingress.ingest(event(2, 'old branch'))).toEqual([]);
    const replacement = { sessionId: 'session-1', epoch: 2, sequence: 1, value: 'new branch' };
    expect(ingress.ingest(replacement)).toEqual([replacement]);
    expect(ingress.getCursor('session-1')).toEqual({ epoch: 2, sequence: 1 });
  });
});

describe('pruned history (session.history_pruned)', () => {
  const ev = (sequence: number, epoch = 1) => ({ sessionId: 's1', epoch, sequence, type: 'x' });

  it('a fresh renderer jumps past pruned history without waiting on a gap or a reset', () => {
    const ingress = new OrderedSessionEventIngress<ReturnType<typeof ev>>();
    const skipped = ingress.skipPrunedHistory('s1', 1, 500);
    expect(skipped).toEqual({ events: [], missed: false });
    expect(ingress.ingestWithReplayRequest(ev(501))).toEqual({ events: [ev(501)] });
    expect(ingress.getCursor('s1')).toEqual({ epoch: 1, sequence: 501 });
  });

  it('a live client that applied part of the epoch reports missed events', () => {
    const ingress = new OrderedSessionEventIngress<ReturnType<typeof ev>>();
    ingress.ingest(ev(1));
    ingress.ingest(ev(2));
    expect(ingress.skipPrunedHistory('s1', 1, 300).missed).toBe(true);
    expect(ingress.ingest(ev(301))).toEqual([ev(301)]);
  });

  it('releases a pending tail that becomes contiguous and drops pruned pending copies', () => {
    const ingress = new OrderedSessionEventIngress<ReturnType<typeof ev>>();
    ingress.ingest(ev(1));
    ingress.ingest(ev(5));
    ingress.ingest(ev(11));
    const { events, missed } = ingress.skipPrunedHistory('s1', 1, 10);
    expect(missed).toBe(true);
    expect(events).toEqual([ev(11)]);
    expect(ingress.getCursor('s1')).toEqual({ epoch: 1, sequence: 11 });
  });

  it('a marker at or below the cursor changes nothing', () => {
    const ingress = new OrderedSessionEventIngress<ReturnType<typeof ev>>();
    ingress.ingest(ev(1));
    ingress.ingest(ev(2));
    expect(ingress.skipPrunedHistory('s1', 1, 2)).toEqual({ events: [], missed: false });
    expect(ingress.getCursor('s1')).toEqual({ epoch: 1, sequence: 2 });
  });
});
