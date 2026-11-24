import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureMonitors,
  createMonitor,
  disposeMonitors,
  getMonitor,
  listAllMonitors,
  runDueMonitorsNow,
} from './monitor-service';

const roots: string[] = [];

afterEach(async () => {
  disposeMonitors();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storagePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kory-monitor-schedules-'));
  roots.push(root);
  return join(root, 'monitors.json');
}

interface FakeRuntime {
  turns: Array<{ sessionId: string; sourceCommandId: string }>;
  chatsCreated: Array<{ workingDirectory: string; title: string }>;
  kory: never;
  sessions: never;
  createChat: (input: { workingDirectory: string; title: string }) => Promise<{ id: string }>;
  /** Sessions that exist and are active. */
  active: Set<string>;
  /** When true, the next startSessionTurn throws, like a crash before acceptance. */
  failNextTurn: boolean;
}

function runtime(options: { accepted?: boolean } = {}): FakeRuntime {
  const active = new Set<string>(['origin']);
  const turns: FakeRuntime['turns'] = [];
  const chatsCreated: FakeRuntime['chatsCreated'] = [];
  const fake: FakeRuntime = {
    turns,
    chatsCreated,
    active,
    failNextTurn: false,
    kory: {
      startSessionTurn: async (input: { sessionId: string; sourceCommandId: string }) => {
        if (fake.failNextTurn) {
          fake.failNextTurn = false;
          throw new Error('turn could not start');
        }
        turns.push({ sessionId: input.sessionId, sourceCommandId: input.sourceCommandId });
        return options.accepted === false
          ? { accepted: false, result: { status: 'rejected' } }
          : { accepted: true, completion: Promise.resolve({ status: 'completed' }) };
      },
    } as never,
    sessions: {
      getActive: async (id: string) => (active.has(id) ? { id } : null),
    } as never,
    createChat: async (input) => {
      chatsCreated.push(input);
      const id = `chat-${chatsCreated.length}`;
      active.add(id);
      return { id };
    },
  };
  return fake;
}

async function configure(fake: FakeRuntime, path: string) {
  await configureMonitors({
    kory: fake.kory,
    sessions: fake.sessions,
    storagePath: path,
    createChat: fake.createChat,
  });
}

describe('clock and one-shot monitors', () => {
  test('a daily monitor is armed at its next local occurrence and advances after firing', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Check the nightly build.',
      schedule: { kind: 'daily', time: '09:00' },
    });
    expect(monitor.schedule).toEqual({ kind: 'daily', time: '09:00' });
    expect(new Date(monitor.nextRunAt).getHours()).toBe(9);
    expect(new Date(monitor.nextRunAt).getMinutes()).toBe(0);
    expect(monitor.nextRunAt).toBeGreaterThan(Date.now());

    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.turns).toEqual([{ sessionId: 'origin', sourceCommandId: `monitor-${monitor.id}-1` }]);
    const after = getMonitor(monitor.id)!;
    expect(after.status).toBe('active');
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(new Date(after.nextRunAt).getHours()).toBe(9);
  });

  test('a one-shot monitor fires once and then completes', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const at = Date.now() + 60 * 60_000;
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Remind me to review the draft.',
      schedule: { kind: 'once', at },
    });
    expect(monitor.nextRunAt).toBe(at);

    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.turns).toHaveLength(1);
    expect(getMonitor(monitor.id)?.status).toBe('completed');
    // A completed one-shot is never armed again, even after another due check.
    getMonitor(monitor.id)!.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.turns).toHaveLength(1);
  });

  test('a one-shot whose time passed while the host was off fires once on wake', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Send the weekly summary.',
      schedule: { kind: 'once', at: Date.now() + 60_000 },
    });
    // Simulate the host being off past the scheduled moment: the durable record
    // says the run is due an hour ago, then the host restarts.
    const { readFile: read, writeFile: write } = await import('node:fs/promises');
    const file = JSON.parse(await read(path, 'utf-8')) as { monitors: Array<{ id: string; nextRunAt: number }> };
    for (const entry of file.monitors) {
      if (entry.id === monitor.id) entry.nextRunAt = Date.now() - 3_600_000;
    }
    await write(path, JSON.stringify(file));
    disposeMonitors();
    await configure(fake, path);
    await runDueMonitorsNow();
    expect(fake.turns).toHaveLength(1);
    expect(getMonitor(monitor.id)?.status).toBe('completed');
  });
});

describe('missed-run policy', () => {
  test('a daily monitor missed for days fires once on wake and does not backfill', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Daily check.',
      schedule: { kind: 'daily', time: '06:00' },
    });
    // Asleep for three days: the due time is far in the past.
    getMonitor(monitor.id)!.nextRunAt = Date.now() - 3 * 24 * 3_600_000;
    await runDueMonitorsNow();
    expect(fake.turns).toHaveLength(1);
    const next = getMonitor(monitor.id)!.nextRunAt;
    expect(next).toBeGreaterThan(Date.now());
    expect(new Date(next).getHours()).toBe(6);
  });
});

describe('new-chat target', () => {
  test('each run opens its own chat through the creation path and starts the turn there', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Summarize overnight alerts.',
      schedule: { kind: 'interval', intervalMs: 60_000 },
      target: 'new_chat',
    });
    expect(monitor.target).toBe('new_chat');

    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.chatsCreated).toEqual([
      expect.objectContaining({ workingDirectory: '/tmp/project' }),
    ]);
    expect(fake.turns).toEqual([
      { sessionId: 'chat-1', sourceCommandId: `monitor-${monitor.id}-1` },
    ]);
    expect(getMonitor(monitor.id)).toMatchObject({ lastChatId: 'chat-1', runCount: 1 });
    expect(getMonitor(monitor.id)?.pendingChatId).toBeUndefined();

    getMonitor(monitor.id)!.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.chatsCreated).toHaveLength(2);
    expect(fake.turns[1]).toEqual({ sessionId: 'chat-2', sourceCommandId: `monitor-${monitor.id}-2` });
  });

  test('a crash after the chat is created reuses that chat on retry instead of opening another', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const monitor = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Retry-safe run.',
      schedule: { kind: 'interval', intervalMs: 60_000 },
      target: 'new_chat',
    });
    fake.failNextTurn = true;
    monitor.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.chatsCreated).toHaveLength(1);
    expect(getMonitor(monitor.id)?.pendingChatId).toBe('chat-1');

    getMonitor(monitor.id)!.nextRunAt = Date.now() - 1;
    await runDueMonitorsNow();
    expect(fake.chatsCreated).toHaveLength(1);
    expect(fake.turns).toEqual([{ sessionId: 'chat-1', sourceCommandId: `monitor-${monitor.id}-1` }]);
  });

  test('a new-chat monitor is refused when no chat factory is configured', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configureMonitors({ kory: fake.kory, sessions: fake.sessions, storagePath: path });
    await expect(
      createMonitor({
        sessionId: 'origin',
        workingDirectory: '/tmp/project',
        prompt: 'Needs a chat factory.',
        schedule: { kind: 'interval', intervalMs: 60_000 },
        target: 'new_chat',
      }),
    ).rejects.toThrow('not available');
  });
});

describe('persistence and the schedule listing', () => {
  test('schedules, targets and status persist and reload; the listing covers every session', async () => {
    const path = await storagePath();
    const fake = runtime();
    await configure(fake, path);
    const daily = await createMonitor({
      sessionId: 'origin',
      workingDirectory: '/tmp/project',
      prompt: 'Daily.',
      schedule: { kind: 'daily', time: '07:45', weekdays: [1, 2, 3, 4, 5] },
    });
    await createMonitor({
      sessionId: 'other',
      workingDirectory: '/tmp/project',
      prompt: 'Cron.',
      schedule: { kind: 'cron', expression: '30 8 * * 1-5' },
      target: 'new_chat',
    });

    const persisted = JSON.parse(await readFile(path, 'utf-8')) as {
      version: number;
      monitors: Array<{ id: string; schedule: unknown; target: string }>;
    };
    expect(persisted.version).toBe(2);
    expect(persisted.monitors.find((m) => m.id === daily.id)?.schedule).toEqual({
      kind: 'daily',
      time: '07:45',
      weekdays: [1, 2, 3, 4, 5],
    });

    disposeMonitors();
    await configure(fake, path);
    expect(getMonitor(daily.id)).toMatchObject({
      schedule: { kind: 'daily', time: '07:45', weekdays: [1, 2, 3, 4, 5] },
      target: 'same_chat',
    });
    expect(listAllMonitors().map((m) => m.target).sort()).toEqual(['new_chat', 'same_chat']);
  });

  test('a v1 record with only intervalMs still loads as an interval schedule', async () => {
    const path = await storagePath();
    const now = Date.now();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            id: 'mon-legacy',
            sessionId: 'origin',
            workingDirectory: '/tmp/project',
            prompt: 'Legacy.',
            intervalMs: 300_000,
            createdAt: now,
            nextRunAt: now + 300_000,
            runCount: 0,
            status: 'active',
          },
        ],
      }),
    );
    const fake = runtime();
    await configure(fake, path);
    expect(getMonitor('mon-legacy')).toMatchObject({
      schedule: { kind: 'interval', intervalMs: 300_000 },
      target: 'same_chat',
      intervalMs: 300_000,
    });
  });
});
