// Login-shell environment hydration.
//
// The packaged desktop background service is spawned with the manifest's
// environment, not the user's interactive shell, so API keys exported in
// ~/.zshrc / ~/.bashrc never reach this process. Probing the login shell once —
// the same approach desktop/src-tauri uses for the service PATH — lets
// autoDetectProviders see those exports without ever writing them to disk.
//
// Output is emitted between unique markers because interactive rc files can
// print arbitrary noise; stdin and stderr stay detached so a prompting or
// chatty rc file cannot hang or pollute the probe. Only allowlisted variable
// names are adopted, and values are never logged.

import { spawn, type ChildProcess } from 'node:child_process';
import { serverLog } from '../logger';
import { isMac, isUnix } from './platform';
import { isProviderAutodetectDisabled } from '../providers/provider-autodetect';

const ENV_MARKER_BEGIN = '__KORY_ENV_BEGIN_7C1E__';
const ENV_MARKER_END = '__KORY_ENV_END_7C1E__';
const LOGIN_SHELL_ENV_TIMEOUT_MS = 3_000;

/**
 * Extract allowlisted NAME=VALUE pairs from `env -0` output captured between
 * the markers. rc noise outside the markers is ignored; a value containing a
 * line break is rejected because it could smuggle extra assignments or
 * terminal escapes into anything that later re-prints the environment.
 */
export function parseMarkedEnv(
  stdout: string,
  allowlist: ReadonlySet<string>,
): Record<string, string> {
  const begin = stdout.indexOf(ENV_MARKER_BEGIN);
  if (begin === -1) return {};
  const bodyStart = begin + ENV_MARKER_BEGIN.length;
  const end = stdout.indexOf(ENV_MARKER_END, bodyStart);
  if (end === -1) return {};
  const parsed: Record<string, string> = {};
  for (const entry of stdout.slice(bodyStart, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (!allowlist.has(name)) continue;
    const value = entry.slice(eq + 1);
    if (!value || /[\n\r]/.test(value)) continue;
    parsed[name] = value;
  }
  return parsed;
}

function collectLoginShellEnv(shell: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        shell,
        ['-ilc', `printf '%s' ${ENV_MARKER_BEGIN}; env -0; printf '%s' ${ENV_MARKER_END}`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, LOGIN_SHELL_ENV_TIMEOUT_MS);
    const done = (value: string | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? stdout : null));
  });
}

let hydration: Promise<string[]> | null = null;

/**
 * Copy allowlisted provider env vars out of the user's login shell into this
 * process — once per process, names not already set win nothing. Returns the
 * names that were adopted. A no-op off Unix, under tests, and when provider
 * autodetection is disabled.
 */
export function hydrateProviderEnvFromLoginShell(names: Iterable<string>): Promise<string[]> {
  if (!isUnix()) return Promise.resolve([]);
  if (process.env.NODE_ENV === 'test' || isProviderAutodetectDisabled()) {
    return Promise.resolve([]);
  }
  hydration ??= (async () => {
    const allowlist = new Set(names);
    if (allowlist.size === 0) return [];
    const shell = process.env.SHELL?.trim() || (isMac() ? '/bin/zsh' : '/bin/bash');
    const stdout = await collectLoginShellEnv(shell);
    if (!stdout) return [];
    const adopted: string[] = [];
    for (const [name, value] of Object.entries(parseMarkedEnv(stdout, allowlist))) {
      if (process.env[name]) continue;
      process.env[name] = value;
      adopted.push(name);
    }
    if (adopted.length > 0) {
      serverLog.debug(
        { count: adopted.length, names: adopted },
        'Hydrated provider environment variables from the login shell',
      );
    }
    return adopted;
  })().catch(() => [] as string[]);
  return hydration;
}
