/**
 * GitExecutor — the single way to run git in the Koryphaios backend.
 *
 * Every git subprocess in the codebase goes through this class. It enforces:
 *
 * - **Async-only**: no `spawnSync` anywhere. The event loop is never blocked.
 * - **Mutex-internal**: callers cannot forget the `gitMutex`. Every call
 *   acquires it automatically, so concurrent consumers (GitManager,
 *   WorkspaceManager, CheckpointStore) are serialized at the git level.
 *
 *   Known limitation: the mutex is a single global lock, not per-repo. This is
 *   fine for the current single-repo architecture. If multi-repo support is
 *   added, the mutex should be keyed by repo path to allow parallelism across
 *   repos while still serializing within a single repo's .git directory.
 *
 * - **Timeout**: every call has a configurable deadline (default 30s). A hung
 *   git process group receives SIGTERM, then SIGKILL after a bounded grace
 *   period. stdout/stderr reads and the final exit wait are independently
 *   bounded so descendants holding pipes open cannot retain the mutex.
 * - **Structured results**: `stdout` and `stderr` are returned separately, not
 *   concatenated. Callers that need the old `{ output }` shape can use
 *   `execCombined()`, but new code should read `stdout`/`stderr` directly.
 * - **Index-lock retry**: if git exits with an `index.lock` error, the executor
 *   waits briefly and retries once before surfacing the failure.
 * - **Stdin support**: pass `stdin` in options to pipe content to the process.
 *   Used by `hash-object --stdin` etc. so callers don't need temp files.
 */

import { gitMutex } from './git-mutex';
import { koryLog } from '../logger';
import { getSafeSubprocessEnv } from '../runtime/safe-env';

/** Default timeout for git operations (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Milliseconds to wait before retrying on an index.lock conflict. */
const INDEX_LOCK_RETRY_MS = 250;
/** Grace period after SIGTERM before a timed-out process group is force-killed. */
const TERM_GRACE_MS = 250;
/** Final bounded wait after SIGKILL. The mutex is released even if Bun never reaps. */
const KILL_GRACE_MS = 500;
/** Bounded opportunity for aborted stdout/stderr readers to return partial output. */
const STREAM_ABORT_GRACE_MS = 100;
/** Hard ceilings protect the backend from repository-controlled hooks/helpers
 *  that write indefinitely. Per-call limits may be stricter, never larger. */
export const GIT_STDOUT_HARD_LIMIT_BYTES = 16 * 1024 * 1024;
export const GIT_STDERR_HARD_LIMIT_BYTES = 4 * 1024 * 1024;

export interface GitExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Convenience: stdout + stderr trimmed — matches the legacy `{ output }` shape. */
  output: string;
  /** True when either stream exceeded its hard/per-call safety ceiling. In
   *  that case captured stream content is discarded and `success` is false. */
  outputLimitExceeded: boolean;
  /** Bytes observed while fully draining the streams (or before timeout abort). */
  stdoutBytes: number;
  stderrBytes: number;
}

export interface GitExecOptions {
  /** Timeout in milliseconds. @default 30000 */
  timeoutMs?: number;
  /** Explicit non-secret environment variables merged on top of the safe allowlist. */
  env?: Record<string, string>;
  /** Working directory. Defaults to the executor's `cwd`. */
  cwd?: string;
  /** String to pipe to the process's stdin. */
  stdin?: string;
  /** Optional stricter stdout ceiling. Values above the hard ceiling are clamped. */
  maxStdoutBytes?: number;
  /** Optional stricter stderr ceiling. Values above the hard ceiling are clamped. */
  maxStderrBytes?: number;
}

export class GitExecutor {
  /**
   * @param cwd Working directory for git commands.
   * @param baseEnv Environment variables injected into every command (e.g.
   *   `{ GIT_DIR, GIT_WORK_TREE }` for a shadow repo). Merged into the safe
   *   subprocess allowlist before per-call `options.env`, so per-call
   *   overrides win without inheriting backend/provider credentials.
   */
  constructor(
    private cwd: string,
    private baseEnv: Record<string, string> = {},
  ) {}

  /**
   * Run a git command and return a structured result.
   * Acquires `gitMutex`, enforces a timeout, and retries once on index.lock.
   */
  async exec(args: string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const workDir = options.cwd ?? this.cwd;
    const maxStdoutBytes = normalizeOutputLimit(
      options.maxStdoutBytes,
      GIT_STDOUT_HARD_LIMIT_BYTES,
    );
    const maxStderrBytes = normalizeOutputLimit(
      options.maxStderrBytes,
      GIT_STDERR_HARD_LIMIT_BYTES,
    );
    // Git can execute repository-configured helpers and hooks. Give those
    // descendants only the safe subprocess allowlist plus the explicit,
    // non-secret Git routing variables required by this operation.
    const env = getSafeSubprocessEnv({ ...this.baseEnv, ...(options.env ?? {}) });

    const run = (attempt: number): Promise<GitExecResult> =>
      this.runOnce(
        args,
        workDir,
        env,
        timeoutMs,
        attempt,
        maxStdoutBytes,
        maxStderrBytes,
        options.stdin,
      );

    const result = await run(1);

    // Retry once on index.lock contention.
    if (!result.success && result.exitCode !== null && this.isIndexLockError(result.stderr)) {
      koryLog.warn(gitCommandLogMetadata(args), 'git index.lock contention — retrying once');
      await sleep(INDEX_LOCK_RETRY_MS);
      return run(2);
    }

    return result;
  }

  /**
   * Convenience wrapper that returns the legacy `{ success, output }` shape
   * where `output` is `stdout + stderr` trimmed. Use for incremental migration;
   * new code should call `exec()` and read `stdout`/`stderr` directly.
   */
  async execCombined(
    args: string[],
    options: GitExecOptions = {},
  ): Promise<{
    success: boolean;
    output: string;
  }> {
    const r = await this.exec(args, options);
    return { success: r.success, output: r.output };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async runOnce(
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    attempt: number,
    maxStdoutBytes: number,
    maxStderrBytes: number,
    stdin?: string,
  ): Promise<GitExecResult> {
    const release = await gitMutex.acquire();
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        env,
        // A dedicated process group lets timeout cleanup reach Git hooks,
        // credential helpers, transports, and other descendants that may keep
        // inherited stdout/stderr pipes open after the direct process exits.
        detached: true,
        stdin: stdin !== undefined ? 'pipe' : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Stream reads, process exit, and the deadline run concurrently. Waiting
      // for either stream before racing the deadline would let a descendant
      // pipe holder strand the global mutex.
      const abort = new AbortController();
      const stdoutPromise = readStreamText(proc.stdout, maxStdoutBytes, abort.signal);
      const stderrPromise = readStreamText(proc.stderr, maxStderrBytes, abort.signal);
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        // Write stdin if provided, then close stdin to signal EOF.
        if (stdin !== undefined && proc.stdin) {
          proc.stdin.write(stdin);
          proc.stdin.end();
        }

        const completed = Promise.all([proc.exited, stdoutPromise, stderrPromise]).then(
          ([exitCode, stdout, stderr]) => ({
            kind: 'completed' as const,
            exitCode,
            stdout,
            stderr,
          }),
        );
        const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
        });
        const outcome = await Promise.race([completed, deadline]);

        if (outcome.kind === 'completed') {
          const outputFailure = this.outputSafetyFailure(
            args,
            attempt,
            outcome.exitCode,
            outcome.stdout,
            outcome.stderr,
            maxStdoutBytes,
            maxStderrBytes,
          );
          if (outputFailure) return outputFailure;
          return {
            success: outcome.exitCode === 0,
            exitCode: outcome.exitCode,
            stdout: outcome.stdout.text,
            stderr: outcome.stderr.text,
            output: (outcome.stdout.text + outcome.stderr.text).trim(),
            outputLimitExceeded: false,
            stdoutBytes: outcome.stdout.totalBytes,
            stderrBytes: outcome.stderr.totalBytes,
          };
        }

        abort.abort();
        const termination = await terminateProcessTree(proc);
        const [stdout, stderr] = await Promise.all([
          settleStreamWithin(stdoutPromise, STREAM_ABORT_GRACE_MS),
          settleStreamWithin(stderrPromise, STREAM_ABORT_GRACE_MS),
        ]);
        const escalation = termination.escalatedToKill ? ' and escalated to SIGKILL' : '';
        const cleanupWarning = termination.stopped
          ? ''
          : '; process-tree exit could not be confirmed before cleanup deadline';
        const timeoutMessage = `Command timed out after ${timeoutMs}ms; sent SIGTERM${escalation}${cleanupWarning}.`;
        const outputFailure = this.outputSafetyFailure(
          args,
          attempt,
          null,
          stdout,
          stderr,
          maxStdoutBytes,
          maxStderrBytes,
          timeoutMessage,
        );

        koryLog.error(
          {
            ...gitCommandLogMetadata(args),
            timeoutMs,
            attempt,
            escalatedToKill: termination.escalatedToKill,
            processTreeStopped: termination.stopped,
          },
          'git command timed out and was terminated',
        );

        if (outputFailure) return outputFailure;
        const timeoutStderr = appendLine(stderr.text, timeoutMessage);

        return {
          success: false,
          exitCode: null,
          stdout: stdout.text,
          stderr: timeoutStderr,
          output: (stdout.text + timeoutStderr).trim(),
          outputLimitExceeded: false,
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      release();
    }
  }

  private isIndexLockError(stderr: string): boolean {
    return stderr.includes('index.lock') || stderr.includes('.git/index.lock');
  }

  private outputSafetyFailure(
    args: string[],
    attempt: number,
    exitCode: number | null,
    stdout: BoundedStreamText,
    stderr: BoundedStreamText,
    maxStdoutBytes: number,
    maxStderrBytes: number,
    additionalMessage?: string,
  ): GitExecResult | null {
    if (!stdout.truncated && !stderr.truncated && !stdout.readFailed && !stderr.readFailed) {
      return null;
    }
    const messages: string[] = [];
    if (stdout.truncated) {
      messages.push(
        `Git stdout exceeded the ${maxStdoutBytes}-byte safety limit (observed ${stdout.totalBytes} bytes); captured output was discarded.`,
      );
    }
    if (stderr.truncated) {
      messages.push(
        `Git stderr exceeded the ${maxStderrBytes}-byte safety limit (observed ${stderr.totalBytes} bytes); captured output was discarded.`,
      );
    }
    if (stdout.readFailed) {
      messages.push('Git stdout could not be read completely; captured output was discarded.');
    }
    if (stderr.readFailed) {
      messages.push('Git stderr could not be read completely; captured output was discarded.');
    }
    if (additionalMessage) messages.push(additionalMessage);
    const output = messages.join('\n');
    koryLog.error(
      {
        ...gitCommandLogMetadata(args),
        attempt,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        maxStdoutBytes,
        maxStderrBytes,
        stdoutReadFailed: stdout.readFailed,
        stderrReadFailed: stderr.readFailed,
      },
      stdout.truncated || stderr.truncated
        ? 'git command output exceeded the safety limit'
        : 'git command output could not be read completely',
    );
    return {
      success: false,
      exitCode,
      stdout: '',
      stderr: output,
      output,
      outputLimitExceeded: stdout.truncated || stderr.truncated,
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
    };
  }
}

interface TerminationResult {
  escalatedToKill: boolean;
  stopped: boolean;
}

/**
 * Terminate the whole detached Git process group on POSIX. On Windows Bun's
 * direct-process kill is the safest available fallback. Every wait is bounded:
 * cleanup must never keep the global git mutex past the timeout grace window.
 */
async function terminateProcessTree(proc: Bun.Subprocess): Promise<TerminationResult> {
  signalProcessTree(proc, 'SIGTERM');
  if (await waitForProcessTreeExit(proc, TERM_GRACE_MS)) {
    return { escalatedToKill: false, stopped: true };
  }

  signalProcessTree(proc, 'SIGKILL');
  const stopped = await waitForProcessTreeExit(proc, KILL_GRACE_MS);
  if (!stopped) {
    // Do not let an anomalous Bun/OS reap failure keep the backend alive or the
    // mutex held after both signals and both bounded waits have been exhausted.
    try {
      proc.unref();
    } catch {
      /* process may already have been reaped */
    }
  }
  return { escalatedToKill: true, stopped };
}

function signalProcessTree(proc: Bun.Subprocess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && proc.pid > 0) {
    try {
      // `detached: true` makes the child a process-group leader on POSIX.
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The group may already be gone or unsupported. Fall back to the direct
      // Bun subprocess handle so a still-running Git process is not skipped.
    }
  }

  try {
    proc.kill(signal);
  } catch {
    /* process may already have exited */
  }
}

async function waitForProcessTreeExit(proc: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeAlive(proc)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(10, remaining));
  }
  return true;
}

function isProcessTreeAlive(proc: Bun.Subprocess): boolean {
  if (process.platform !== 'win32' && proc.pid > 0) {
    try {
      process.kill(-proc.pid, 0);
      return true;
    } catch (error) {
      // EPERM means the group exists but is owned by another user.
      if (isNodeError(error) && error.code === 'EPERM') return true;
      return false;
    }
  }
  return proc.exitCode === null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

interface BoundedStreamText {
  text: string;
  totalBytes: number;
  truncated: boolean;
  readFailed: boolean;
}

const EMPTY_STREAM_TEXT: BoundedStreamText = {
  text: '',
  totalBytes: 0,
  truncated: false,
  readFailed: false,
};

/** Keep operational logs useful without ever serializing repository-controlled
 * arguments such as commit messages, paths, remote URLs, or ref transactions. */
function gitCommandLogMetadata(args: string[]): { command: string; argumentCount: number } {
  const candidate = args[0] ?? '';
  const command = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(candidate) ? candidate : '[unknown]';
  return { command, argumentCount: Math.max(0, args.length - 1) };
}

function normalizeOutputLimit(requested: number | undefined, hardLimit: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return hardLimit;
  return Math.min(hardLimit, Math.max(1, Math.floor(requested)));
}

async function settleStreamWithin(
  promise: Promise<BoundedStreamText>,
  timeoutMs: number,
): Promise<BoundedStreamText> {
  return Promise.race([promise, sleep(timeoutMs).then(() => EMPTY_STREAM_TEXT)]);
}

function appendLine(existing: string, line: string): string {
  if (!existing) return line;
  return `${existing.replace(/\n?$/, '\n')}${line}`;
}

/**
 * Read a Bun ReadableStream to completion as text, with optional abort.
 * If the abort signal fires, returns whatever has been read so far instead
 * of hanging indefinitely. The read is raced against the abort signal so
 * a killed process whose stream never closes doesn't block the promise.
 */
async function readStreamText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedStreamText> {
  if (!stream) return EMPTY_STREAM_TEXT;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let readFailed = false;
  try {
    while (true) {
      if (signal?.aborted) break;
      // Race the read against the abort signal so a killed process
      // whose stream never closes doesn't block the promise forever.
      const readPromise = reader.read();
      let result: { done: boolean; value?: Uint8Array };
      if (signal) {
        // Create a reusable abort promise that we can clean up.
        let abortHandler: (() => void) | null = null;
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          abortHandler = () => reject(new Error('aborted'));
          signal.addEventListener('abort', abortHandler, { once: true });
        });
        try {
          result = (await Promise.race([readPromise, abortPromise])) as {
            done: boolean;
            value?: Uint8Array;
          };
        } finally {
          // Clean up the abort listener to avoid leaks on long-lived signals.
          if (abortHandler) signal.removeEventListener('abort', abortHandler);
        }
      } else {
        result = await readPromise;
      }
      if (result.done) break;
      if (result.value) {
        totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + result.value.byteLength);
        const remaining = Math.max(0, maxBytes - capturedBytes);
        if (remaining > 0) {
          // Copy only the bounded prefix. A subarray would retain the helper's
          // potentially huge backing buffer until the command settles.
          const captured = result.value.slice(0, remaining);
          chunks.push(captured);
          capturedBytes += captured.byteLength;
        }
        if (result.value.byteLength > remaining) truncated = true;
      }
    }
  } catch {
    // Stream may be broken (e.g. process killed) or aborted — return what we have.
    // Cancel an aborted reader as well as abandoning its read promise so the
    // underlying pipe cannot keep the backend event loop alive.
    if (signal?.aborted) {
      try {
        await Promise.race([reader.cancel('git command timed out'), sleep(STREAM_ABORT_GRACE_MS)]);
      } catch {
        /* stream may already be closed */
      }
    } else {
      // A process may still exit zero after a pipe/decoder failure. Mark the
      // capture incomplete so callers never parse partial structured Git data.
      readFailed = true;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  if (chunks.length === 0) return { text: '', totalBytes, truncated, readFailed };
  const merged = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), totalBytes, truncated, readFailed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
