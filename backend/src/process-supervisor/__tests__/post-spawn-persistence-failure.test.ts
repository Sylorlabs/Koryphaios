import { afterEach, describe, expect, test } from 'bun:test';
import type { ProcessLifecycleEvent, ProcessSupervisor } from '../supervisor';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';

const supervisorModule = await import('../supervisor');
const { db, reopenDatabase } = await import('@/db');
const { resetSchemaEnsured, initProcessSupervisorTables } = await import('../database');

// This test intentionally closes the shared database singleton to simulate a
// persistence failure. Reopen it after the test so subsequent tests in the
// same process don't inherit a closed database.
afterEach(async () => {
  await reopenDatabase();
  resetSchemaEnsured();
  initProcessSupervisorTables();
});

describe('post-spawn persistence failure boundary', () => {
  test('reaps the detached child and retains degraded barrier truth without a false terminal event', async () => {
    (
      supervisorModule.ProcessSupervisor as unknown as {
        instance: ProcessSupervisor | null;
      }
    ).instance = null;

    let child: ReturnType<typeof Bun.spawn> | undefined;
    const instance = supervisorModule.ProcessSupervisor.getInstance({
      orphanCheckOnStartup: false,
      healthCheckIntervalMs: 999_999,
      killReapTimeoutMs: 1_000,
      spawnProcess: (command, options) => {
        child = Bun.spawn(command, options as any);
        // The initial `starting` row exists. Closing the drizzle session's
        // internal SQLite handle here injects the exact second-write failure
        // after an OS child has been created. We close `db.$client` directly
        // (the raw Database that drizzle's session uses for all queries)
        // rather than `getDb()` because the two may be different instances
        // when the module is loaded with different DATABASE_URL values.
        (db as unknown as { $client: { close(): void } }).$client.close();
        return child;
      },
    });
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    await instance.initialize();

    try {
      await expect(
        instance.startAgentBackgroundProcess({
          name: 'post-spawn-persistence-failure',
          command: 'while :; do :; done',
          sessionId: 'post-spawn-persistence-failure-session',
          restartPolicy: 'never',
        }),
      ).rejects.toThrow();

      expect(child).toBeDefined();
      let groupAlive = false;
      try {
        process.kill(-child!.pid, 0);
        groupAlive = true;
      } catch {
        // Expected: the bounded SIGKILL/reap path completed before rejection.
      }
      expect(groupAlive).toBe(false);
      expect(
        events.filter((event) => event.type === 'exited' && event.status === 'spawn_failed'),
      ).toHaveLength(0);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'degraded',
          status: 'degraded',
          provenance: 'agent-tool',
          terminalError: expect.stringContaining('durable spawn-failed publication failed'),
        }),
      );
      expect(instance.hasActiveAgentToolForSession('post-spawn-persistence-failure-session')).toBe(
        true,
      );
      expect(
        instance.tryAcquireAgentToolBarrier('post-spawn-persistence-failure-session'),
      ).toBeNull();
    } finally {
      instance.shutdown();
      if (child) {
        if (process.platform !== 'win32' && child.pid > 1) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // The verified production cleanup should already have reaped it.
          }
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            // The verified production cleanup should already have reaped it.
          }
        }
        await Promise.race([
          Promise.resolve(child.exited).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    }
  });
});
