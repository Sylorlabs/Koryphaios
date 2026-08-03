/**
 * Cross-platform shell resolution.
 *
 * Several backend tools (bash, shell-manager, process-supervisor, bash-sandboxed)
 * spawn shell commands via `['bash', '-c', command]`. On macOS and Linux `bash`
 * is always available. On Windows it is NOT on the default PATH unless the user
 * has installed Git for Windows, WSL, or MSYS2 — spawning `bash` directly fails
 * with ENOENT.
 *
 * This module resolves the best available shell once at startup and exposes it
 * to all callers, so the agent's shell tool works consistently across platforms:
 *
 *   - Unix:  `bash` (falls back to `sh` if bash is somehow missing)
 *   - Windows: `bash.exe` if found on PATH (Git Bash / WSL / MSYS2),
 *     otherwise falls back to `cmd.exe /C` with `isBash = false` so callers
 *     can adjust their command wrapping.
 *
 * Callers that require bash semantics (e.g. bash-sandboxed, which uses bash
 * syntax) should check `shellInfo.isBash` and reject gracefully when false.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ShellInfo {
  /** The shell binary to spawn. */
  command: string;
  /** Arguments to pass before the user's command (e.g. `['-c']` for bash). */
  args: string[];
  /** True when the shell is bash-compatible (supports `-c`, bash syntax). */
  isBash: boolean;
}

let cached: ShellInfo | undefined;

/** Locate an executable on PATH without spawning a process. */
function which(bin: string): string | null {
  const PATH = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the shell for cross-platform command execution. The result is cached
 * for the process lifetime.
 */
export function resolveShell(): ShellInfo {
  if (cached) return cached;

  if (process.platform === 'win32') {
    // Try bash first (Git for Windows, WSL, MSYS2 all put it on PATH).
    const bashPath = which('bash');
    if (bashPath) {
      cached = { command: bashPath, args: ['-c'], isBash: true };
      return cached;
    }
    // No bash — fall back to cmd.exe. Callers that need bash syntax should
    // check isBash and handle the non-bash case.
    cached = { command: 'cmd.exe', args: ['/c'], isBash: false };
    return cached;
  }

  // Unix: prefer bash, fall back to sh.
  const bashPath = which('bash') ?? '/bin/bash';
  if (existsSync(bashPath)) {
    cached = { command: bashPath, args: ['-c'], isBash: true };
    return cached;
  }

  const shPath = which('sh') ?? '/bin/sh';
  cached = { command: shPath, args: ['-c'], isBash: false };
  return cached;
}

/**
 * Require a bash-compatible shell. Throws a clear, actionable error if bash is
 * not available (e.g. stock Windows without Git for Windows). Use this in tools
 * that fundamentally depend on bash syntax.
 */
export function requireBash(): ShellInfo {
  const shell = resolveShell();
  if (!shell.isBash) {
    if (process.platform === 'win32') {
      throw new Error(
        'bash was not found on PATH. The shell tool requires bash. ' +
          'Install Git for Windows (https://git-scm.com/download/win) or WSL, ' +
          'then restart Koryphaios.',
      );
    }
    throw new Error('bash was not found on PATH. Install bash to use the shell tool.');
  }
  return shell;
}
