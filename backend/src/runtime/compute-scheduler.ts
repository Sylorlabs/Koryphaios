/**
 * ComputeScheduler — machine-wide coordination of expensive operations across ALL
 * agents and sessions in this backend process.
 *
 * Every agent shares one set of concurrency pools, so heavy work (builds, tests,
 * installs, typechecks) queues instead of all firing at once and thrashing the
 * machine. Identical in-flight jobs (same command + same directory) are reused, so
 * if two agents ask for the same build the second one piggybacks on the first
 * instead of running it twice.
 *
 * This is a singleton because there is one machine per backend process — global
 * coordination is exactly the point.
 */

import os from 'node:os';
import { serverLog } from '../logger';

export type ResourceClass = 'build' | 'test' | 'install' | 'typecheck' | 'light';

/** A simple FIFO counting semaphore with abort support. */
class Semaphore {
  private active = 0;
  private waiters: Array<{ run: () => void; cancel: (e: unknown) => void }> = [];

  constructor(public readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        // Slot is transferred to us (active count unchanged), so just resolve.
        run: () => resolve(this.makeRelease()),
        cancel: (e: unknown) => reject(e),
      };
      this.waiters.push(waiter);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            const i = this.waiters.indexOf(waiter);
            if (i >= 0) {
              this.waiters.splice(i, 1);
              waiter.cancel(new DOMException('Aborted', 'AbortError'));
            }
          },
          { once: true },
        );
      }
    });
  }

  /** Returns an idempotent release function for one acquisition. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next)
        next.run(); // hand the slot directly to the next waiter; active unchanged
      else this.active--;
    };
  }
}

export interface ComputeRunResult<T> {
  result: T;
  /** ms spent waiting for a free slot before execution started. */
  waitedMs: number;
  /** true when this returned another in-flight job's result instead of running again. */
  shared: boolean;
}

export interface ComputeRunOptions {
  resource: ResourceClass;
  /** Dedupe key — identical concurrent jobs with the same key share one execution. */
  key?: string;
  signal?: AbortSignal;
  /** Called once if the job had to queue behind others (for surfacing "waiting" to the agent). */
  onQueue?: (info: { resource: ResourceClass; ahead: number; running: number }) => void;
}

class ComputeScheduler {
  private pools: Record<ResourceClass, Semaphore>;
  private inflight = new Map<string, Promise<unknown>>();

  constructor() {
    const cores = Math.max(2, os.cpus().length);
    // Conservative limits so a 12-core box never runs 4 big builds at once.
    this.pools = {
      build: new Semaphore(Math.max(1, Math.floor(cores / 6))), // 12 -> 2
      typecheck: new Semaphore(Math.max(1, Math.floor(cores / 4))), // 12 -> 3
      test: new Semaphore(Math.max(1, Math.floor(cores / 4))), // 12 -> 3
      install: new Semaphore(1), // never run installs in parallel (lockfile/cache contention)
      light: new Semaphore(256), // effectively ungated
    };
    serverLog.info(
      {
        cores,
        build: this.pools.build.limit,
        typecheck: this.pools.typecheck.limit,
        test: this.pools.test.limit,
      },
      'ComputeScheduler initialized (machine-wide agent resource pools)',
    );
  }

  /** Classify a shell command into a resource class for pooling. 'light' = ungated. */
  classify(command: string): ResourceClass {
    const c = command.toLowerCase();
    if (/\b(bun|npm|pnpm|yarn)\s+(install|ci|add|i)\b/.test(c)) return 'install';
    // Typecheck before build so `tsc --noEmit` / svelte-check / `bun run check` don't land in 'build'.
    if (/\b(tsc|svelte-check)\b|--noemit|\bcheck\b.*svelte|\brun\s+check\b|\btypecheck\b/.test(c))
      return 'typecheck';
    if (/\b(test|vitest|jest|playwright)\b/.test(c)) return 'test';
    if (
      /\b(build|compile|webpack|rollup|esbuild|tsup|parcel)\b|\bvite\s+build\b|\bnext\s+build\b|\bcargo\s+build\b|\bmake\b|\bcmake\b|\bgradle\b|\bmvn\b/.test(
        c,
      )
    )
      return 'build';
    return 'light';
  }

  /** Snapshot of pool usage — used to make agents aware of shared compute pressure. */
  status(): Record<ResourceClass, { limit: number; active: number; queued: number }> {
    const out = {} as Record<ResourceClass, { limit: number; active: number; queued: number }>;
    for (const k of Object.keys(this.pools) as ResourceClass[]) {
      const p = this.pools[k];
      out[k] = { limit: p.limit, active: p.inUse, queued: p.queued };
    }
    return out;
  }

  async run<T>(opts: ComputeRunOptions, fn: () => Promise<T>): Promise<ComputeRunResult<T>> {
    // Reuse an identical in-flight job (e.g. another agent already building the same thing).
    // NOTE: this check + the registration below run synchronously before the first await,
    // so two concurrent identical calls dedupe correctly (the 2nd sees the 1st's promise).
    if (opts.key && this.inflight.has(opts.key)) {
      const result = (await this.inflight.get(opts.key)!) as T;
      return { result, waitedMs: 0, shared: true };
    }

    // Register a placeholder synchronously so later identical calls share this one.
    let settle!: (v: T) => void;
    let fail!: (e: unknown) => void;
    const jobPromise = new Promise<T>((res, rej) => {
      settle = res;
      fail = rej;
    });
    // Prevent an "unhandled rejection" when this job fails and no other caller shared it.
    void jobPromise.catch((err: unknown) => {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err), resource: opts.resource }, 'Compute scheduler job rejected (unhandled rejection guard)');
    });
    if (opts.key) this.inflight.set(opts.key, jobPromise);

    const pool = this.pools[opts.resource] ?? this.pools.light;
    if (pool.inUse >= pool.limit && opts.onQueue) {
      opts.onQueue({ resource: opts.resource, ahead: pool.queued, running: pool.inUse });
    }

    const startedAt = Date.now();
    let release: (() => void) | undefined;
    try {
      release = await pool.acquire(opts.signal);
      const waitedMs = Date.now() - startedAt;
      const result = await fn();
      settle(result);
      return { result, waitedMs, shared: false };
    } catch (err) {
      fail(err);
      throw err;
    } finally {
      if (opts.key) this.inflight.delete(opts.key);
      release?.();
    }
  }
}

export const computeScheduler = new ComputeScheduler();
