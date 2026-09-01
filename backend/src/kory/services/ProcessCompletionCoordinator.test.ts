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
    provenance: 'agent-tool',
    supervision: 'owned-child',
    isBackground: true,
    terminalReason: 'exit-zero',
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
      hasActiveAgentProcess: () => false,
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
      hasActiveAgentProcess: () => false,
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

  test('waits for every agent terminal then wakes once with the full batch', async () => {
    let active = true;
    let resolveWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => false,
      hasActiveAgentProcess: () => active,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
        resolveWake?.();
      },
    });

    coordinator.enqueue(completion('first'));
    await Promise.resolve();
    expect(batches).toHaveLength(0);
    expect(coordinator.pendingCount('session-1')).toBe(1);

    active = false;
    coordinator.enqueue(completion('second'));
    await woke;
    expect(batches).toEqual([['first', 'second']]);
  });

  test('reevaluates killed and spawn-failed agent work against remaining terminals', async () => {
    let active = true;
    let resolveWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    const batches: Array<Array<{ id: string; status: string }>> = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => false,
      hasActiveAgentProcess: () => active,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => ({ id: event.id, status: event.status })));
        resolveWake?.();
      },
    });

    coordinator.enqueue({
      ...completion('killed'),
      status: 'killed',
      terminalReason: 'killed-by-user',
    });
    await Promise.resolve();
    expect(batches).toHaveLength(0);

    active = false;
    coordinator.enqueue({
      ...completion('spawn-failed'),
      status: 'spawn_failed',
      terminalReason: 'spawn-failed',
      terminalError: 'executable unavailable',
    });
    await woke;
    expect(batches).toEqual([
      [
        { id: 'killed', status: 'killed' },
        { id: 'spawn-failed', status: 'spawn_failed' },
      ],
    ]);
  });

  test('excludes manual, detached, restarting, and session-cancelled terminals', async () => {
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => false,
      hasActiveAgentProcess: () => false,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
      },
    });

    coordinator.enqueue({
      ...completion('manual'),
      provenance: 'manual-service',
    });
    coordinator.enqueue({
      ...completion('external'),
      provenance: 'agent-external-cli',
      supervision: 'external-detached',
      status: 'detached',
      terminalReason: 'external-handle-unavailable',
    });
    coordinator.enqueue({ ...completion('restart'), willRestart: true });
    coordinator.enqueue({
      ...completion('manual-restart'),
      status: 'killed',
      terminalReason: 'killed-for-restart',
    });
    coordinator.enqueue({
      ...completion('cancelled'),
      status: 'killed',
      terminalReason: 'session-cancelled',
    });
    await Promise.resolve();
    expect(batches).toHaveLength(0);
    expect(coordinator.pendingCount('session-1')).toBe(0);
  });

  test('reconstructs and deduplicates an exact durable batch after restart', async () => {
    let busy = true;
    let resolveWake: (() => void) | undefined;
    const woke = new Promise<void>((resolve) => {
      resolveWake = resolve;
    });
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => busy,
      hasActiveAgentProcess: () => false,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
        resolveWake?.();
      },
    });
    const terminalBeforeCallback = {
      ...completion('persisted-first'),
      status: 'orphaned' as const,
      terminalReason: 'backend-restart-missing' as const,
      recovered: true,
    };
    const second = { ...completion('persisted-second'), recovered: true };

    expect(coordinator.enqueueRecoveredBatch([terminalBeforeCallback, second])).toBe(2);
    expect(coordinator.enqueueRecoveredBatch([terminalBeforeCallback, second])).toBe(0);
    expect(coordinator.pendingCount('session-1')).toBe(2);

    busy = false;
    coordinator.notifySessionIdle('session-1');
    await woke;
    expect(batches).toEqual([['persisted-first', 'persisted-second']]);
  });

  test('cancellation clears queued work and cannot reawaken until a new turn resumes', async () => {
    let busy = true;
    const batches: string[][] = [];
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => busy,
      hasActiveAgentProcess: () => false,
      wakeSession: async (_sessionId, events) => {
        batches.push(events.map((event) => event.id));
      },
    });

    coordinator.enqueue(completion('before-cancel'));
    await Promise.resolve();
    expect(coordinator.pendingCount('session-1')).toBe(1);
    coordinator.cancelSession('session-1');
    coordinator.enqueue(completion('late-exit'));
    busy = false;
    coordinator.notifySessionIdle('session-1');
    await Promise.resolve();
    expect(batches).toHaveLength(0);
    expect(coordinator.pendingCount('session-1')).toBe(0);

    coordinator.resumeSession('session-1');
    coordinator.enqueue(completion('new-turn'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batches).toEqual([['new-turn']]);
  });

  test('retains a failed wake without hot-looping and retries on a new terminal event', async () => {
    let attempts = 0;
    let resolveSuccess: (() => void) | undefined;
    const succeeded = new Promise<void>((resolve) => {
      resolveSuccess = resolve;
    });
    const coordinator = new ProcessCompletionCoordinator({
      isSessionBusy: () => false,
      hasActiveAgentProcess: () => false,
      wakeSession: async () => {
        attempts++;
        if (attempts === 1) throw new Error('injected provider failure');
        resolveSuccess?.();
      },
    });

    coordinator.enqueue(completion('first'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(1);
    expect(coordinator.pendingCount('session-1')).toBe(1);

    // The manager's own finally notification must not immediately retry the
    // same failed provider turn.
    coordinator.notifySessionIdle('session-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(1);

    coordinator.enqueue(completion('second'));
    await succeeded;
    expect(attempts).toBe(2);
    expect(coordinator.pendingCount('session-1')).toBe(0);
  });
});
