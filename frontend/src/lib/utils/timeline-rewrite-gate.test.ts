import { describe, expect, test } from 'vitest';
import { TimelineRewriteEpochGate } from './timeline-rewrite-gate';

describe('TimelineRewriteEpochGate', () => {
  test('coalesces the websocket and HTTP initiator paths for one epoch', () => {
    const gate = new TimelineRewriteEpochGate();
    const websocket = gate.adopt('session-1', 2);
    const http = gate.adopt('session-1', 2);

    expect(websocket?.accepted).toBe(true);
    expect(http).toMatchObject({ accepted: false, epoch: 2 });
    expect(http?.signal).toBe(websocket?.signal);
  });

  test('rejects stale rewrites and aborts old-branch loading for a newer epoch', () => {
    const gate = new TimelineRewriteEpochGate();
    const first = gate.adopt('session-1', 2)!;

    expect(gate.adopt('session-1', 1)).toMatchObject({ accepted: false, epoch: 2 });
    const newer = gate.adopt('session-1', 3)!;

    expect(newer.accepted).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(gate.isCurrent('session-1', 2)).toBe(false);
    expect(gate.isCurrent('session-1', 3)).toBe(true);
  });

  test('isolates rewrite epochs by session', () => {
    const gate = new TimelineRewriteEpochGate();
    expect(gate.adopt('session-1', 4)?.accepted).toBe(true);
    expect(gate.adopt('session-2', 2)?.accepted).toBe(true);
    expect(gate.getEpoch('session-1')).toBe(4);
    expect(gate.getEpoch('session-2')).toBe(2);
  });
});
