import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureMonitors,
  createMonitor,
  disposeMonitors,
  getMonitor,
  listMonitors,
  runDueMonitorsNow,
} from './monitor-service';

const roots: string[] = [];

afterEach(async () => {
  disposeMonitors();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storagePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kory-monitors-'));
  roots.push(root);
  return join(root, 'monitors.json');
}

function runtime(accepted: boolean) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    kory: {
      startSessionTurn: async (input: Record<string, unknown>) => {
        calls.push(input);
        return accepted
          ? { accepted: true, completion: Promise.resolve({ status: 'completed' }) }
          : { accepted: false, result: { status: 'rejected' } };
      },
    } as never,
    sessions: {
      getActive: async () => ({ id: 'session-1' }),
    } as never,
  };
}

describe('monitor service', () => {
  test('fires a real session turn, advances the durable cadence, and reloads after restart', async () => {
    const path = await storagePath();
    const fake = runtime(true);
    await configureMonitors({ kory: fake.kory, sessions: fake.sessions, storagePath: path });

    const monitor = await createMonitor({
      sessionId: 'session-1',
      workingDirectory: '/tmp/project',
      prompt: 'Check the deploy and report only if it regressed.',
      intervalMs: 1_000,
    });
    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.sourceCommandId).toBe(`monitor-${monitor.id}-1`);
    expect(fake.calls[0]?.userMessage).toContain('Check the deploy');
    expect(getMonitor(monitor.id)?.runCount).toBe(1);

    const persisted = JSON.parse(await readFile(path, 'utf-8')) as {
      monitors: Array<{ id: string; runCount: number }>;
    };
    expect(persisted.monitors).toHaveLength(1);
    expect(persisted.monitors[0]?.runCount).toBe(1);

    disposeMonitors();
    await configureMonitors({ kory: fake.kory, sessions: fake.sessions, storagePath: path });
    expect(listMonitors('session-1').map((entry) => entry.id)).toEqual([monitor.id]);
  });

  test('a busy chat keeps the monitor pending instead of consuming its run', async () => {
    const path = await storagePath();
    const fake = runtime(false);
    await configureMonitors({ kory: fake.kory, sessions: fake.sessions, storagePath: path });

    const monitor = await createMonitor({
      sessionId: 'session-1',
      workingDirectory: '/tmp/project',
      prompt: 'Check the queue.',
      intervalMs: 1_000,
    });
    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();

    expect(fake.calls).toHaveLength(1);
    expect(getMonitor(monitor.id)?.runCount).toBe(0);
    expect(getMonitor(monitor.id)!.nextRunAt).toBeGreaterThan(Date.now());
  });

  test('a monitor cannot be cancelled by another chat', async () => {
    const path = await storagePath();
    const fake = runtime(true);
    await configureMonitors({ kory: fake.kory, sessions: fake.sessions, storagePath: path });
    const monitor = await createMonitor({
      sessionId: 'session-1',
      workingDirectory: '/tmp/project',
      prompt: 'Check.',
      intervalMs: 1_000,
    });
    const { cancelMonitor } = await import('./monitor-service');
    expect(await cancelMonitor(monitor.id, 'session-2')).toBeNull();
    expect(getMonitor(monitor.id)?.status).toBe('active');
  });
});
