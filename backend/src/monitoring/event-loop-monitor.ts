// Event-loop block detector for Koryphaios backend.
//
// Bun's V8-inspector compatibility layer does NOT implement the Profiler
// domain, and CDP messages are dispatched on the event loop — so neither
// CPU profiling nor Debugger.pause can interrupt a synchronous busy loop.
// The only way to catch the offending JS frame is to know what was running
// *before* the block started. This module provides two signals for that:
//
// 1. A heartbeat timer that logs a tick every `heartbeatIntervalMs`. When
//    the event loop is blocked, ticks stop. The last tick before the gap
//    timestamps the start of the block; the first tick after it resumes
//    reports the total block duration.
// 2. An optional request-level trace that wraps synchronous-heavy operations
//    with before/after log lines, so the file log shows exactly which
//    operation was in progress when the block began.
//
// Combined with the direct file logger (logger.ts), this leaves a postmortem
// even when the launcher process has died and the stdout pipe is broken.

import { serverLog } from '../logger';

const HEARTBEAT_INTERVAL_MS = Number(process.env.KORYPHAIOS_ELOOP_HEARTBEAT_MS ?? 1_000);
const BLOCK_THRESHOLD_MS = Number(process.env.KORYPHAIOS_ELOOP_BLOCK_THRESHOLD_MS ?? 3_000);

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatTime = Date.now();
let monitorStarted = false;

/**
 * Start the event-loop heartbeat monitor. Call once during bootstrap,
 * after the server is listening.
 */
export function startEventLoopMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;

  // Write the PID to a known file so an external watchdog can attach
  // gdb/strace even after the launcher dies and the process is reparented.
  try {
    const { writeFileSync, mkdirSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const { join, resolve } = require('node:path') as typeof import('node:path');
    let root = process.cwd();
    for (let i = 0; i < 4; i++) {
      if (existsSync(join(root, 'koryphaios.json'))) break;
      root = resolve(root, '..');
    }
    const dir = join(root, '.koryphaios');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.backend-pid'), String(process.pid));
  } catch {
    // Best-effort — the external watchdog can still discover the PID via
    // the .active-port.json marker.
  }

  // Allow any same-user process to attach a debugger (gdb/strace) even
  // when kernel.yama.ptrace_scope=1. Without this, the external watchdog
  // cannot capture a native backtrace during a hang.
  try {
    const { dlopen } = require('bun:ffi') as typeof import('bun:ffi');
    const libc = dlopen('libc.so.6', {
      prctl: { args: ['i32', 'i64', 'i64', 'i64', 'i64'], returns: 'i32' },
    });
    // PR_SET_PTRACER = 0x59616d61, PR_SET_PTRACER_ANY = -1
    const rc = libc.symbols.prctl(0x59616d61, -1, 0, 0, 0);
    if (rc === 0) {
      serverLog.info('ptrace permission granted (PR_SET_PTRACER_ANY) — external debugger can attach');
    } else {
      serverLog.warn({ rc }, 'prctl(PR_SET_PTRACER_ANY) returned non-zero — external debugger may not attach');
    }
  } catch {
    // bun:ffi may not be available in all environments. The watchdog can
    // still function without native backtraces — the file logs and heartbeat
    // gaps are the primary diagnostic.
    serverLog.warn('bun:ffi unavailable — external debugger attach may be blocked by ptrace_scope');
  }

  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const drift = now - lastHeartbeatTime - HEARTBEAT_INTERVAL_MS;
    lastHeartbeatTime = now;

    if (drift > BLOCK_THRESHOLD_MS) {
      // The event loop was blocked for `drift` milliseconds. This log line
      // appears AFTER the block unblocks (the timer callback can't fire
      // during the block), but the duration tells us exactly how long the
      // synchronous operation ran.
      serverLog.error(
        { blockDurationMs: drift, thresholdMs: BLOCK_THRESHOLD_MS },
        'EVENT LOOP BLOCK DETECTED — a synchronous operation blocked the event loop',
      );
    } else if (drift > 500) {
      // Minor drift — worth noting but not alarming.
      serverLog.debug({ driftMs: drift }, 'Event loop drift (minor)');
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Don't keep the process alive just for the heartbeat.
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  serverLog.info(
    { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, blockThresholdMs: BLOCK_THRESHOLD_MS },
    'Event-loop monitor started',
  );
}

/**
 * Stop the event-loop monitor (called during graceful shutdown).
 */
export function stopEventLoopMonitor(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  monitorStarted = false;
}

/**
 * Wrap a synchronous or async operation with before/after log lines so the
 * file log shows exactly which operation was in progress if the event loop
 * blocks during its execution.
 *
 * Usage:
 *   const result = await traceSyncOp('getGraphData', () => getGraphData());
 */
export async function traceBlockingOp<T>(
  label: string,
  fn: () => T | Promise<T>,
  options: { logLevel?: 'debug' | 'info' | 'warn' } = {},
): Promise<T> {
  const level = options.logLevel ?? 'debug';
  const start = Date.now();
  serverLog[level]({ op: label }, 'BLOCKING_OP_START');
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    if (elapsed > 500) {
      serverLog.warn({ op: label, elapsedMs: elapsed }, 'BLOCKING_OP_SLOW — operation took longer than expected');
    } else {
      serverLog[level]({ op: label, elapsedMs: elapsed }, 'BLOCKING_OP_END');
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    serverLog.error({ op: label, elapsedMs: elapsed, err }, 'BLOCKING_OP_ERROR');
    throw err;
  }
}
