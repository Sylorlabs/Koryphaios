/**
 * OS-level sandbox runner — cross-platform.
 *
 * Confines a remote guest's CLI turn using the host OS's native sandbox, so the
 * containment cannot be bypassed by the CLI's own shell:
 *   - Linux   → bubblewrap (`bwrap`): bind only the project; optional net cut.
 *   - macOS   → `sandbox-exec` (Seatbelt): confine writes to the project, deny
 *               reads of known secret stores, optional net cut.
 *   - Windows → no built-in per-process filesystem jail exists; falls back to
 *               tool-level gating (still blocks the CLI's edit/shell/web tools).
 *
 * Where no OS mechanism is available, wrapCommand() passes the command through
 * unchanged and reports it, so the host always knows the true enforcement level.
 */

import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { SandboxPolicy } from '@koryphaios/shared';

function which(bin: string): string | null {
  const PATH = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export type SandboxMechanism = 'bubblewrap' | 'seatbelt' | 'none';

let cached: { mechanism: SandboxMechanism; path: string | null } | undefined;

function detect(): { mechanism: SandboxMechanism; path: string | null } {
  if (cached !== undefined) return cached;
  if (process.platform === 'linux') {
    const bw = which('bwrap');
    if (bw) {
      // Verify user namespaces actually work (some kernels disable them).
      try {
        execFileSync(bw, ['--ro-bind', '/usr', '/usr', 'true'], { timeout: 4000, stdio: 'ignore' });
        cached = { mechanism: 'bubblewrap', path: bw };
        return cached;
      } catch {
        /* namespaces unavailable */
      }
    }
  } else if (process.platform === 'darwin') {
    // sandbox-exec ships with macOS at a fixed path.
    const sb =
      which('sandbox-exec') ??
      (existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null);
    if (sb) {
      cached = { mechanism: 'seatbelt', path: sb };
      return cached;
    }
  }
  cached = { mechanism: 'none', path: null };
  return cached;
}

export interface SandboxCapabilities {
  /** OS-level isolation is available on this host. */
  osIsolation: boolean;
  mechanism: SandboxMechanism;
  platform: NodeJS.Platform;
}

export function sandboxCapabilities(): SandboxCapabilities {
  const d = detect();
  return {
    osIsolation: d.mechanism !== 'none',
    mechanism: d.mechanism,
    platform: process.platform,
  };
}

export interface WrapOptions {
  cwd: string;
  /** The CLI's own config/auth dir(s) — exposed read-write inside the jail so
   *  the CLI can run. The host's real HOME is never fully bound. */
  configDirs?: string[];
  policy: SandboxPolicy;
}

// ─── Linux: bubblewrap ───────────────────────────────────────────────────────

const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/nix', '/etc/alternatives'];
const NET_RO = ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl', '/etc/ca-certificates', '/etc/pki'];

function buildBwrap(bw: string, bin: string, args: string[], opts: WrapOptions): string[] {
  const flags: string[] = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
    ...(opts.policy.allowNetwork ? [] : ['--unshare-net']),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const p of SYSTEM_RO) if (existsSync(p)) flags.push('--ro-bind-try', p, p);
  if (opts.policy.allowNetwork)
    for (const p of NET_RO) if (existsSync(p)) flags.push('--ro-bind-try', p, p);
  flags.push('--bind', opts.cwd, opts.cwd, '--chdir', opts.cwd);
  for (const dir of opts.configDirs ?? []) if (existsSync(dir)) flags.push('--bind', dir, dir);
  flags.push('--tmpfs', '/root', '--setenv', 'HOME', opts.cwd);
  return [...flags, '--', bin, ...args];
}

// ─── macOS: Seatbelt (sandbox-exec) ──────────────────────────────────────────

// Common secret stores denied for reading. Not exhaustive, but covers the
// high-value targets; writes are confined to the project regardless.
function seatbeltSecretDenies(home: string): string {
  const dirs = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.docker',
    '.config/gcloud',
    '.azure',
    '.netrc',
    '.npmrc',
    'Library/Keychains',
  ];
  return dirs.map((d) => `  (subpath ${JSON.stringify(join(home, d))})`).join('\n');
}

function quoteSub(p: string): string {
  return `(subpath ${JSON.stringify(p)})`;
}

export function buildSeatbeltProfile(opts: WrapOptions): string {
  const home = homedir();
  const writable = [
    opts.cwd,
    ...(opts.configDirs ?? []),
    '/tmp',
    '/private/tmp',
    '/private/var/folders',
    '/dev',
  ]
    .map(quoteSub)
    .join(' ');

  // allow-default keeps the CLI runnable; specific denies do the confining.
  // (Later matching rules win in SBPL, so denies after allow-default apply.)
  return [
    '(version 1)',
    '(allow default)',
    opts.policy.allowNetwork ? '' : '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* ${writable})`,
    '(deny file-read*',
    seatbeltSecretDenies(home),
    ')',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── Cross-platform "soft jail" (works on ALL platforms, incl. Windows) ──────
//
// Not a kernel boundary — a determined process can still open an absolute path
// to the host's home. But it stops the realistic risks for a trusted-friend +
// possibly-careless-agent threat model, everywhere:
//   1. Env-secret scrubbing: the CLI process never sees the host's OTHER API
//      keys, tokens, or cloud creds.
//   2. HOME redirection: `~` points at a fresh dir containing ONLY the CLI's
//      own config, so `cat ~/.ssh/id_rsa` / `~/.aws/...` find nothing. Most
//      tools and agents reach secrets via `~`, so this covers the common path.
//   3. Temp redirection: scratch files stay in the sandbox.
// It layers UNDER the kernel jail (bwrap/Seatbelt) where those exist.

const SCRUB_ENV = [
  /_TOKEN$/i,
  /_KEY$/i,
  /_SECRET/i,
  /_PASSWORD/i,
  /_CREDENTIAL/i,
  /PASSWD/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^OPENAI/i,
  /^ANTHROPIC/i,
  /^XAI/i,
  /^GROQ/i,
  /^MISTRAL/i,
  /^COHERE/i,
  /SSH_AUTH_SOCK/i,
  /^VAULT_/i,
  /^DOCKER_/i,
];
// Env vars the CLI harness itself needs — never scrubbed even if they match.
const KEEP_ENV = new Set([
  'CLAUDE_CONFIG_DIR',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'GROK_CODE_XAI_API_KEY',
  'ANTIGRAVITY_API_KEY',
  'CURSOR_API_KEY',
  'COGNITION_API_KEY',
]);

export interface SoftJail {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/** Build the soft-jail environment: a redirected HOME (exposing only the CLI's
 *  own config), scrubbed secrets, and a private temp. Cross-platform. */
export function buildSoftJail(base: NodeJS.ProcessEnv, configDirs: string[] = []): SoftJail {
  const home = mkdtempSync(join(tmpdir(), 'kory-home-'));
  const tmp = join(home, '.tmp');
  try {
    mkdirSync(tmp, { recursive: true });
  } catch {
    /* best-effort */
  }
  // Expose ONLY the CLI's own config inside the fake home.
  for (const dir of configDirs) {
    if (!existsSync(dir)) continue;
    try {
      symlinkSync(dir, join(home, basename(dir)), 'dir');
    } catch {
      /* symlink may need privilege on Windows — the CLI usually reads its
         config via an absolute env var anyway, so this is best-effort. */
    }
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!KEEP_ENV.has(k) && SCRUB_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  env.HOME = home;
  env.USERPROFILE = home; // Windows
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  env.TMPDIR = tmp;
  env.TEMP = tmp;
  env.TMP = tmp;

  return {
    env,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface WrapResult {
  command: string;
  args: string[];
  isolated: boolean;
  mechanism: SandboxMechanism;
}

/** Build the spawn command. Wraps in the host's native OS sandbox when isolation
 *  is requested AND available; otherwise returns the command unchanged. */
export function wrapCommand(bin: string, args: string[], opts: WrapOptions): WrapResult {
  const d = detect();
  if (!opts.policy.filesystemIsolation || d.mechanism === 'none' || !d.path) {
    return { command: bin, args, isolated: false, mechanism: 'none' };
  }
  if (d.mechanism === 'bubblewrap') {
    return {
      command: d.path,
      args: buildBwrap(d.path, bin, args, opts),
      isolated: true,
      mechanism: 'bubblewrap',
    };
  }
  // seatbelt: sandbox-exec -p '<profile>' -- bin ...args
  const profile = buildSeatbeltProfile(opts);
  return {
    command: d.path,
    args: ['-p', profile, bin, ...args],
    isolated: true,
    mechanism: 'seatbelt',
  };
}
