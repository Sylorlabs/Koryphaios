import { describe, expect, test } from 'bun:test';
import { ProcessCompletionCoordinator } from './ProcessCompletionCoordinator';
import type { ProcessLifecycleEvent } from '../../process-supervisor/supervisor';

function completion(id: string, sessionId = 'session-1'): ProcessLifecycleEvent {
  return {
    type: 'exited',
    id,
    name: `process-${id}`,
    command: 'bun run build',
    sessionId,
    status: 'exited',
    exitCode: 0,
  };
}

describe('ProcessCompletionCoordinator', () => {
  test('retains completion while busy and wakes exactly once after idle', async () => {
    let busy = true;
    let resolveWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => busy,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
        resolveWake?.();
      },
    });

    coordinator.enqueue(completion('first'));
    await Promise.resolve();
    expect(coordinator.pendingCount('session-1')).toBe(1);
    expect(batches).toHaveLength(0);

    busy = false;
    coordinator.notifySessionIdle('session-1');
    await woke;
    expect(batches).toEqual([['first']]);
    expect(coordinator.pendingCount('session-1')).toBe(0);
  });

  test('serializes a completion that arrives during a wake turn', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveSecond: (() => void) | undefined;
    const secondWoke = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => false,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
        if (batches.length === 1) await firstGate;
        if (batches.length === 2) resolveSecond?.();
      },
    });

    coordinator.enqueue(completion('first'));
    await Promise.resolve();
    expect(coordinator.isWaking('session-1')).toBe(true);

    coordinator.enqueue(completion('second'));
    await Promise.resolve();
    expect(batches).toEqual([['first']]);

    releaseFirst?.();
    await secondWoke;
    expect(batches).toEqual([['first'], ['second']]);
    expect(coordinator.pendingCount('session-1')).toBe(0);
  });
});
