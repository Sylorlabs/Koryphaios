/**
 * Frontend dev-server ownership helpers for the native desktop launcher.
 *
 * Two Vite dev servers rooted at the same `frontend/` directory share one
 * `node_modules/.vite` dependency cache. Every process rewrites that cache with
 * its own `browserHash`, and a process that did not write it keeps injecting
 * `?v=<its-own-stale-hash>` into the module specifiers it serves. The WebView
 * then evaluates a *second* copy of `svelte/internal/client`, whose lazily
 * initialized `next_sibling_getter` is never assigned because `init_operations()`
 * only runs during `mount()`. Any template compiled against that second copy
 * throws `undefined is not an object (evaluating 'next_sibling_getter.call')`,
 * which the Notes boundary reports as "The Notes Network hit an unexpected
 * error" because the Notes views are the lazily `import()`ed subtree that is
 * fetched long after boot.
 *
 * So the launcher must own `frontend/` exclusively: reap any stray dev server
 * first, and only fall back to a different port when one refuses to die.
 */

import { spawn } from 'node:child_process';

export type RunningFrontendServer = {
  pid: number;
  port: number | null;
  command: string;
};

export type ReapOutcome = {
  stopped: RunningFrontendServer[];
  survived: RunningFrontendServer[];
};

export type ReapOptions = {
  /** Ports the caller's process tree owns and must never signal. */
  protectedPids?: Iterable<number>;
  graceMs?: number;
  forceMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
  /** Test seam: process liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Test seam: cwd lookup. Returns null when the platform cannot resolve it. */
  resolveCwd?: (pid: number) => Promise<string | null>;
};

const DEFAULT_GRACE_MS = 4_000;
const DEFAULT_FORCE_MS = 2_000;
const DEFAULT_POLL_MS = 100;

/** Normalize Windows separators so command-line matching is platform neutral. */
export function normalizeCommand(command: string): string {
  return command.replace(/\\/g, '/');
}

/**
 * True when `command` is a Vite dev server launched out of this project's
 * frontend workspace. Matching the resolved frontend directory is what keeps the
 * reaper from touching unrelated Vite servers on the machine.
 */
export function isFrontendDevServerCommand(command: string, frontendDir: string): boolean {
  const normalized = normalizeCommand(command);
  const normalizedDir = normalizeCommand(frontendDir).replace(/\/+$/, '');
  if (!normalizedDir || !normalized.includes(normalizedDir)) return false;
  if (!/(^|[\s/])vite(\.js|\.cmd|\.exe)?($|[\s/])/i.test(normalized)) return false;
  return /(^|\s)dev(\s|$)/.test(normalized);
}

/** Extract the `--port` value a stray dev server was started with. */
export function parseFrontendPort(command: string): number | null {
  const match = /--port[=\s]+(\d{1,5})/.exec(normalizeCommand(command));
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * Pick the first listening-free port at or after `preferred`. Callers must not
 * fall back without this check: a different port alone does not isolate the Vite
 * dependency cache, so the surviving server would still clobber it.
 */
export async function selectFreeFrontendPort(
  preferred: number,
  isListening: (port: number) => Promise<boolean>,
  maxAttempts = 50,
): Promise<number | null> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65_535) return null;
    if (!(await isListening(candidate))) return candidate;
  }
  return null;
}

/**
 * Wait for a just-reaped listener to actually release its port. Killing the
 * process is not instantaneous, so probing straight away can wrongly push the
 * launcher onto the fallback port.
 */
export async function waitForPortRelease(
  port: number,
  isListening: (port: number) => Promise<boolean>,
  timeoutMs = 2_000,
  pollMs = DEFAULT_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isListening(port))) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  return !(await isListening(port));
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolvePromise({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Parse `ps -A -o pid= -o command=` output. */
export function parsePsOutput(stdout: string): RunningFrontendServer[] {
  const processes: RunningFrontendServer[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(' ');
    if (separator <= 0) continue;
    const pid = Number(trimmed.slice(0, separator));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const command = trimmed.slice(separator + 1).trim();
    if (!command) continue;
    processes.push({ pid, port: parseFrontendPort(command), command });
  }
  return processes;
}

/** Parse the JSON emitted by the Windows CIM process query. */
export function parseCimOutput(stdout: string): RunningFrontendServer[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(payload) ? payload : [payload];
  const processes: RunningFrontendServer[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId ?? record.processId);
    const command = String(record.CommandLine ?? record.commandLine ?? '');
    if (!Number.isInteger(pid) || pid <= 0 || !command) continue;
    processes.push({ pid, port: parseFrontendPort(command), command });
  }
  return processes;
}

/** Enumerate running processes with their full command lines. */
export async function listProcesses(): Promise<RunningFrontendServer[]> {
  if (process.platform === 'win32') {
    const result = await runCommand('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ]);
    return parseCimOutput(result.stdout);
  }
  const result = await runCommand('ps', ['-A', '-o', 'pid=', '-o', 'command=']);
  return parsePsOutput(result.stdout);
}

/** Resolve a process working directory. Returns null when unavailable. */
export async function readProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const result = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  if (result.code !== 0) return null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim();
  }
  return null;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilDead(
  pid: number,
  isAlive: (pid: number) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  return !isAlive(pid);
}

/**
 * Stop every stray Vite dev server rooted at `frontendDir`.
 *
 * SIGTERM first so Vite can tear down cleanly, then SIGKILL. Anything still
 * alive is reported to the caller, which must then move to a different port
 * rather than share the dependency cache.
 */
export async function reapStrayFrontendServers(
  frontendDir: string,
  options: ReapOptions = {},
): Promise<ReapOutcome> {
  const log = options.log ?? (() => {});
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const forceMs = options.forceMs ?? DEFAULT_FORCE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const resolveCwd = options.resolveCwd ?? readProcessCwd;
  const protectedSet = new Set(options.protectedPids ?? [process.pid]);
  const strays: RunningFrontendServer[] = [];
  for (const candidate of await listProcesses()) {
    if (protectedSet.has(candidate.pid)) continue;
    if (!isFrontendDevServerCommand(candidate.command, frontendDir)) continue;
    const cwd = await resolveCwd(candidate.pid);
    if (cwd && normalizeCommand(cwd).replace(/\/+$/, '') !== normalizeCommand(frontendDir)) {
      continue;
    }
    strays.push(candidate);
  }

  const stopped: RunningFrontendServer[] = [];
  const survived: RunningFrontendServer[] = [];

  for (const stray of strays) {
    log(
      `Stopping stale frontend dev server pid=${stray.pid}${stray.port ? ` (port ${stray.port})` : ''} — a second server rooted at frontend/ would corrupt its dependency cache`,
    );
    try {
      process.kill(stray.pid, 'SIGTERM');
    } catch {
      if (isAlive(stray.pid)) {
        survived.push(stray);
      } else {
        stopped.push(stray);
      }
      continue;
    }
    if (!(await waitUntilDead(stray.pid, isAlive, graceMs, pollMs))) {
      try {
        process.kill(stray.pid, 'SIGKILL');
      } catch {
        // Already gone, or not ours to force.
      }
      if (!(await waitUntilDead(stray.pid, isAlive, forceMs, pollMs))) {
        survived.push(stray);
        continue;
      }
    }
    stopped.push(stray);
  }

  return { stopped, survived };
}
