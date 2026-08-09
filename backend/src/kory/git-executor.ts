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
 *   git process is killed via SIGKILL and the stdout/stderr reads are
 *   aborted via AbortController so the promise resolves promptly.
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

/** Default timeout for git operations (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Milliseconds to wait before retrying on an index.lock conflict. */
const INDEX_LOCK_RETRY_MS = 250;

export interface GitExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Convenience: stdout + stderr trimmed — matches the legacy `{ output }` shape. */
  output: string;
}

export interface GitExecOptions {
  /** Timeout in milliseconds. @default 30000 */
  timeoutMs?: number;
  /** Extra environment variables merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Working directory. Defaults to the executor's `cwd`. */
  cwd?: string;
  /** String to pipe to the process's stdin. */
  stdin?: string;
}

export class GitExecutor {
  constructor(private cwd: string) {}

  /**
   * Run a git command and return a structured result.
   * Acquires `gitMutex`, enforces a timeout, and retries once on index.lock.
   */
  async exec(args: string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const workDir = options.cwd ?? this.cwd;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v !== undefined) env[k] = v;
      }
    }

    const run = (attempt: number): Promise<GitExecResult> =>
      this.runOnce(args, workDir, env, timeoutMs, attempt, options.stdin);

    const result = await run(1);

    // Retry once on index.lock contention.
    if (!result.success && this.isIndexLockError(result.stderr)) {
      koryLog.warn({ args: args.join(' ') }, 'git index.lock contention — retrying once');
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
  async execCombined(args: string[], options: GitExecOptions = {}): Promise<{
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
    stdin?: string,
  ): Promise<GitExecResult> {
    const release = await gitMutex.acquire();
    try {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        env,
        stdin: stdin !== undefined ? 'pipe' : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // AbortController ensures the stdout/stderr readers stop waiting
      // when the timeout fires, so the promise resolves promptly even
      // if the killed process's pipes don't close immediately.
      const abort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        try {
          proc.kill();
        } catch {
          /* process may have already exited */
        }
      }, timeoutMs);

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      try {
        // Write stdin if provided, then close stdin to signal EOF.
        if (stdin !== undefined && proc.stdin) {
          proc.stdin.write(stdin);
          proc.stdin.end();
        }

        // Read stdout/stderr with abort signal so timeout cancels the reads.
        [stdout, stderr] = await Promise.all([
          readStreamText(proc.stdout, abort.signal),
          readStreamText(proc.stderr, abort.signal),
        ]);
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) {
        koryLog.error(
          { args: args.join(' '), timeoutMs, attempt },
          'git command timed out and was killed',
        );
        return {
          success: false,
          exitCode: null,
          stdout,
          stderr: `Command timed out after ${timeoutMs}ms\n${stderr}`,
          output: (stdout + stderr).trim(),
        };
      }

      return {
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        output: (stdout + stderr).trim(),
      };
    } finally {
      release();
    }
  }

  private isIndexLockError(stderr: string): boolean {
    return stderr.includes('index.lock') || stderr.includes('.git/index.lock');
  }
}

/**
 * Read a Bun ReadableStream to completion as text, with optional abort.
 * If the abort signal fires, returns whatever has been read so far instead
 * of hanging indefinitely. The read is raced against the abort signal so
 * a killed process whose stream never closes doesn't block the promise.
 */
async function readStreamText(stream: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
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
          result = await Promise.race([readPromise, abortPromise]) as { done: boolean; value?: Uint8Array };
        } finally {
          // Clean up the abort listener to avoid leaks on long-lived signals.
          if (abortHandler) signal.removeEventListener('abort', abortHandler);
        }
      } else {
        result = await readPromise;
      }
      if (result.done) break;
      if (result.value) chunks.push(result.value);
    }
  } catch {
    // Stream may be broken (e.g. process killed) or aborted — return what we have.
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (chunks.length === 0) return '';
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
