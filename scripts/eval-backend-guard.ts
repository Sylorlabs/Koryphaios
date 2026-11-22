/**
 * Evidence runs must talk to a packaged backend, never a file watcher.
 *
 * `bun run --filter backend dev` is `bun --watch src/server.ts`. Any edit under
 * `backend/src` (another agent's, or the operator's) restarts the process, and a
 * restart during a turn kills the session mid stream. The subject then returns an
 * empty answer and the arm looks like a candidate failure: measured twice while
 * repairing `svelte-engineering`, where the arm "changed only usage.json" and the
 * score said the skill had delivered nothing.
 *
 * A watcher can also wedge: under a heavy catalog refresh tick the event loop stops
 * answering `/api/health` for minutes, which produces timeouts that are not the
 * subject's fault either.
 *
 * So the campaign asks the backend which executable is serving it, and refuses to
 * spend provider calls when the answer is a source entry point. The packaged bundle
 * keeps the same data directory, credentials and config, so nothing about the
 * measurement changes except the restarts.
 */
import { execFileSync } from 'node:child_process';

export type EvalBackendIdentity = {
  ok: boolean;
  pid: number | null;
  command: string | null;
  packaged: boolean;
  detail: string;
};

const WATCHER_PATTERNS = [
  /(^|\s)--watch(\s|$)/u,
  /(^|\/)src\/server\.ts(\s|$)/u,
  /(^|\/)src\/index\.ts(\s|$)/u,
];

function commandForPid(pid: number): string | null {
  try {
    const raw = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const command = raw.trim();
    return command || null;
  } catch {
    return null;
  }
}

export async function inspectEvalBackend(
  baseUrl = `http://127.0.0.1:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`,
): Promise<EvalBackendIdentity> {
  let payload: { pid?: number; version?: string; data?: { pid?: number } } = {};
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        pid: null,
        command: null,
        packaged: false,
        detail: `Kory backend is not healthy at ${baseUrl} (HTTP ${response.status}).`,
      };
    }
    payload = (await response.json()) as typeof payload;
  } catch {
    return {
      ok: false,
      pid: null,
      command: null,
      packaged: false,
      detail: `Kory backend is not reachable at ${baseUrl}.`,
    };
  }
  const pid = payload.pid ?? payload.data?.pid ?? null;
  if (!pid) {
    return { ok: true, pid: null, command: null, packaged: true, detail: 'Backend reported no pid.' };
  }
  const command = commandForPid(pid);
  if (!command) {
    // No process table access: do not invent a verdict about the executable.
    return { ok: true, pid, command: null, packaged: true, detail: 'Process command unavailable.' };
  }
  const watcher = WATCHER_PATTERNS.some((pattern) => pattern.test(command));
  return {
    ok: !watcher,
    pid,
    command,
    packaged: !watcher,
    detail: watcher
      ? `The backend on ${baseUrl} is a source watcher (${command}). A restart mid turn truncates the arm and scores it as a candidate failure. Start the packaged backend instead: bun run eval:backend`
      : `Packaged backend confirmed (${command}).`,
  };
}

/** Throw unless the backend serving evidence is the packaged bundle. */
export async function assertPackagedEvalBackend(
  baseUrl?: string,
): Promise<EvalBackendIdentity> {
  const identity = await inspectEvalBackend(baseUrl);
  if (!identity.ok) throw new Error(identity.detail);
  return identity;
}
