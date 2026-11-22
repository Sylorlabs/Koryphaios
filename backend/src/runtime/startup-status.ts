/**
 * Startup progress marker for a not-yet-listening backend.
 *
 * The desktop shell cannot ask a starting backend what it is doing — the port
 * is not bound yet — so bootstrap records its current phase in a small JSON
 * file the Tauri side can poll. A fresh marker owned by a live pid means
 * "alive and working", which lets the desktop keep waiting through a slow
 * migration or one-time VACUUM instead of declaring the backend down on a
 * fixed deadline.
 *
 * The marker lives next to `.active-port.json` and follows the same rules:
 * atomic writes, private permissions, and removal owned by the writing pid.
 * Every function is best-effort: a marker that cannot be written must never
 * break startup, so failures log at debug and are otherwise ignored.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from './paths';
import { serverLog } from '../logger';

export interface StartupStatus {
  pid: number;
  phase: string;
  detail: string | null;
  /** Epoch ms of the first reportStartupPhase call in this process. */
  startedAt: number;
  /** Epoch ms when the current phase began. */
  phaseStartedAt: number;
  /** Epoch ms of the most recent write. */
  updatedAt: number;
  ready: boolean;
}

const DEFAULT_PATH = join(PROJECT_ROOT, '.koryphaios', '.startup-status.json');
let statusPath = DEFAULT_PATH;
let startedAt: number | null = null;
let phaseStartedAt: number | null = null;

/** Test seam: point the marker at a scratch path (null restores the default). */
export function setStartupStatusPathForTesting(path: string | null): void {
  statusPath = path ?? DEFAULT_PATH;
}

function writeStatus(status: StartupStatus): void {
  try {
    const dir = dirname(statusPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${statusPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
    renameSync(tmp, statusPath);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to write startup status marker',
    );
  }
}

/** Record the startup phase bootstrap is about to enter. */
export function reportStartupPhase(phase: string, detail: string | null = null): void {
  const now = Date.now();
  startedAt ??= now;
  phaseStartedAt = now;
  writeStatus({
    pid: process.pid,
    phase,
    detail: detail ?? null,
    startedAt,
    phaseStartedAt,
    updatedAt: now,
    ready: false,
  });
}

/** The port is bound — health checks take over from the marker. */
export function markStartupReady(): void {
  const now = Date.now();
  startedAt ??= now;
  writeStatus({
    pid: process.pid,
    phase: 'ready',
    detail: null,
    startedAt,
    phaseStartedAt: phaseStartedAt ?? now,
    updatedAt: now,
    ready: true,
  });
}

/** Remove the marker — but never one written by a replacement backend. */
export function clearStartupStatus(): void {
  try {
    if (!existsSync(statusPath)) return;
    const parsed = JSON.parse(readFileSync(statusPath, 'utf-8')) as { pid?: number };
    if (parsed.pid === process.pid) rmSync(statusPath, { force: true });
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to clear startup status marker',
    );
  }
}
