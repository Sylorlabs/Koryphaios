import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ProcessSupervisor, type ProcessLifecycleEvent } from '../supervisor';

// Reset the singleton between tests.
function getFreshSupervisor(config?: Parameters<typeof ProcessSupervisor.getInstance>[0]): ProcessSupervisor {
  (ProcessSupervisor as unknown as { instance: ProcessSupervisor | null }).instance = null;
  return ProcessSupervisor.getInstance(config);
}

describe('ProcessSupervisor exponential backoff', () => {
  let supervisor: ProcessSupervisor;
  let originalSetTimeout: typeof setTimeout;

  beforeEach(() => {
    supervisor = getFreshSupervisor({
      restartDelayMs: 5000,
      maxRestarts: 5,
      healthCheckIntervalMs: 999999,
      orphanCheckOnStartup: false,
    });
    originalSetTimeout = globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    // No shutdown method — clear timers manually.
    const procs = (supervisor as unknown as { processes: Map<string, { healthCheckTimer?: Timer; restartTimer?: Timer }> }).processes;
    for (const proc of procs.values()) {
      if (proc.healthCheckTimer) clearInterval(proc.healthCheckTimer);
      if (proc.restartTimer) clearTimeout(proc.restartTimer);
    }
    procs.clear();
  });

  test('backoff delay follows exponential formula: 5s, 10s, 20s, 40s, 60s (capped)', () => {
    const delays: number[] = [];
    globalThis.setTimeout = ((cb: () => void, delay: number) => {
      delays.push(delay);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    // Bind the private method to the supervisor instance.
    const scheduleRestart = (
      supervisor as unknown as { scheduleRestart: (proc: unknown) => void }
    ).scheduleRestart.bind(supervisor);

    const makeProc = (restartCount: number) => ({
      id: `test-${restartCount}`,
      name: 'test',
      command: 'exit 1',
      cwd: '/tmp',
      sessionId: '',
      status: 'crashed' as const,
      pid: 0,
      restartCount,
      maxRestarts: 10,
      restartPolicy: 'on-failure' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stdout: '',
      stderr: '',
      lastOutputAt: Date.now(),
    });

    scheduleRestart(makeProc(0));
    scheduleRestart(makeProc(1));
    scheduleRestart(makeProc(2));
    scheduleRestart(makeProc(3));
    scheduleRestart(makeProc(4));
    scheduleRestart(makeProc(5));

    expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });

  test('max restart cap emits gave_up lifecycle event', () => {
    const events: ProcessLifecycleEvent[] = [];
    supervisor.onLifecycle((e) => events.push(e));

    const proc = {
      id: 'cap-test',
      name: 'capped',
      command: 'exit 1',
      cwd: '/tmp',
      sessionId: '',
      status: 'crashed' as const,
      pid: 0,
      restartCount: 5,
      maxRestarts: 5,
      restartPolicy: 'on-failure' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stdout: '',
      stderr: '',
      lastOutputAt: Date.now(),
    };

    globalThis.setTimeout = ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const scheduleRestart = (
      supervisor as unknown as { scheduleRestart: (proc: unknown) => void }
    ).scheduleRestart.bind(supervisor);
    scheduleRestart(proc);

    const gaveUpEvent = events.find((e) => e.status === 'gave_up');
    expect(gaveUpEvent).toBeDefined();
    expect(gaveUpEvent?.type).toBe('exited');
    expect(gaveUpEvent?.id).toBe('cap-test');
  });

  test('shouldRestart respects restartPolicy never', () => {
    const shouldRestart = (
      supervisor as unknown as { shouldRestart: (proc: unknown, isCrash: boolean) => boolean }
    ).shouldRestart.bind(supervisor);
    expect(shouldRestart({ restartPolicy: 'never', restartCount: 0, maxRestarts: 5 }, true)).toBe(false);
  });

  test('shouldRestart respects maxRestarts cap', () => {
    const shouldRestart = (
      supervisor as unknown as { shouldRestart: (proc: unknown, isCrash: boolean) => boolean }
    ).shouldRestart.bind(supervisor);
    expect(shouldRestart({ restartPolicy: 'on-failure', restartCount: 5, maxRestarts: 5 }, true)).toBe(false);
    expect(shouldRestart({ restartPolicy: 'on-failure', restartCount: 4, maxRestarts: 5 }, true)).toBe(true);
  });

  test('shouldRestart does not restart on normal exit with on-failure policy', () => {
    const shouldRestart = (
      supervisor as unknown as { shouldRestart: (proc: unknown, isCrash: boolean) => boolean }
    ).shouldRestart.bind(supervisor);
    expect(shouldRestart({ restartPolicy: 'on-failure', restartCount: 0, maxRestarts: 5 }, false)).toBe(false);
    expect(shouldRestart({ restartPolicy: 'on-failure', restartCount: 0, maxRestarts: 5 }, true)).toBe(true);
  });

  test('shouldRestart always restarts with always policy even on normal exit', () => {
    const shouldRestart = (
      supervisor as unknown as { shouldRestart: (proc: unknown, isCrash: boolean) => boolean }
    ).shouldRestart.bind(supervisor);
    expect(shouldRestart({ restartPolicy: 'always', restartCount: 0, maxRestarts: 5 }, false)).toBe(true);
    expect(shouldRestart({ restartPolicy: 'always', restartCount: 0, maxRestarts: 5 }, true)).toBe(true);
  });
});

describe('ProcessSupervisor degraded lifecycle event', () => {
  test('readStream failure emits degraded event (not exited)', async () => {
    const supervisor = getFreshSupervisor({
      healthCheckIntervalMs: 999999,
      orphanCheckOnStartup: false,
    });

    const events: ProcessLifecycleEvent[] = [];
    supervisor.onLifecycle((e) => events.push(e));

    const proc = {
      id: 'stream-test',
      name: 'stream-test',
      command: 'echo hello',
      cwd: '/tmp',
      sessionId: '',
      status: 'running' as const,
      pid: 12345,
      restartCount: 0,
      maxRestarts: 3,
      restartPolicy: 'on-failure' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stdout: '',
      stderr: '',
      lastOutputAt: Date.now(),
    };
    (supervisor as unknown as { processes: Map<string, unknown> }).processes.set('stream-test', proc);

    const throwingReader = {
      read: () => Promise.reject(new Error('Stream broken')),
    };

    const readStream = (
      supervisor as unknown as {
        readStream: (reader: unknown, id: string, type: 'stdout' | 'stderr') => Promise<void>;
      }
    ).readStream.bind(supervisor);

    await readStream(throwingReader, 'stream-test', 'stdout');

    const degradedEvent = events.find((e) => e.type === 'degraded');
    expect(degradedEvent).toBeDefined();
    expect(degradedEvent?.status).toBe('degraded');
    expect(degradedEvent?.id).toBe('stream-test');

    const exitedEvent = events.find((e) => e.type === 'exited' && e.id === 'stream-test');
    expect(exitedEvent).toBeUndefined();
  });
});
