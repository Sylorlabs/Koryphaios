import { describe, expect, test } from 'vitest';
import { OrderedEventBuffer } from './ordered-event-buffer';

interface Event {
  epoch: number;
  sequence: number;
  value: string;
}

const event = (sequence: number, epoch = 1): Event => ({
  epoch,
  sequence,
  value: `event-${sequence}`,
});

describe('OrderedEventBuffer', () => {
  test('never releases an event across a gap', () => {
    const buffer = new OrderedEventBuffer<Event>(1, 0, true);

    expect(buffer.ingest(event(3))).toEqual({ kind: 'gap', events: [] });
    expect(buffer.ingest(event(1))).toEqual({ kind: 'gap', events: [event(1)] });
    expect(buffer.ingest(event(2))).toEqual({
      kind: 'ready',
      events: [event(2), event(3)],
    });
    expect(buffer.lastApplied).toBe(3);
  });

  test('drops duplicates without delivering them twice', () => {
    const buffer = new OrderedEventBuffer<Event>(1, 0, true);
    expect(buffer.ingest(event(1)).events).toEqual([event(1)]);
    expect(buffer.ingest(event(1))).toEqual({ kind: 'duplicate', events: [] });
    expect(buffer.ingest(event(2)).events).toEqual([event(2)]);
  });

  test('requires an explicit cursor before releasing initial live traffic', () => {
    const buffer = new OrderedEventBuffer<Event>(1);
    expect(buffer.ingest(event(8))).toEqual({ kind: 'gap', events: [] });
    expect(buffer.establishCursor(1, 7)).toEqual([event(8)]);
    expect(buffer.lastApplied).toBe(8);
  });

  test('rejects another epoch and bounds adversarial pending traffic', () => {
    const buffer = new OrderedEventBuffer<Event>(1, 0, true, 2);
    expect(buffer.ingest(event(1, 2)).kind).toBe('epoch_mismatch');
    expect(buffer.ingest(event(3)).kind).toBe('gap');
    expect(buffer.ingest(event(4)).kind).toBe('gap');
    expect(buffer.ingest(event(5)).kind).toBe('overflow');
  });

  test('preserves strict order under deterministic shuffled and duplicate traffic', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const buffer = new OrderedEventBuffer<Event>(1, 0, true);
      const traffic = Array.from({ length: 128 }, (_, index) => event(index + 1));
      let state = seed;
      for (let index = traffic.length - 1; index > 0; index -= 1) {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        const swap = state % (index + 1);
        [traffic[index], traffic[swap]] = [traffic[swap], traffic[index]];
      }
      traffic.splice(17, 0, traffic[17], traffic[31]);

      const delivered = traffic.flatMap((item) => buffer.ingest(item).events);
      expect(delivered.map((item) => item.sequence)).toEqual(
        Array.from({ length: 128 }, (_, index) => index + 1),
      );
    }
  });
});
