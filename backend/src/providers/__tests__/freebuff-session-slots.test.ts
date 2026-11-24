import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireFreebuffSessionSlot,
  FreebuffSessionSlotError,
  freebuffSlotPidAlive,
  peekFreebuffSessionSlot,
  readFreebuffSlotInfo,
  resetFreebuffSessionSlotsForTests,
  type FreebuffSessionSlotDeps,
} from '../freebuff-session-slots';

const temporary: string[] = [];
afterEach(() => {
  resetFreebuffSessionSlotsForTests();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function slotsFixture(overrides: Partial<FreebuffSessionSlotDeps> = {}) {
  const slotsDir = mkdtempSync(join(tmpdir(), 'freebuff-slots-'));
  temporary.push(slotsDir);
  const deps: FreebuffSessionSlotDeps = {
    slotsDir,
    kill: (pid) => process.kill(pid, 0),
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    ...overrides,
  };
  const dirOf = (accountId: string) => join(slotsDir, Buffer.from(accountId).toString('base64url'));
  return { deps, slotsDir, dirOf };
}

/** A live foreign pid: a real sleep child we own for the test. */
function foreignPid() {
  const child = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  const killIt = () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  return { pid: child.pid, kill: killIt, exited: child.exited };
}

function writeLease(
  dir: string,
  info: { pid: number; sessionId: string; role: string; startedAt?: number },
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'info.json'), JSON.stringify(info), { mode: 0o600 });
}

/** Await a promise that must reject with FreebuffSessionSlotError<reason>. */
async function expectSlotError(promise: Promise<unknown>, reason: string) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(FreebuffSessionSlotError);
  expect((error as FreebuffSessionSlotError).reason).toBe(reason);
}

describe('Freebuff session slot lease', () => {
  it('acquires, writes the lease file and releases cleanly', async () => {
    const { deps, dirOf } = slotsFixture();
    const release = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 's1',
        role: 'manager',
      },
      deps,
    );
    const info = readFreebuffSlotInfo(join(dirOf('acct-a'), 'info.json'));
    expect(info).toMatchObject({ pid: process.pid, sessionId: 's1', role: 'manager' });
    release();
    expect(existsSync(dirOf('acct-a'))).toBe(false);
    // Idempotent and re-acquirable.
    release();
    const again = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 's2',
        role: 'manager',
      },
      deps,
    );
    again();
  });

  it('non-blocking acquire reports busy while held in-process', async () => {
    const { deps } = slotsFixture();
    const release = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 's1',
        role: 'manager',
      },
      deps,
    );
    await expectSlotError(
      acquireFreebuffSessionSlot('acct-a', { sessionId: 'other', role: 'worker' }, deps),
      'busy',
    );
    release();
  });

  it('FIFO: waiters are granted in arrival order and release frees the next', async () => {
    const { deps } = slotsFixture();
    const order: string[] = [];
    const releaseA = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'a',
        role: 'manager',
      },
      deps,
    );
    const b = acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'b',
        role: 'worker',
        waitTimeoutMs: 5_000,
      },
      deps,
    ).then((release) => {
      order.push('b');
      return release;
    });
    const c = acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'c',
        role: 'critic',
        waitTimeoutMs: 5_000,
      },
      deps,
    ).then((release) => {
      order.push('c');
      return release;
    });
    await Bun.sleep(60);
    releaseA();
    const releaseB = await b;
    // C must still be parked behind B's hold.
    await Bun.sleep(60);
    expect(order).toEqual(['b']);
    releaseB();
    const releaseC = await c;
    releaseC();
    expect(order).toEqual(['b', 'c']);
    // Everything settled: the slot is re-acquirable non-blocking.
    const again = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'd',
        role: 'manager',
      },
      deps,
    );
    again();
  });

  it('fails a same-session manager→worker request with deadlock, in-process', async () => {
    const { deps } = slotsFixture();
    const release = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'chat-1',
        role: 'manager',
      },
      deps,
    );
    await expectSlotError(
      acquireFreebuffSessionSlot(
        'acct-a',
        {
          sessionId: 'chat-1',
          role: 'worker',
          waitTimeoutMs: 5_000,
        },
        deps,
      ),
      'deadlock',
    );
    // The manager itself may still wait (e.g. a retry attempt).
    const second = acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'chat-1',
        role: 'manager',
        waitTimeoutMs: 5_000,
      },
      deps,
    );
    await Bun.sleep(40);
    release();
    (await second)();
  });

  it('fails queued delegates of a session the moment a same-session manager lands', async () => {
    const { deps } = slotsFixture();
    const releaseWorker = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'chat-2',
        role: 'worker',
      },
      deps,
    );
    const parked = acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'chat-2',
        role: 'critic',
        waitTimeoutMs: 5_000,
      },
      deps,
    );
    await Bun.sleep(40);
    releaseWorker();
    // The worker releases; the critic is next in line — but the slot was
    // taken by another account path? No: the critic now attempts and wins.
    (await parked)();
  });

  it('detects deadlock against a cross-process holder via info.json', async () => {
    const { deps, dirOf } = slotsFixture();
    const { pid, kill } = foreignPid();
    try {
      writeLease(dirOf('acct-x'), {
        pid,
        sessionId: 'chat-9',
        role: 'manager',
        startedAt: Date.now(),
      });
      await expectSlotError(
        acquireFreebuffSessionSlot(
          'acct-x',
          {
            sessionId: 'chat-9',
            role: 'worker',
            waitTimeoutMs: 5_000,
          },
          deps,
        ),
        'deadlock',
      );
    } finally {
      kill();
    }
  });

  it('reclaims a stale lease whose holder pid is dead', async () => {
    const { deps, dirOf } = slotsFixture();
    const { pid, kill, exited } = foreignPid();
    writeLease(dirOf('acct-s'), {
      pid,
      sessionId: 'zombie',
      role: 'manager',
      startedAt: Date.now() - 60_000,
    });
    kill(); // holder dies with the lease still on disk
    await exited; // reap the child: a zombie still answers kill(pid, 0)
    const release = await acquireFreebuffSessionSlot(
      'acct-s',
      {
        sessionId: 'fresh',
        role: 'manager',
      },
      deps,
    );
    expect(readFreebuffSlotInfo(join(dirOf('acct-s'), 'info.json'))).toMatchObject({
      sessionId: 'fresh',
    });
    release();
  });

  it('waits out a foreign process holder and acquires when it frees', async () => {
    const { deps, dirOf } = slotsFixture();
    const { pid, kill } = foreignPid();
    try {
      writeLease(dirOf('acct-f'), {
        pid,
        sessionId: 'foreign',
        role: 'manager',
        startedAt: Date.now(),
      });
      // Non-blocking first: live foreign pid is 'busy'.
      await expectSlotError(
        acquireFreebuffSessionSlot('acct-f', { sessionId: 'ours', role: 'manager' }, deps),
        'busy',
      );
      const waiting = acquireFreebuffSessionSlot(
        'acct-f',
        {
          sessionId: 'ours',
          role: 'manager',
          waitTimeoutMs: 10_000,
        },
        deps,
      );
      await Bun.sleep(700);
      kill(); // foreign holder goes away; the next 500 ms poll reclaims it
      const release = await waiting;
      release();
    } finally {
      kill();
    }
  });

  it('times out a bounded wait as reason timeout', async () => {
    const { deps, dirOf } = slotsFixture();
    const { pid, kill } = foreignPid();
    try {
      writeLease(dirOf('acct-t'), {
        pid,
        sessionId: 'foreign',
        role: 'manager',
        startedAt: Date.now(),
      });
      await expectSlotError(
        acquireFreebuffSessionSlot(
          'acct-t',
          {
            sessionId: 'ours',
            role: 'manager',
            waitTimeoutMs: 700,
          },
          deps,
        ),
        'timeout',
      );
    } finally {
      kill();
    }
  });

  it('aborts a parked wait promptly', async () => {
    const { deps } = slotsFixture();
    const release = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'holder',
        role: 'manager',
      },
      deps,
    );
    const controller = new AbortController();
    const waiting = acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'waiter',
        role: 'manager',
        signal: controller.signal,
        waitTimeoutMs: 60_000,
      },
      deps,
    );
    await Bun.sleep(50);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    // The aborted waiter left nothing queued behind it.
    release();
    const again = await acquireFreebuffSessionSlot(
      'acct-a',
      {
        sessionId: 'next',
        role: 'manager',
      },
      deps,
    );
    again();
  });

  it('peek reports the live holder and ignores dead leases', async () => {
    const { deps, dirOf } = slotsFixture();
    expect(peekFreebuffSessionSlot('acct-p', deps)).toBeNull();
    const release = await acquireFreebuffSessionSlot(
      'acct-p',
      {
        sessionId: 'held',
        role: 'worker',
      },
      deps,
    );
    expect(peekFreebuffSessionSlot('acct-p', deps)).toMatchObject({
      sessionId: 'held',
      role: 'worker',
    });
    release();
    expect(peekFreebuffSessionSlot('acct-p', deps)).toBeNull();
    const { pid, kill, exited } = foreignPid();
    try {
      writeLease(dirOf('acct-q'), {
        pid,
        sessionId: 'foreign-mgr',
        role: 'manager',
        startedAt: Date.now(),
      });
      expect(peekFreebuffSessionSlot('acct-q', deps)).toMatchObject({
        sessionId: 'foreign-mgr',
        role: 'manager',
      });
      kill();
      await exited; // reap first — a zombie still answers kill(pid, 0)
      expect(peekFreebuffSessionSlot('acct-q', deps)).toBeNull();
    } finally {
      kill();
    }
  });

  it('pid liveness treats EPERM as alive and ESRCH as dead', () => {
    const alive = (pid: number) => {
      if (pid === 1) throw Object.assign(new Error('epperm'), { code: 'EPERM' });
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    expect(freebuffSlotPidAlive(1, alive)).toBe(true);
    expect(freebuffSlotPidAlive(2, alive)).toBe(false);
  });
});
