import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ProcessSupervisor, ProcessLifecycleEvent } from '../supervisor';

process.env.NODE_ENV = 'test';
const lifecycleDatabaseDir = process.env.DATABASE_URL
  ? undefined
  : mkdtempSync(join(tmpdir(), 'kory-process-lifecycle-db-'));
process.env.DATABASE_URL ??= `sqlite://${join(lifecycleDatabaseDir!, 'lifecycle.sqlite')}`;

const supervisorModule = await import('../supervisor');
const database = await import('../database');
const { serializeProcess } = await import('../serialize');

let supervisor: ProcessSupervisor | undefined;

afterAll(() => {
  if (lifecycleDatabaseDir) {
    rmSync(lifecycleDatabaseDir, { recursive: true, force: true });
  }
});

function fresh(
  config: Parameters<typeof supervisorModule.ProcessSupervisor.getInstance>[0] = {},
): ProcessSupervisor {
  (
    supervisorModule.ProcessSupervisor as unknown as {
      instance: ProcessSupervisor | null;
    }
  ).instance = null;
  supervisor = supervisorModule.ProcessSupervisor.getInstance({
    orphanCheckOnStartup: false,
    healthCheckIntervalMs: 999_999,
    ...config,
  });
  return supervisor;
}

async function forceReapTestProcess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.platform !== 'win32' && child.pid > 1) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The production path should normally have reaped it already.
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // The production path should normally have reaped it already.
    }
  }
  await Promise.race([
    Promise.resolve(child.exited).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
}

async function terminalEvent(
  instance: ProcessSupervisor,
  sessionId: string,
  start: () => Promise<unknown>,
): Promise<ProcessLifecycleEvent> {
  let resolveEvent: ((event: ProcessLifecycleEvent) => void) | undefined;
  const terminal = new Promise<ProcessLifecycleEvent>((resolve) => {
    resolveEvent = resolve;
  });
  const unsubscribe = instance.onLifecycle((event) => {
    if (event.sessionId === sessionId && event.type === 'exited') resolveEvent?.(event);
  });
  await start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      terminal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${sessionId}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
}

afterEach(async () => {
  if (!supervisor) return;
  const live = (supervisor as unknown as { processes: Map<string, { id: string }> }).processes;
  for (const process of [...live.values()]) {
    await supervisor.killProcess(process.id, 'SIGKILL').catch(() => false);
  }
  supervisor.shutdown();
  supervisor = undefined;
});

describe('authoritative process lifecycle contract', () => {
  test('workspace barrier closes both idle-to-start and pre-persistence races', async () => {
    const instance = fresh();
    await instance.initialize();
    const sessionId = 'barrier-session';
    const barrier = instance.tryAcquireAgentToolBarrier(sessionId);
    expect(barrier).not.toBeNull();
    await expect(
      instance.startAgentBackgroundProcess({
        name: 'blocked-by-rewind',
        command: 'sleep 5',
        sessionId,
      }),
    ).rejects.toThrow('active workspace barrier');
    barrier?.release();

    const starting = instance.startAgentBackgroundProcess({
      name: 'start-in-flight',
      command: 'sleep 5',
      sessionId,
      restartPolicy: 'never',
    });
    // The in-flight count is installed synchronously, before persistence or
    // Bun.spawn can yield, so Time Travel cannot slip into this window.
    expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
    const process = await starting;
    expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
    await instance.killProcess(process.id, 'SIGKILL');

    const afterTerminal = instance.tryAcquireAgentToolBarrier(sessionId);
    expect(afterTerminal).not.toBeNull();
    afterTerminal?.release();
  });

  test('manual services never enter agent wait or session cancellation', async () => {
    const instance = fresh();
    await instance.initialize();
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));

    const manual = await instance.startManualProcess({
      name: 'manual-service',
      command: 'sleep 5',
      sessionId: 'ownership-session',
    });
    const agent = await instance.startAgentBackgroundProcess({
      name: 'agent-build',
      command: 'sleep 5',
      sessionId: 'ownership-session',
      restartPolicy: 'never',
    });

    expect(instance.hasActiveAgentToolForSession('ownership-session')).toBe(true);
    expect(await instance.cancelAgentBackgroundProcessesForSession('ownership-session')).toBe(1);
    expect(instance.getProcess(manual.id)?.status).toBe('running');
    expect(instance.getProcess(agent.id)).toBeUndefined();

    const cancelled = events.find(
      (event) => event.id === agent.id && event.terminalReason === 'session-cancelled',
    );
    expect(cancelled?.status).toBe('killed');
    expect(cancelled?.provenance).toBe('agent-tool');
    const persistedAgent = await database.getProcessById(agent.id);
    expect(persistedAgent?.terminalReason).toBe('session-cancelled');
    expect(persistedAgent?.status).toBe('killed');
    expect(await serializeProcess(persistedAgent)).toEqual(
      expect.objectContaining({
        provenance: 'agent-tool',
        supervision: 'owned-child',
        isBackground: true,
        status: 'killed',
        terminalReason: 'session-cancelled',
      }),
    );

    await instance.killProcess(manual.id, 'SIGKILL');
  });

  test('agent background work strips backend secrets while manual services retain explicit host env', async () => {
    const spawnOptions: Array<Record<string, unknown>> = [];
    const instance = fresh({
      spawnProcess: (command, options) => {
        spawnOptions.push(options);
        return Bun.spawn(command, options as any);
      },
    });
    await instance.initialize();
    const previous = process.env.KORY_BACKGROUND_ENV_SECRET;
    process.env.KORY_BACKGROUND_ENV_SECRET = 'background-secret-must-not-leak';
    try {
      const agentEvent = await terminalEvent(instance, 'agent-safe-env-session', async () => {
        await instance.startAgentBackgroundProcess({
          name: 'agent-safe-env',
          command:
            'if [ -n "${KORY_BACKGROUND_ENV_SECRET:-}" ]; then printf leaked; exit 23; else printf safe; fi',
          sessionId: 'agent-safe-env-session',
          restartPolicy: 'never',
        });
      });
      expect(agentEvent.status).toBe('exited');
      expect(agentEvent.logsTail).toContain('safe');
      expect(agentEvent.logsTail).not.toContain('background-secret-must-not-leak');

      const manualEvent = await terminalEvent(instance, 'manual-host-env-session', async () => {
        await instance.startManualProcess({
          name: 'manual-host-env',
          command: 'printf manual-inherited',
          sessionId: 'manual-host-env-session',
          restartPolicy: 'never',
        });
      });
      expect(manualEvent.status).toBe('exited');
      expect(manualEvent.logsTail).toContain('manual-inherited');
      expect(spawnOptions[0]?.env).toEqual(
        expect.not.objectContaining({ KORY_BACKGROUND_ENV_SECRET: expect.anything() }),
      );
      expect(Object.prototype.hasOwnProperty.call(spawnOptions[1] ?? {}, 'env')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KORY_BACKGROUND_ENV_SECRET;
      else process.env.KORY_BACKGROUND_ENV_SECRET = previous;
    }
  });

  test('TERM-ignoring children keep recovery blocked until group KILL is reaped', async () => {
    // Process-group signal delivery (SIGTERM/SIGKILL to -pid) and bash `trap`
    // are Unix-specific. Windows has no equivalent, so skip this contract there.
    // Use globalThis.process because this test scope shadows `process` with a
    // local variable below (the started background process record).
    if (globalThis.process.platform === 'win32') return;
    const instance = fresh({
      terminationGraceMs: 50,
      killReapTimeoutMs: 1_000,
    });
    await instance.initialize();
    const sessionId = `ignore-term-${Date.now()}`;
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    const process = await instance.startAgentBackgroundProcess({
      name: 'ignore-term',
      command: `trap '' TERM; printf 'trap-ready'; while :; do sleep 1; done`,
      sessionId,
      restartPolicy: 'never',
    });
    const readyDeadline = Date.now() + 1_000;
    while (
      !(await instance.getProcessLogs(process.id))?.stdout.includes('trap-ready') &&
      Date.now() < readyDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await instance.getProcessLogs(process.id))?.stdout).toContain('trap-ready');

    const firstKill = instance.killProcess(process.id, 'SIGTERM', 'session-cancelled');
    const concurrentKill = instance.killProcess(process.id, 'SIGTERM', 'session-cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The cancellation request is not a terminal outcome yet. The authoritative
    // predicate and Time Travel barrier must continue to see the owned child.
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(true);
    expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
    expect(await Promise.all([firstKill, concurrentKill])).toEqual([true, true]);

    let alive = true;
    try {
      globalThis.process.kill(process.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
    const afterReap = instance.tryAcquireAgentToolBarrier(sessionId);
    expect(afterReap).not.toBeNull();
    afterReap?.release();

    const persisted = await database.getProcessById(process.id);
    expect(persisted?.status).toBe('killed');
    expect(persisted?.terminalReason).toBe('session-cancelled');
    expect(persisted?.signal).toBe('SIGKILL');
    expect(
      events.filter((event) => event.id === process.id && event.type === 'exited'),
    ).toHaveLength(1);
  });

  test('leader exit keeps supervision active until the complete POSIX group exits', async () => {
    if (process.platform === 'win32') return;
    const instance = fresh();
    await instance.initialize();
    const sessionId = `descendant-after-leader-${Date.now()}`;
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    const processRecord = await instance.startAgentBackgroundProcess({
      name: 'descendant-after-leader',
      command: 'sleep 0.8 >/dev/null 2>&1 & exit 0',
      sessionId,
      restartPolicy: 'never',
    });

    await Promise.resolve(processRecord.proc.exited);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let groupAlive = false;
    try {
      globalThis.process.kill(-processRecord.pid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    expect(groupAlive).toBe(true);
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(true);
    expect(instance.getProcess(processRecord.id)?.status).toBe('running');
    expect(events.some((event) => event.id === processRecord.id && event.type === 'exited')).toBe(
      false,
    );
    expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const terminal = await Promise.race([
      new Promise<ProcessLifecycleEvent>((resolve) => {
        const unsubscribe = instance.onLifecycle((event) => {
          if (event.id === processRecord.id && event.type === 'exited') {
            unsubscribe();
            resolve(event);
          }
        });
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out waiting for descendant reap')),
          3_000,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    expect(terminal.status).toBe('exited');
    expect(terminal.terminalReason).toBe('exit-zero');
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
    expect(instance.getProcess(processRecord.id)).toBeUndefined();
    const barrier = instance.tryAcquireAgentToolBarrier(sessionId);
    expect(barrier).not.toBeNull();
    barrier?.release();
  });

  test('cancellation after leader exit reaps descendants before publishing killed', async () => {
    if (process.platform === 'win32') return;
    const instance = fresh({ terminationGraceMs: 50, killReapTimeoutMs: 1_000 });
    await instance.initialize();
    const sessionId = `cancel-descendant-after-leader-${Date.now()}`;
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    const processRecord = await instance.startAgentBackgroundProcess({
      name: 'cancel-descendant-after-leader',
      command: 'sleep 30 >/dev/null 2>&1 & exit 0',
      sessionId,
      restartPolicy: 'never',
    });

    await Promise.resolve(processRecord.proc.exited);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(true);
    expect(await instance.killProcess(processRecord.id, 'SIGTERM', 'killed-by-user')).toBe(true);

    let groupAlive = false;
    try {
      globalThis.process.kill(-processRecord.pid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    expect(groupAlive).toBe(false);
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: processRecord.id,
        type: 'exited',
        status: 'killed',
        terminalReason: 'killed-by-user',
      }),
    );
    expect(
      events.filter((event) => event.id === processRecord.id && event.type === 'exited'),
    ).toHaveLength(1);
  });

  test('manual restart cannot overlap a descendant whose leader already exited', async () => {
    if (process.platform === 'win32') return;
    const instance = fresh({ terminationGraceMs: 50, killReapTimeoutMs: 1_000 });
    await instance.initialize();
    const directory = mkdtempSync(join(tmpdir(), 'kory-descendant-restart-'));
    const marker = join(directory, 'started-once');
    const sessionId = `descendant-restart-${Date.now()}`;
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    const processRecord = await instance.startAgentBackgroundProcess({
      name: 'descendant-restart',
      command: `if [ ! -f '${marker}' ]; then touch '${marker}'; sleep 30 >/dev/null 2>&1 & exit 0; else printf restarted; fi`,
      sessionId,
      restartPolicy: 'never',
    });
    const originalPid = processRecord.pid;
    let replacementId: string | undefined;

    try {
      await Promise.resolve(processRecord.proc.exited);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(true);

      let resolveFinal: ((event: ProcessLifecycleEvent) => void) | undefined;
      const finalTerminal = new Promise<ProcessLifecycleEvent>((resolve) => {
        resolveFinal = resolve;
      });
      const unsubscribe = instance.onLifecycle((event) => {
        if (
          event.sessionId === sessionId &&
          event.type === 'exited' &&
          event.terminalReason === 'exit-zero'
        ) {
          resolveFinal?.(event);
        }
      });
      const restarted = await instance.restartProcess(processRecord.id);
      replacementId = restarted?.id;
      expect(restarted).not.toBeNull();
      expect(restarted?.pid).not.toBe(originalPid);
      let oldGroupAlive = false;
      try {
        globalThis.process.kill(-originalPid, 0);
        oldGroupAlive = true;
      } catch {
        oldGroupAlive = false;
      }
      expect(oldGroupAlive).toBe(false);

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const final = await Promise.race([
        finalTerminal,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for replacement')), 3_000);
        }),
      ]).finally(() => {
        unsubscribe();
        if (timeout) clearTimeout(timeout);
      });
      expect(final.status).toBe('exited');
      expect(final.terminalReason).toBe('exit-zero');
      expect(final.logsTail).toContain('restarted');
      expect(events).toContainEqual(
        expect.objectContaining({
          id: processRecord.id,
          status: 'killed',
          terminalReason: 'killed-for-restart',
        }),
      );
      expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
    } finally {
      const live = instance.getProcess(replacementId ?? processRecord.id);
      if (live) await instance.killProcess(live.id, 'SIGKILL').catch(() => false);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a gone process-group generation is never signalled after numeric PGID reuse', async () => {
    if (process.platform === 'win32') return;
    type SyntheticChild = {
      pid: number;
      exited: Promise<number>;
      resolveExit: (code: number) => void;
      killCalls: number;
      kill: () => void;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      stdin: { write: () => void; flush: () => Promise<void> };
    };
    const children: SyntheticChild[] = [];
    const instance = fresh({
      spawnProcess: () => {
        let resolveExit: ((code: number) => void) | undefined;
        const child: SyntheticChild = {
          pid: 2_000_000 + children.length,
          exited: new Promise<number>((resolve) => {
            resolveExit = resolve;
          }),
          resolveExit: (code) => resolveExit?.(code),
          killCalls: 0,
          kill: () => {
            child.killCalls += 1;
            child.resolveExit(143);
          },
          stdout: new ReadableStream({ start: (controller) => controller.close() }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          stdin: { write: () => undefined, flush: async () => undefined },
        };
        children.push(child);
        return child;
      },
    });
    await instance.initialize();
    const internals = instance as unknown as {
      ownedProcessGroupState: (process: { pid: number }) => 'alive' | 'gone' | 'unknown';
    };
    const observations = new Map<number, number>();
    // Deterministically model the dangerous race: the original generation is
    // observed absent once, then an unrelated group appears with the same id.
    internals.ownedProcessGroupState = (process) => {
      const count = observations.get(process.pid) ?? 0;
      observations.set(process.pid, count + 1);
      return count === 0 ? 'gone' : 'alive';
    };
    const waitForGoneObservation = async (processRecord: { ownedGroupObservedGone?: boolean }) => {
      const deadline = Date.now() + 500;
      while (!processRecord.ownedGroupObservedGone && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(processRecord.ownedGroupObservedGone).toBe(true);
    };

    const cancelled = await instance.startAgentBackgroundProcess({
      name: 'reused-pgid-cancel',
      command: 'synthetic cancel command',
      sessionId: 'reused-pgid-cancel-session',
      restartPolicy: 'never',
    });
    children[0]!.resolveExit(0);
    await waitForGoneObservation(cancelled);
    expect(await instance.killProcess(cancelled.id, 'SIGTERM', 'killed-by-user')).toBe(true);
    expect(children[0]!.killCalls).toBe(0);

    const original = await instance.startAgentBackgroundProcess({
      name: 'reused-pgid-restart',
      command: 'synthetic restart command',
      sessionId: 'reused-pgid-restart-session',
      restartPolicy: 'never',
    });
    children[1]!.resolveExit(0);
    await waitForGoneObservation(original);
    const replacement = await instance.restartProcess(original.id);
    expect(replacement).not.toBeNull();
    expect(children[1]!.killCalls).toBe(0);
    expect(children).toHaveLength(3);

    if (replacement) {
      children[2]!.resolveExit(0);
      await waitForGoneObservation(replacement);
      const deadline = Date.now() + 500;
      while (instance.getProcess(replacement.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(instance.getProcess(replacement.id)).toBeUndefined();
    }
  });

  test('an unverified kill remains active and publishes a degraded outcome', async () => {
    const instance = fresh({
      terminationGraceMs: 25,
      killReapTimeoutMs: 25,
    });
    await instance.initialize();
    const sessionId = `unverified-kill-${Date.now()}`;
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    const process = await instance.startAgentBackgroundProcess({
      name: 'unverified-kill',
      command: 'sleep 30',
      sessionId,
      restartPolicy: 'never',
    });
    const internals = instance as unknown as {
      signalOwnedChild: (process: unknown, signal: string) => void;
    };
    const realSignal = internals.signalOwnedChild.bind(instance);
    internals.signalOwnedChild = () => undefined;

    try {
      expect(await instance.killProcess(process.id, 'SIGTERM', 'session-cancelled')).toBe(false);
      expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(true);
      expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
      expect(instance.getProcess(process.id)?.status).toBe('running');
      expect(events).toContainEqual(
        expect.objectContaining({
          id: process.id,
          type: 'degraded',
          status: 'degraded',
          provenance: 'agent-tool',
          terminalError: expect.stringContaining('did not exit'),
        }),
      );
      const persisted = await database.getProcessById(process.id);
      expect(persisted?.status).toBe('running');
      expect(persisted?.terminalError).toContain('did not exit');

      // A manual restart is another cancellation request, not permission to
      // overlap a replacement with an unverified old writer.
      expect(await instance.restartProcess(process.id)).toBeNull();
      expect(instance.getProcess(process.id)?.pid).toBe(process.pid);
      expect(
        events.filter((event) => event.id === process.id && event.type === 'started'),
      ).toHaveLength(1);
    } finally {
      internals.signalOwnedChild = realSignal;
      await instance.killProcess(process.id, 'SIGKILL', 'session-cancelled');
    }
  });

  test('a recovered proc-less owner signals and reaps the complete POSIX process group', async () => {
    if (process.platform === 'win32') return;
    const instance = fresh({ terminationGraceMs: 50, killReapTimeoutMs: 1_000 });
    await instance.initialize();
    const directory = mkdtempSync(join(tmpdir(), 'kory-recovered-process-group-'));
    const ready = join(directory, 'ready');
    const late = join(directory, 'late');
    const child = Bun.spawn(
      [
        '/bin/sh',
        '-c',
        "printf ready > ready; trap '' TERM; (trap '' TERM; sleep 0.4; printf late > late) & wait",
      ],
      {
        cwd: directory,
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      },
    );
    const readyDeadline = Date.now() + 1_000;
    while (!(await Bun.file(ready).exists()) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await Bun.file(ready).exists()).toBe(true);

    const now = Date.now();
    const recovered = {
      id: `recovered-group-${now}`,
      name: 'recovered-group',
      command: '/bin/sh',
      cwd: directory,
      pid: child.pid,
      sessionId: `recovered-group-session-${now}`,
      status: 'running' as const,
      provenance: 'agent-tool' as const,
      supervision: 'owned-child' as const,
      isBackground: true,
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never' as const,
      createdAt: now,
      updatedAt: now,
      stdout: '',
      stderr: '',
      lastOutputAt: now,
      recoveredOwnershipVerified: true,
    };
    await database.persistProcess(recovered);
    (instance as unknown as { processes: Map<string, typeof recovered> }).processes.set(
      recovered.id,
      recovered,
    );

    try {
      expect(await instance.killProcess(recovered.id, 'SIGTERM', 'session-cancelled')).toBe(true);
      await Promise.resolve(child.exited).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(await Bun.file(late).exists()).toBe(false);
      expect(instance.hasActiveAgentToolForSession(recovered.sessionId)).toBe(false);
    } finally {
      await forceReapTestProcess(child);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('spawn failure is durable and emits an explicit agent terminal event', async () => {
    const instance = fresh({
      spawnProcess: () => {
        throw new Error('injected spawn failure');
      },
    });
    await instance.initialize();
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));

    await expect(
      instance.startAgentBackgroundProcess({
        name: 'failed-build',
        command: 'bun run build',
        sessionId: 'spawn-failure-session',
      }),
    ).rejects.toThrow('injected spawn failure');

    const [persisted] = await database.getProcessesBySession('spawn-failure-session');
    expect(persisted?.status).toBe('spawn_failed');
    expect(persisted?.terminalReason).toBe('spawn-failed');
    expect(persisted?.terminalError).toBe('injected spawn failure');
    expect(persisted?.provenance).toBe('agent-tool');
    expect(instance.hasActiveAgentToolForSession('spawn-failure-session')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'exited',
        status: 'spawn_failed',
        terminalReason: 'spawn-failed',
        provenance: 'agent-tool',
      }),
    );
  });

  test('drains stdout and stderr into durable snapshots before exit publication', async () => {
    const instance = fresh();
    await instance.initialize();
    const sessionId = 'snapshot-session';
    let processId = '';
    const event = await terminalEvent(instance, sessionId, async () => {
      const process = await instance.startAgentBackgroundProcess({
        name: 'snapshot-command',
        command: `printf 'snapshot-output'; printf 'snapshot-error' >&2`,
        sessionId,
        restartPolicy: 'never',
      });
      processId = process.id;
    });

    expect(event.status).toBe('exited');
    expect(event.terminalReason).toBe('exit-zero');
    expect(event.logsTail).toContain('snapshot-output');
    expect(event.logsTail).toContain('snapshot-error');
    expect(await instance.getProcessLogs(processId)).toEqual({
      stdout: 'snapshot-output',
      stderr: 'snapshot-error',
    });
  });

  test('redacts and bounds command, output, and event evidence before persistence', async () => {
    const instance = fresh();
    await instance.initialize();
    const sessionId = `secret-evidence-session-${Date.now()}`;
    const syntheticSecret = 'sk-proj-SYNTHETICPROCESSSECRET1234567890';
    let processId = '';
    await terminalEvent(instance, sessionId, async () => {
      const process = await instance.startAgentBackgroundProcess({
        name: 'secret-evidence',
        command: `API_KEY=${syntheticSecret}; printf '%s' "$API_KEY"`,
        sessionId,
        restartPolicy: 'never',
      });
      processId = process.id;
    });

    const persisted = await database.getProcessById(processId);
    const events = await database.getProcessEventsById(processId, 20);
    const durableEvidence = JSON.stringify({ persisted, events });
    expect(durableEvidence).not.toContain(syntheticSecret);
    expect(persisted?.command).toContain('[REDACTED]');
    expect(persisted?.stdoutSnapshot).toContain('[REDACTED_KEY]');
    expect(persisted?.commandReplayable).toBe(false);
    expect(await instance.restartProcess(processId)).toBeNull();
  });

  test('a normal durable command remains replayable after its first process exits', async () => {
    const instance = fresh();
    await instance.initialize();
    const sessionId = `durable-restart-session-${Date.now()}`;
    let processId = '';
    await terminalEvent(instance, sessionId, async () => {
      const process = await instance.startAgentBackgroundProcess({
        name: 'durable-restart',
        command: "printf 'durable-restart-output'",
        sessionId,
        restartPolicy: 'never',
      });
      processId = process.id;
    });
    expect((await database.getProcessById(processId))?.commandReplayable).toBe(true);

    let restarted: Awaited<ReturnType<typeof instance.restartProcess>>;
    const terminal = await terminalEvent(instance, sessionId, async () => {
      restarted = await instance.restartProcess(processId);
    });
    expect(restarted!).not.toBeNull();
    expect(terminal.status).toBe('exited');
    expect(terminal.logsTail).toContain('durable-restart-output');
    expect((await database.getProcessById(processId))?.commandReplayable).toBe(true);
  });

  test('non-zero exit is an explicit crash and missing logs remain truthful', async () => {
    const instance = fresh();
    await instance.initialize();
    const sessionId = 'crash-session';
    let processId = '';
    const event = await terminalEvent(instance, sessionId, async () => {
      const process = await instance.startAgentBackgroundProcess({
        name: 'crash-command',
        command: 'exit 7',
        sessionId,
        restartPolicy: 'never',
      });
      processId = process.id;
    });

    expect(event.status).toBe('crashed');
    expect(event.exitCode).toBe(7);
    expect(event.terminalReason).toBe('exit-nonzero');
    expect(event.logsTail).toBeUndefined();
    expect(await instance.getProcessLogs(processId)).toEqual({ stdout: '', stderr: '' });
  });

  test('external CLI work is recorded as detached instead of inferred from quiet output', async () => {
    const instance = fresh();
    await instance.initialize();
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));

    const id = await instance.registerExternal({
      name: 'cli:opaque',
      command: 'provider-owned background command',
      sessionId: 'external-session',
      outputFile: '/missing/provider.output',
    });
    const persisted = await database.getProcessById(id);
    expect(persisted?.status).toBe('detached');
    expect(persisted?.provenance).toBe('agent-external-cli');
    expect(persisted?.supervision).toBe('external-detached');
    expect(persisted?.terminalReason).toBe('external-handle-unavailable');
    expect(instance.hasActiveAgentToolForSession('external-session')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        id,
        status: 'detached',
        terminalReason: 'external-handle-unavailable',
      }),
    );
  });

  test('automatic restart preserves ownership and reaches one truthful final outcome', async () => {
    const instance = fresh({ restartDelayMs: 1, maxRestarts: 1 });
    await instance.initialize();
    const directory = mkdtempSync(join(tmpdir(), 'kory-process-restart-'));
    const marker = join(directory, 'first-attempt');
    const sessionId = 'automatic-restart-session';
    const events: ProcessLifecycleEvent[] = [];
    let resolveFinal: (() => void) | undefined;
    const final = new Promise<void>((resolve) => {
      resolveFinal = resolve;
    });
    instance.onLifecycle((event) => {
      if (event.sessionId !== sessionId) return;
      events.push(event);
      if (event.type === 'exited' && event.status === 'exited') resolveFinal?.();
    });

    const started = await instance.startAgentBackgroundProcess({
      name: 'restart-once',
      command: `if [ ! -f '${marker}' ]; then touch '${marker}'; exit 9; else printf 'restarted'; fi`,
      cwd: directory,
      sessionId,
      restartPolicy: 'on-failure',
      maxRestarts: 1,
    });
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        final,
        new Promise<never>((_, reject) => {
          restartTimer = setTimeout(
            () => reject(new Error('Timed out waiting for automatic restart')),
            5_000,
          );
        }),
      ]);
    } finally {
      if (restartTimer) clearTimeout(restartTimer);
    }

    expect(events.map((event) => `${event.type}:${event.status}`)).toEqual([
      'started:running',
      'exited:crashed',
      'started:running',
      'exited:exited',
    ]);
    expect(events[1]).toEqual(
      expect.objectContaining({
        id: started.id,
        terminalReason: 'exit-nonzero',
        willRestart: true,
        provenance: 'agent-tool',
      }),
    );
    expect(events[3]).toEqual(
      expect.objectContaining({
        id: started.id,
        terminalReason: 'exit-zero',
        willRestart: false,
        provenance: 'agent-tool',
      }),
    );
    const persisted = await database.getProcessById(started.id);
    expect(persisted?.restartCount).toBe(1);
    expect(persisted?.status).toBe('exited');
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });

  test('restart bookkeeping failure publishes a final outcome instead of stranding wait', async () => {
    const instance = fresh({ restartDelayMs: 30, maxRestarts: 1 });
    await instance.initialize();
    const sessionId = 'restart-bookkeeping-failure-session';
    const events: ProcessLifecycleEvent[] = [];
    let resolveRestarting: ((event: ProcessLifecycleEvent) => void) | undefined;
    const restarting = new Promise<ProcessLifecycleEvent>((resolve) => {
      resolveRestarting = resolve;
    });
    let resolveAbandoned: ((event: ProcessLifecycleEvent) => void) | undefined;
    const abandoned = new Promise<ProcessLifecycleEvent>((resolve) => {
      resolveAbandoned = resolve;
    });
    instance.onLifecycle((event) => {
      if (event.sessionId !== sessionId || event.type !== 'exited') return;
      events.push(event);
      if (event.willRestart) resolveRestarting?.(event);
      if (event.terminalReason === 'restart-failed') resolveAbandoned?.(event);
    });

    const started = await instance.startAgentBackgroundProcess({
      name: 'restart-bookkeeping-failure',
      command: 'exit 4',
      sessionId,
      restartPolicy: 'on-failure',
      maxRestarts: 1,
    });
    await Promise.race([
      restarting,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for initial crash')), 2_000),
      ),
    ]);
    await database.deleteProcess(started.id);

    const final = await Promise.race([
      abandoned,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for restart failure')), 2_000),
      ),
    ]);
    expect(final).toEqual(
      expect.objectContaining({
        status: 'crashed',
        terminalReason: 'restart-failed',
        willRestart: false,
      }),
    );
    expect(instance.hasActiveAgentToolForSession(sessionId)).toBe(false);
  });

  test('backend restart recovery marks a missing child orphaned without guessing success', async () => {
    const seed = fresh();
    await seed.initialize();
    const now = Date.now();
    await database.persistProcess({
      id: `restart-missing-${now}`,
      name: 'interrupted-build',
      command: 'sleep 10',
      cwd: process.cwd(),
      pid: 0,
      sessionId: 'restart-recovery-session',
      status: 'starting',
      provenance: 'agent-tool',
      supervision: 'owned-child',
      isBackground: true,
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never',
      createdAt: now,
      updatedAt: now,
    });
    seed.shutdown();

    const recovered = fresh({ orphanCheckOnStartup: true });
    const events: ProcessLifecycleEvent[] = [];
    recovered.onLifecycle((event) => events.push(event));
    await recovered.initialize();

    const [persisted] = await database.getProcessesBySession('restart-recovery-session');
    expect(persisted?.status).toBe('orphaned');
    expect(persisted?.terminalReason).toBe('backend-restart-missing');
    expect(events).toContainEqual(
      expect.objectContaining({
        status: 'orphaned',
        terminalReason: 'backend-restart-missing',
        recovered: true,
      }),
    );
  });

  test('backend restart retains a live identity-mismatched process as degraded and blocks mutation', async () => {
    if (process.platform === 'win32') return;
    const seed = fresh();
    await seed.initialize();
    const directory = mkdtempSync(join(tmpdir(), 'kory-restart-unverified-'));
    const child = Bun.spawn(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
      cwd: directory,
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    const now = Date.now();
    const processId = `restart-unverified-${now}`;
    const sessionId = `restart-unverified-session-${now}`;
    await database.persistProcess({
      id: processId,
      name: 'identity-mismatch',
      command: '/definitely/not/the/live/binary',
      cwd: directory,
      pid: child.pid,
      sessionId,
      status: 'running',
      provenance: 'agent-tool',
      supervision: 'owned-child',
      isBackground: true,
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never',
      createdAt: now,
      updatedAt: now,
    });
    seed.shutdown();

    const recovered = fresh({ orphanCheckOnStartup: true, healthCheckIntervalMs: 999_999 });
    const events: ProcessLifecycleEvent[] = [];
    recovered.onLifecycle((event) => events.push(event));
    try {
      await recovered.initialize();

      expect(recovered.hasActiveAgentToolForSession(sessionId)).toBe(true);
      expect(recovered.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
      expect(recovered.getProcess(processId)?.status).toBe('running');
      expect(await recovered.killProcess(processId, 'SIGKILL')).toBe(false);
      expect(() => process.kill(-child.pid, 0)).not.toThrow();
      expect(events).toContainEqual(
        expect.objectContaining({
          id: processId,
          type: 'degraded',
          status: 'degraded',
          terminalReason: 'backend-restart-unverified',
          recovered: true,
        }),
      );
      expect(events.some((event) => event.id === processId && event.type === 'exited')).toBe(false);
      const persisted = await database.getProcessById(processId);
      expect(persisted?.status).toBe('running');
      expect(persisted?.terminalReason).toBe('backend-restart-unverified');
    } finally {
      await forceReapTestProcess(child);
      await database.updateProcessStatus(processId, 'orphaned', {
        endedAt: Date.now(),
        terminalReason: 'backend-restart-missing',
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('backend restart kills and reaps a verified process group before publishing orphaned', async () => {
    // observeProcess() reads /proc/<pid>/cmdline to verify that a recovered
    // PID still belongs to the original command. /proc does not exist on
    // macOS or Windows, so ownership verification fails and the supervisor
    // retains the process in a degraded state instead of killing it. This
    // test asserts the Linux-only verified-kill path.
    if (process.platform !== 'linux') return;
    const seed = fresh();
    await seed.initialize();
    const directory = mkdtempSync(join(tmpdir(), 'kory-restart-verified-group-'));
    const ready = join(directory, 'ready');
    const late = join(directory, 'late');
    const child = Bun.spawn(
      ['/bin/sh', '-c', 'printf ready > ready; (sleep 0.4; printf late > late) & wait'],
      {
        cwd: directory,
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      },
    );
    const readyDeadline = Date.now() + 1_000;
    while (!(await Bun.file(ready).exists()) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await Bun.file(ready).exists()).toBe(true);

    const now = Date.now();
    const processId = `restart-verified-group-${now}`;
    const sessionId = `restart-verified-group-session-${now}`;
    await database.persistProcess({
      id: processId,
      name: 'verified-descendant-group',
      command: '/bin/sh',
      cwd: directory,
      pid: child.pid,
      sessionId,
      status: 'running',
      provenance: 'agent-tool',
      supervision: 'owned-child',
      isBackground: true,
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never',
      createdAt: now,
      updatedAt: now,
    });
    seed.shutdown();

    const recovered = fresh({
      orphanCheckOnStartup: true,
      healthCheckIntervalMs: 999_999,
      killReapTimeoutMs: 1_000,
    });
    const events: ProcessLifecycleEvent[] = [];
    recovered.onLifecycle((event) => events.push(event));
    try {
      await recovered.initialize();
      await Promise.race([
        Promise.resolve(child.exited).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(await Bun.file(late).exists()).toBe(false);
      expect(() => process.kill(-child.pid, 0)).toThrow();
      expect(recovered.hasActiveAgentToolForSession(sessionId)).toBe(false);
      const barrier = recovered.tryAcquireAgentToolBarrier(sessionId);
      expect(barrier).not.toBeNull();
      barrier?.release();
      const persisted = await database.getProcessById(processId);
      expect(persisted?.status).toBe('orphaned');
      expect(persisted?.terminalReason).toBe('backend-restart-orphaned');
      expect(events).toContainEqual(
        expect.objectContaining({
          id: processId,
          type: 'exited',
          status: 'orphaned',
          terminalReason: 'backend-restart-orphaned',
          recovered: true,
        }),
      );
    } finally {
      await forceReapTestProcess(child);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
