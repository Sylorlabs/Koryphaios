import { describe, expect, test } from 'vitest';
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
