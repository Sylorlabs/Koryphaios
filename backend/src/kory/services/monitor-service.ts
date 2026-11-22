/**
 * Durable recurring monitors.
 *
 * A monitor is a host-owned timer attached to one chat. When it fires, the host
 * submits a normal session turn through `startSessionTurn`, so the wake-up has
 * the same transcript, admission, and cancellation semantics as any other
 * internal turn. If the chat is busy the monitor stays pending and retries;
 * `runCount` only advances once a turn is accepted, which keeps the durable
 * command id stable across a crash.
 *
 * Definitions live in one app-data JSON file so a restart re-arms them instead
 * of silently losing long-running checks.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serverLog } from '../../logger';
import type { KoryManager } from '../manager';
import type { SessionStore } from '../../stores/session-store';

export interface SessionMonitor {
  id: string;
  sessionId: string;
  workingDirectory: string;
  prompt: string;
  intervalMs: number;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  runCount: number;
  status: 'active' | 'cancelled';
}

export interface CreateMonitorInput {
  sessionId: string;
  workingDirectory: string;
  prompt: string;
  intervalMs: number;
}

interface MonitorFile {
  version: 1;
  monitors: SessionMonitor[];
}

interface MonitorConfig {
  kory: KoryManager;
  sessions: SessionStore;
  storagePath: string;
}

const FILE_VERSION = 1;
const MAX_PROMPT_LENGTH = 8_000;
/** A busy chat retries soon without changing the monitor's cadence. */
const BUSY_RETRY_MS = 15_000;
/** Floor that keeps a typo from creating a timer that spins the event loop. */
const MIN_INTERVAL_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

let config: MonitorConfig | null = null;
let monitors = new Map<string, SessionMonitor>();
let timer: ReturnType<typeof setTimeout> | null = null;
let firing = new Set<string>();
let writeChain: Promise<void> = Promise.resolve();

function activeMonitors(): SessionMonitor[] {
  return [...monitors.values()].filter((monitor) => monitor.status === 'active');
}

function persist(): Promise<void> {
  const target = config?.storagePath;
  if (!target) return Promise.resolve();
  const snapshot: MonitorFile = {
    version: FILE_VERSION,
    monitors: [...monitors.values()],
  };
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(target), { recursive: true });
      const tmpPath = `${target}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      await rename(tmpPath, target);
    })
    .catch((error: unknown) => {
      serverLog.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to persist monitor definitions',
      );
    });
  return writeChain;
}

function arm(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!config) return;
  const active = activeMonitors();
  if (active.length === 0) return;
  const nextRunAt = Math.min(...active.map((monitor) => monitor.nextRunAt));
  const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, nextRunAt - Date.now()));
  timer = setTimeout(() => {
    void runDueMonitors();
  }, delay);
  (timer as { unref?: () => void }).unref?.();
}

export function renderMonitorPrompt(monitor: SessionMonitor): string {
  return [
    `[Scheduled monitor ${monitor.id}]`,
    monitor.prompt,
    '',
    'This turn was scheduled by you earlier, not sent by the user. Check the condition and take only the action the monitor calls for. Keep the reply brief. Cancel the monitor with schedule_monitor action "cancel" when it is no longer needed.',
  ].join('\n');
}

async function fire(monitor: SessionMonitor): Promise<void> {
  if (!config || firing.has(monitor.id) || monitor.status !== 'active') return;
  firing.add(monitor.id);
  try {
    const session = await config.sessions.getActive(monitor.sessionId);
    if (!session) {
      monitor.status = 'cancelled';
      await persist();
      serverLog.info(
        { monitorId: monitor.id, sessionId: monitor.sessionId },
        'Cancelled monitor because its session is no longer active',
      );
      return;
    }

    const submission = await config.kory.startSessionTurn({
      sessionId: monitor.sessionId,
      source: 'internal',
      // Stable across retries: an accepted turn that crashes before this file is
      // updated is replayed idempotently rather than duplicated.
      sourceCommandId: `monitor-${monitor.id}-${monitor.runCount + 1}`,
      userMessage: renderMonitorPrompt(monitor),
    });

    if (submission.accepted !== true) {
      monitor.nextRunAt = Date.now() + BUSY_RETRY_MS;
      await persist();
      return;
    }

    void submission.completion.catch((error: unknown) => {
      serverLog.warn(
        {
          monitorId: monitor.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Scheduled monitor turn failed',
      );
    });

    const firedAt = Date.now();
    monitor.lastRunAt = firedAt;
    monitor.runCount += 1;
    monitor.nextRunAt = firedAt + monitor.intervalMs;
    await persist();
  } catch (error: unknown) {
    serverLog.warn(
      {
        monitorId: monitor.id,
        err: error instanceof Error ? error.message : String(error),
      },
      'Scheduled monitor could not start its turn; will retry',
    );
    monitor.nextRunAt = Date.now() + BUSY_RETRY_MS;
    await persist();
  } finally {
    firing.delete(monitor.id);
  }
}

export async function runDueMonitorsNow(): Promise<void> {
  await runDueMonitors();
}

async function runDueMonitors(): Promise<void> {
  timer = null;
  if (!config) return;
  const now = Date.now();
  const due = activeMonitors().filter((monitor) => monitor.nextRunAt <= now);
  await Promise.allSettled(due.map((monitor) => fire(monitor)));
  arm();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMonitor(value: unknown): SessionMonitor | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt : '';
  const intervalMs = typeof value.intervalMs === 'number' ? value.intervalMs : 0;
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0;
  const nextRunAt = typeof value.nextRunAt === 'number' ? value.nextRunAt : 0;
  const runCount = typeof value.runCount === 'number' ? value.runCount : 0;
  const status = value.status === 'cancelled' ? 'cancelled' : 'active';
  if (
    !id.startsWith('mon-') ||
    !sessionId ||
    !prompt.trim() ||
    prompt.length > MAX_PROMPT_LENGTH ||
    !Number.isFinite(intervalMs) ||
    intervalMs < MIN_INTERVAL_MS ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(nextRunAt) ||
    !Number.isFinite(runCount)
  ) {
    return null;
  }
  return {
    id,
    sessionId,
    workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : '',
    prompt,
    intervalMs,
    createdAt,
    nextRunAt,
    ...(typeof value.lastRunAt === 'number' ? { lastRunAt: value.lastRunAt } : {}),
    runCount,
    status,
  };
}

async function load(): Promise<void> {
  const target = config?.storagePath;
  if (!target) return;
  try {
    const raw = await readFile(target, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.monitors)) return;
    for (const value of parsed.monitors) {
      const monitor = parseMonitor(value);
      if (monitor) monitors.set(monitor.id, monitor);
    }
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    if (code !== 'ENOENT') {
      serverLog.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Could not load monitor definitions; starting with none',
      );
    }
  }
}

/** Wire the runtime dependencies and re-arm persisted monitors. */
export async function configureMonitors(next: MonitorConfig): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  monitors = new Map();
  firing = new Set();
  writeChain = Promise.resolve();
  config = next;
  await load();
  arm();
}

/** Stop timers without deleting persisted definitions (tests, shutdown). */
export function disposeMonitors(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  config = null;
  monitors.clear();
  firing.clear();
}

export async function createMonitor(input: CreateMonitorInput): Promise<SessionMonitor> {
  if (!config) throw new Error('Monitors are not configured');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('A monitor prompt is required');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`A monitor prompt cannot exceed ${MAX_PROMPT_LENGTH} characters`);
  }
  if (!Number.isFinite(input.intervalMs) || input.intervalMs < MIN_INTERVAL_MS) {
    throw new Error('A monitor interval must be at least one second');
  }
  const now = Date.now();
  const monitor: SessionMonitor = {
    id: `mon-${randomUUID()}`,
    sessionId: input.sessionId,
    workingDirectory: input.workingDirectory,
    prompt,
    intervalMs: Math.round(input.intervalMs),
    createdAt: now,
    nextRunAt: now + Math.round(input.intervalMs),
    runCount: 0,
    status: 'active',
  };
  monitors.set(monitor.id, monitor);
  await persist();
  arm();
  return monitor;
}

export function listMonitors(sessionId: string, includeCancelled = false): SessionMonitor[] {
  return [...monitors.values()]
    .filter(
      (monitor) =>
        monitor.sessionId === sessionId && (includeCancelled || monitor.status === 'active'),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getMonitor(id: string): SessionMonitor | undefined {
  return monitors.get(id);
}

/** Cancel a monitor owned by `sessionId`; a foreign id is never touched. */
export async function cancelMonitor(
  id: string,
  sessionId?: string,
): Promise<SessionMonitor | null> {
  const monitor = monitors.get(id);
  if (!monitor || (sessionId && monitor.sessionId !== sessionId)) return null;
  monitor.status = 'cancelled';
  await persist();
  arm();
  return monitor;
}
