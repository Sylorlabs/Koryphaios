/**
 * Per-account Freebuff live-session slot lease (capacity 1).
 *
 * A Freebuff account holds ONE live model session: a second CLI admission
 * supersedes the first instead of queueing, and the displaced session dies a
 * few seconds later. Koryphaios therefore serializes admission itself and
 * never lets two of its turns — or a turn and someone else's session — fight
 * over the slot. Two layers keep that lease honest:
 *
 *  - In-process: a holder map plus a FIFO waiter queue per account, so a
 *    same-backend manager→worker overlap fails fast instead of racing, and
 *    waiters are granted in arrival order.
 *  - Cross-process: a file lease at ~/.koryphaios/freebuff-slots/<account>
 *    taken by atomic mkdir, so a second Koryphaios backend, a zombie turn
 *    container or the user's own Freebuff CLI/Desktop session is seen too.
 *    A lease whose holder pid is gone is reclaimed; a half-written info.json
 *    gets ~1 s to settle before reclaim.
 *
 * The deadlock rule is applied at both layers: when the holder is the same
 * chat's manager and the requester is a delegate (worker/critic), waiting can
 * never succeed — the manager is parked awaiting that delegate — so the
 * request fails fast with reason 'deadlock' instead of idling to a timeout.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type FreebuffSlotRole = 'manager' | 'worker' | 'critic';
export type FreebuffSessionSlotReason = 'deadlock' | 'busy' | 'timeout';

/** Holder identity as seen by a contender (in-process or file lease). */
export interface FreebuffSessionSlotHolderInfo {
  sessionId: string;
  role: string;
  pid?: number;
  startedAt?: number;
}

export class FreebuffSessionSlotError extends Error {
  constructor(
    message: string,
    readonly reason: FreebuffSessionSlotReason,
    readonly holder?: FreebuffSessionSlotHolderInfo,
  ) {
    super(message);
    this.name = 'FreebuffSessionSlotError';
  }
}

export interface FreebuffSessionSlotRequest {
  sessionId: string;
  role: FreebuffSlotRole;
  signal?: AbortSignal;
  /** > 0 parks in the FIFO queue until acquired or the bound expires
   * ('timeout'). Absent/<= 0 is a single non-blocking attempt ('busy'). */
  waitTimeoutMs?: number;
  /** Called at most once, the first time the request actually blocks. */
  onWaitStart?: () => void;
}

/** Injectable boundary: tests own the directory, clock, liveness and sleeps. */
export interface FreebuffSessionSlotDeps {
  slotsDir: string;
  kill: (pid: number, signal: 0) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Written inside the lease dir by the atomic mkdir winner. */
export interface FreebuffSlotInfoFile {
  pid: number;
  sessionId: string;
  role: string;
  startedAt: number;
}

interface HeldSlot {
  sessionId: string;
  role: FreebuffSlotRole;
  dir: string;
  startedAt: number;
}

interface SlotWaiter {
  sessionId: string;
  role: FreebuffSlotRole;
  /** 'queued' until granted the right to run the file-lease attempt. */
  state: 'queued' | 'attempting';
  grant: () => void;
  fail: (error: Error) => void;
}

const holders = new Map<string, HeldSlot>();
const queues = new Map<string, SlotWaiter[]>();

function defaultDeps(): FreebuffSessionSlotDeps {
  return {
    slotsDir: join(homedir(), '.koryphaios', 'freebuff-slots'),
    kill: (pid) => process.kill(pid, 0),
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
  };
}

function slotDirFor(deps: FreebuffSessionSlotDeps, accountId: string): string {
  return join(deps.slotsDir, Buffer.from(accountId).toString('base64url'));
}

/** Read a lease's info.json. Any missing/corrupt/misshapen content is null —
 * never a throw; callers treat it as a mid-write or a lease to reclaim. */
export function readFreebuffSlotInfo(file: string): FreebuffSlotInfoFile | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const info = parsed as Record<string, unknown>;
    if (
      typeof info.pid !== 'number' ||
      !Number.isSafeInteger(info.pid) ||
      info.pid <= 0 ||
      typeof info.sessionId !== 'string' ||
      typeof info.role !== 'string'
    )
      return null;
    return {
      pid: info.pid,
      sessionId: info.sessionId,
      role: info.role,
      startedAt: typeof info.startedAt === 'number' ? info.startedAt : 0,
    };
  } catch {
    return null;
  }
}

/** process.kill(pid, 0): ESRCH is the only "definitely dead" answer. EPERM and
 * every other error mean a live process we cannot signal — still a holder. */
export function freebuffSlotPidAlive(pid: number, kill: (pid: number, signal: 0) => void): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A same-session manager can never yield its slot to its own delegate: it is
 * parked waiting for that delegate to finish. */
function freebuffSlotIsDeadlock(
  holder: { sessionId: string; role: string },
  requester: { sessionId: string; role: string },
): boolean {
  return (
    holder.sessionId === requester.sessionId &&
    holder.role === 'manager' &&
    requester.role !== 'manager'
  );
}

function dequeueWaiter(accountId: string, waiter: SlotWaiter): void {
  const queue = queues.get(accountId);
  if (!queue) return;
  const index = queue.indexOf(waiter);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) queues.delete(accountId);
}

/** Wake the queue head — but only it, and only when it is still parked. */
function grantNextWaiter(accountId: string): void {
  const head = queues.get(accountId)?.[0];
  if (head?.state === 'queued') head.grant();
}

/** A freshly registered same-session manager makes every queued delegate of
 * that session unsatisfiable — fail them now, not at their deadlines. */
function failQueuedDeadlockedWaiters(
  accountId: string,
  holder: { sessionId: string; role: string },
): void {
  if (holder.role !== 'manager') return;
  for (const waiter of [...(queues.get(accountId) ?? [])]) {
    if (waiter.state !== 'queued') continue;
    if (waiter.sessionId === holder.sessionId && waiter.role !== 'manager') {
      waiter.fail(
        new FreebuffSessionSlotError(
          'the Freebuff manager of this chat holds the account live-session slot',
          'deadlock',
          { sessionId: holder.sessionId, role: holder.role },
        ),
      );
    }
  }
}

/**
 * Acquire the account's single live-session slot. Resolves with an
 * idempotent release that drops the in-process holder, removes the file
 * lease and wakes the next FIFO waiter. Rejects with FreebuffSessionSlotError
 * ('deadlock' | 'busy' | 'timeout') or AbortError.
 */
export function acquireFreebuffSessionSlot(
  accountId: string,
  request: FreebuffSessionSlotRequest,
  dependencies: Partial<FreebuffSessionSlotDeps> = {},
): Promise<() => void> {
  const deps = { ...defaultDeps(), ...dependencies };
  const timeoutMs = Math.max(0, request.waitTimeoutMs ?? 0);
  const blocking = timeoutMs > 0;
  const deadline = deps.now() + timeoutMs;
  const requester = { sessionId: request.sessionId, role: request.role };
  let waitAnnounced = false;
  const announceWait = () => {
    if (waitAnnounced) return;
    waitAnnounced = true;
    request.onWaitStart?.();
  };
  const abortError = () => new DOMException('Aborted', 'AbortError');
  const checkAbort = () => {
    if (request.signal?.aborted) throw abortError();
  };
  const assertNoDeadlock = (holder: FreebuffSessionSlotHolderInfo) => {
    if (freebuffSlotIsDeadlock(holder, requester)) {
      throw new FreebuffSessionSlotError(
        'the Freebuff manager of this chat holds the account live-session slot',
        'deadlock',
        holder,
      );
    }
  };
  const sleepBounded = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      if (!signal) {
        deps.sleep(Math.max(1, ms)).then(resolve, reject);
        return;
      }
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      deps.sleep(Math.max(1, ms)).then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });

  /** Cross-process layer: mkdir is the atomic claim. Polling at 500 ms for a
   * live foreign holder; dead-pid and settled-corrupt leases are reclaimed. */
  const takeFileLease = async (): Promise<string> => {
    mkdirSync(deps.slotsDir, { recursive: true, mode: 0o700 });
    const dir = slotDirFor(deps, accountId);
    let unreadableSince = 0;
    for (;;) {
      checkAbort();
      let existed = false;
      try {
        mkdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') existed = true;
        else throw error;
      }
      if (!existed) {
        try {
          writeFileSync(
            join(dir, 'info.json'),
            JSON.stringify({
              pid: process.pid,
              sessionId: request.sessionId,
              role: request.role,
              startedAt: deps.now(),
            } satisfies FreebuffSlotInfoFile),
            { mode: 0o600 },
          );
          return dir;
        } catch (error) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          throw error;
        }
      }
      const info = readFreebuffSlotInfo(join(dir, 'info.json'));
      if (!info) {
        // Holder mid-write or a corrupt lease: ~1 s to settle, then reclaim.
        const now = deps.now();
        if (!unreadableSince) unreadableSince = now;
        if (now - unreadableSince >= 1_000) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* retry below */
          }
          unreadableSince = 0;
          continue;
        }
        if (!blocking) {
          throw new FreebuffSessionSlotError(
            'the Freebuff live-session slot lease is still being written',
            'busy',
          );
        }
        if (now >= deadline) {
          throw new FreebuffSessionSlotError(
            'timed out waiting for the Freebuff live-session slot',
            'timeout',
          );
        }
        announceWait();
        await sleepBounded(Math.min(50, Math.max(1, deadline - now)));
        continue;
      }
      unreadableSince = 0;
      if (!freebuffSlotPidAlive(info.pid, deps.kill)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* retry below */
        }
        continue;
      }
      assertNoDeadlock(info);
      const now = deps.now();
      if (!blocking) {
        throw new FreebuffSessionSlotError(
          'the Freebuff account live-session slot is held by another process',
          'busy',
          info,
        );
      }
      if (now >= deadline) {
        throw new FreebuffSessionSlotError(
          'timed out waiting for the Freebuff live-session slot',
          'timeout',
          info,
        );
      }
      announceWait();
      await sleepBounded(Math.min(500, deadline - now));
    }
  };

  return (async () => {
    checkAbort();
    const queue = queues.get(accountId) ?? [];
    if (!queues.has(accountId)) queues.set(accountId, queue);
    const waiter: SlotWaiter = {
      sessionId: request.sessionId,
      role: request.role,
      state: 'queued',
      grant: () => {},
      fail: () => {},
    };
    const held = holders.get(accountId);
    if (held) {
      assertNoDeadlock({
        sessionId: held.sessionId,
        role: held.role,
        startedAt: held.startedAt,
      });
      if (!blocking) {
        throw new FreebuffSessionSlotError(
          'the Freebuff account live-session slot is held by this backend',
          'busy',
          { sessionId: held.sessionId, role: held.role, startedAt: held.startedAt },
        );
      }
    } else if (queue.length === 0) {
      // Free and uncontended: become the attempting head immediately.
      waiter.state = 'attempting';
      queue.push(waiter);
    }
    if (waiter.state === 'queued') {
      if (!blocking) {
        throw new FreebuffSessionSlotError(
          'the Freebuff account live-session slot is contended',
          'busy',
          held
            ? { sessionId: held.sessionId, role: held.role, startedAt: held.startedAt }
            : undefined,
        );
      }
      announceWait();
      const parked = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          fn();
        };
        const onAbort = finish(() => {
          dequeueWaiter(accountId, waiter);
          reject(abortError());
        });
        const timer = setTimeout(
          finish(() => {
            dequeueWaiter(accountId, waiter);
            reject(
              new FreebuffSessionSlotError(
                'timed out waiting for the Freebuff live-session slot',
                'timeout',
              ),
            );
          }),
          Math.max(1, deadline - deps.now()),
        );
        waiter.grant = finish(() => {
          waiter.state = 'attempting';
          resolve();
        });
        waiter.fail = (error: Error) =>
          finish(() => {
            dequeueWaiter(accountId, waiter);
            reject(error);
          })();
        request.signal?.addEventListener('abort', onAbort, { once: true });
        if (request.signal?.aborted) onAbort();
      });
      queue.push(waiter);
      if (queue[0] === waiter && !holders.has(accountId)) grantNextWaiter(accountId);
      await parked;
    }
    try {
      const dir = await takeFileLease();
      holders.set(accountId, {
        sessionId: request.sessionId,
        role: request.role,
        dir,
        startedAt: deps.now(),
      });
      dequeueWaiter(accountId, waiter);
      failQueuedDeadlockedWaiters(accountId, requester);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (holders.get(accountId)?.dir === dir) holders.delete(accountId);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        grantNextWaiter(accountId);
      };
    } catch (error) {
      dequeueWaiter(accountId, waiter);
      // Hand the head-of-line to the next waiter so one failure cannot stall
      // the queue; it re-checks the holder itself.
      grantNextWaiter(accountId);
      throw error;
    }
  })();
}

/** Non-mutating look at a slot's holder for admission checks: the in-process
 * holder wins, else a readable file lease with a live pid. */
export function peekFreebuffSessionSlot(
  accountId: string,
  dependencies: Partial<FreebuffSessionSlotDeps> = {},
): FreebuffSessionSlotHolderInfo | null {
  const deps = { ...defaultDeps(), ...dependencies };
  const held = holders.get(accountId);
  if (held) return { sessionId: held.sessionId, role: held.role, startedAt: held.startedAt };
  const info = readFreebuffSlotInfo(join(slotDirFor(deps, accountId), 'info.json'));
  if (info && freebuffSlotPidAlive(info.pid, deps.kill)) return info;
  return null;
}

/** Test hook: drop every holder (reclaiming its lease dir) and fail any
 * parked waiter. Never call between turns in production. */
export function resetFreebuffSessionSlotsForTests(): void {
  for (const held of holders.values()) {
    try {
      rmSync(held.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  holders.clear();
  for (const queue of queues.values()) {
    for (const waiter of queue) {
      if (waiter.state === 'queued')
        waiter.fail(new Error('Freebuff session slots reset for tests'));
    }
  }
  queues.clear();
}
