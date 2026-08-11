import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLifecycleEvent, ProcessSupervisor } from '../supervisor';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';

const database = await import('../database');
const { db, reopenDatabase } = await import('@/db');
const { resetSchemaEnsured, initProcessSupervisorTables } = await import('../database');
const supervisorModule = await import('../supervisor');

// This test intentionally closes the shared database singleton to simulate a
// recovery database failure. Reopen it after the test so subsequent tests in
// the same process don't inherit a closed database.
afterEach(async () => {
  await reopenDatabase();
  resetSchemaEnsured();
  initProcessSupervisorTables();
});

describe('process restart recovery database boundary', () => {
  test('rejects initialization instead of treating a failed active-process read as empty', async () => {
    // The test spawns /bin/sh and uses POSIX process-group signals
    // (process.kill(-pid, 0/SIGKILL)) to verify orphan ownership. Windows
    // has no /bin/sh and no process-group signal delivery, so skip there.
    if (process.platform === 'win32') return;
    // Reset the schema-ensured flag in case a previous test left it set
    // without creating tables on the current database connection.
    resetSchemaEnsured();
    database.initProcessSupervisorTables();
    const directory = mkdtempSync(join(tmpdir(), 'kory-recovery-db-failure-'));
    const child = Bun.spawn(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
      cwd: directory,
      detached: true,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const now = Date.now();
    const sessionId = `recovery-db-failure-session-${now}`;
    await database.persistProcess({
      id: `recovery-db-failure-${now}`,
      name: 'live-during-database-failure',
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
    // Close the drizzle session's internal SQLite handle. We close
    // `db.$client` directly (the raw Database that drizzle's session uses
    // for all queries) rather than `getDb()` because the two may be
    // different instances when the module is loaded with different
    // DATABASE_URL values across test files.
    (db as unknown as { $client: { close(): void } }).$client.close();

    (
      supervisorModule.ProcessSupervisor as unknown as {
        instance: ProcessSupervisor | null;
      }
    ).instance = null;
    const instance = supervisorModule.ProcessSupervisor.getInstance({
      orphanCheckOnStartup: true,
      healthCheckIntervalMs: 999_999,
    });
    const events: ProcessLifecycleEvent[] = [];
    instance.onLifecycle((event) => events.push(event));
    try {
      await expect(instance.initialize()).rejects.toThrow();
      await expect(
        instance.startAgentBackgroundProcess({
          name: 'must-not-start',
          command: 'printf unsafe-overlap',
          sessionId,
        }),
      ).rejects.toThrow('not initialized');
      expect(instance.tryAcquireAgentToolBarrier(sessionId)).toBeNull();
      expect(events).toHaveLength(0);
      expect(() => process.kill(-child.pid, 0)).not.toThrow();
    } finally {
      instance.shutdown();
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The failed recovery correctly never claimed ownership or signalled.
      }
      await Promise.race([
        Promise.resolve(child.exited).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
