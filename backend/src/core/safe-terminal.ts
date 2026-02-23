/**
 * SafeTerminal — Wraps Bun.spawn / child process calls to prevent shell deadlocks.
 * Ensures stdout/stderr are fully consumed and process is killed on timeout.
 */

import type { Subprocess } from "bun";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface SafeTerminalOptions {
  /** Timeout in ms; process is killed after this. */
  timeoutMs?: number;
  /** Max bytes to read from stdout (prevents unbounded memory). */
  maxStdoutBytes?: number;
  /** Max bytes to read from stderr. */
  maxStderrBytes?: number;
}

export interface SafeTerminalResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a command with timeout and stream draining to prevent Bun shell deadlocks.
 * Uses Bun.spawn with piped stdout/stderr and Promise.race with a timeout.
 */
export async function runSafe(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
  } = {}
): Promise<SafeTerminalResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? 2 * 1024 * 1024; // 2MB
  const maxStderrBytes = options.maxStderrBytes ?? 512 * 1024; // 512KB

  const start = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutPromise = new Promise<SafeTerminalResult>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      resolve({
        stdout: "",
        stderr: "Process timed out and was killed.",
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
  });

  const runPromise = (async (): Promise<SafeTerminalResult> => {
    const decoder = new TextDecoder();
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      chunks: Uint8Array[],
      maxBytes: number,
      lenRef: { current: number }
    ) => {
      const reader = stream.getReader();
      try {
        while (lenRef.current < maxBytes) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          lenRef.current += value.length;
        }
      } finally {
        reader.releaseLock();
      }
    };

    const stdoutRef = { current: 0 };
    const stderrRef = { current: 0 };
    await Promise.all([
      readStream(proc.stdout!, stdoutChunks, maxStdoutBytes, stdoutRef),
      readStream(proc.stderr!, stderrChunks, maxStderrBytes, stderrRef),
    ]);

    const exitCode = await proc.exited;
    const stdout = decoder.decode(Buffer.concat(stdoutChunks));
    const stderr = decoder.decode(Buffer.concat(stderrChunks));

    return {
      stdout,
      stderr,
      exitCode,
      timedOut: false,
      durationMs: Date.now() - start,
    };
  })();

  return Promise.race([runPromise, timeoutPromise]);
}
