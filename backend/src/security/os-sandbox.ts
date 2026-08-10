// OS-level sandbox for command execution.
//
// Replaces the regex-only bash sandbox with kernel-enforced confinement.
// The regex layer in bash-sandbox.ts stays as defense-in-depth, but the
// trust boundary moves here.
//
// Platform support:
//   - Linux: bubblewrap mount/PID/network namespaces.
//   - macOS: sandbox-exec profile generated from allowed roots.
//   - Windows / unsupported: unavailable. Sandbox-required callers must
//     reject the command instead of silently running it without confinement.
//
// Set KORYPHAIOS_OS_SANDBOX=1 to activate. Both the opt-in and a concrete,
// executable platform engine are required; this module fails closed otherwise.

import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { serverLog } from '../logger';

export interface OsSandboxOptions {
  /** Host roots the child is allowed to read/write. */
  allowedRoots: string[];
  /** Working directory for the child. Must be inside allowedRoots. */
  cwd: string;
  /** When true, block network syscalls (Linux) / network in sandbox-exec. */
  blockNetwork: boolean;
  /** When true, also block spawning new processes beyond the entry command. */
  blockSubprocesses: boolean;
  /** Extra env to merge into the child (PATH is always preserved). */
  env?: Record<string, string>;
}

export interface OsSandboxAvailability {
  landlock: boolean;
  seccomp: boolean;
  sandboxExec: boolean;
}

let availabilityCache: OsSandboxAvailability | undefined;

/** Detect OS sandbox features once per process. */
export function detectOsSandbox(): OsSandboxAvailability {
  if (availabilityCache) return availabilityCache;

  const landlock =
    process.platform === 'linux' &&
    existsSync('/usr/include/linux/landlock.h') &&
    // Kernel-side check: landlock is meaningless without a kernel that
    // supports it. Probe via /sys; fall back to header presence.
    (existsSync('/sys/kernel/security/landlock') || process.env.KORYPHAIOS_FORCE_LANDLOCK === '1');

  const seccomp =
    process.platform === 'linux' &&
    existsSync('/proc/self/status') &&
    // seccomp support is indicated by "Seccomp:" in /proc/self/status on
    // kernels that support it. Even without it, prctl(PR_SET_SECCOMP)
    // exists on any modern kernel.
    true;

  const sandboxExec = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

  availabilityCache = { landlock, seccomp, sandboxExec };
  return availabilityCache;
}

/** True only when a concrete enforcement engine is installed. Linux header
 * support is not sufficient until Koryphaios ships a native Landlock shim. */
export function osSandboxAvailable(): boolean {
  if (process.platform === 'linux') return findOnPath('bwrap') !== null;
  if (process.platform === 'darwin') return detectOsSandbox().sandboxExec;
  return false;
}

/** True when path confinement was explicitly enabled and can actually bind. */
export function osSandboxEnabled(): boolean {
  return process.env.KORYPHAIOS_OS_SANDBOX === '1' && osSandboxAvailable();
}

/** Resolve a path to its canonical form, tolerating non-existent files. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Ensure all allowed roots are canonical and exist. Returns the cleaned list. */
function normalizeRoots(roots: string[]): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    if (!r) continue;
    const canonical = safeRealpath(r);
    out.add(canonical);
  }
  return [...out];
}

/**
 * Spawn a command inside the OS sandbox.
 *
 * On Linux with bubblewrap: the child is confined to bind-mounted
 * `allowedRoots`. Network is blocked with a private network namespace when
 * `blockNetwork` is true.
 *
 * On macOS: the child is launched through `sandbox-exec -p <profile>` with
 * a generated profile that allows the listed roots and denies network when
 * requested.
 *
 * On unsupported or disabled platforms: throws without spawning.
 */
export function spawnSandboxed(
  argv: string[],
  opts: OsSandboxOptions,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('spawnSandboxed: argv must be a non-empty array');
  }
  if (!osSandboxEnabled()) {
    throw new Error(
      'OS sandbox enforcement is unavailable. Enable KORYPHAIOS_OS_SANDBOX=1 and install bubblewrap on Linux, or use sandbox-exec on macOS.',
    );
  }

  // A private scratch root provides normal TMPDIR semantics without granting
  // the child write access to the host-wide temporary directory.
  const scratch = mkdtempSync(join(tmpdir(), 'kory-sandbox-runtime-'));
  const roots = normalizeRoots([...opts.allowedRoots, scratch]);
  const cwd = safeRealpath(opts.cwd);
  const cwdInRoots = roots.some((r) => {
    const rel = relative(r, cwd);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!cwdInRoots) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      `spawnSandboxed: cwd ${cwd} is not inside any allowed root. ` + `Roots: ${roots.join(', ')}`,
    );
  }

  // Sandboxed tools never inherit provider keys, database URLs, or backend
  // credentials. Callers can add only explicitly scoped values through env.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    ...(opts.env ?? {}),
  };

  const attachScratchCleanup = (spawned: {
    proc: ReturnType<typeof spawn>;
    cleanup: () => void;
  }): { proc: ReturnType<typeof spawn>; cleanup: () => void } => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      spawned.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    };
    spawned.proc.on('exit', cleanup);
    spawned.proc.on('error', cleanup);
    return { proc: spawned.proc, cleanup };
  };

  // ─── Linux: Landlock via a small C shim ──────────────────────────────
  // We can't call landlock_create_ruleset directly from JS without a native
  // addon. Instead, we ship a tiny C shim compiled at install time, or fall
  // back to `bwrap` (bubblewrap) when available — bwrap is the standard
  // unprivileged sandbox on modern Linux distros and is what flatpak uses.
  if (process.platform === 'linux' && osSandboxEnabled()) {
    try {
      return attachScratchCleanup(spawnLinuxSandbox(argv, opts, roots, env, cwd));
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  // ─── macOS: sandbox-exec ─────────────────────────────────────────────
  if (process.platform === 'darwin' && osSandboxEnabled()) {
    try {
      return attachScratchCleanup(spawnMacSandbox(argv, opts, roots, env, cwd));
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  // ─── Unsupported / not enabled: fail closed ──────────────────────────
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`OS sandbox enforcement is unavailable on ${process.platform}`);
}

// ─── Linux: bubblewrap (bwrap) ────────────────────────────────────────
//
// bwrap is the standard unprivileged Linux sandbox (used by flatpak, GNOME,
// systemd). It provides:
//   - mount-namespace isolation (the child sees only the bind-mounted roots)
//   - network namespace isolation (--unshare-net) when blockNetwork is true
//   - no new privileges flag (--die-with-parent)
//
// We prefer bwrap over a custom landlock C shim because:
//   1. bwrap is widely available and well-audited
//   2. it handles path confinement + network in one tool
//   3. it doesn't require compiling a native addon at install time
//
// If bwrap is not executable on PATH, sandbox-required execution is rejected.

function spawnLinuxSandbox(
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  const bwrapPath = findOnPath('bwrap');
  if (bwrapPath) {
    return spawnBwrap(bwrapPath, argv, opts, roots, env, cwd);
  }

  throw new Error('bubblewrap is required for Linux path confinement');
}

function spawnBwrap(
  bwrap: string,
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  // Build the bwrap argument list. We create new mount and PID namespaces,
  // bind each allowed root read-write, create private /dev and /proc mounts,
  // and optionally unshare the network namespace. The private scratch root is
  // bound at its host path and exposed through HOME/TMPDIR; host /tmp is not.
  const args: string[] = [
    '--die-with-parent',
    '--clearenv',
    '--unshare-user',
    '--unshare-pid',
    // /proc is mounted in a new PID namespace via --unshare-pid, so the
    // child only sees its own processes. This is safer than sharing the
    // host's /proc (which leaks other processes' env vars and fds).
    '--proc',
    '/proc',
    // /dev is created fresh in the namespace via --dev, which only
    // provides standard device nodes (null, zero, random, urandom, tty).
    // It does NOT expose host disk devices like /dev/sda.
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/etc',
    '/etc',
  ];

  // Handle /lib64 on systems that have it (most x86_64 Linux).
  if (existsSync('/lib64')) {
    args.push('--ro-bind', '/lib64', '/lib64');
  }
  // /sbin is needed for some tools on systemd-based distros.
  if (existsSync('/sbin')) {
    args.push('--ro-bind', '/sbin', '/sbin');
  }

  // Bind-mount each allowed root read-write.
  for (const root of roots) {
    args.push('--bind', root, root);
  }

  // Network isolation: unshare the net namespace so the child has no
  // external network access (only loopback, which is useless without a
  // configured interface).
  if (opts.blockNetwork) {
    args.push('--unshare-net');
  }

  // Block subprocesses: bwrap doesn't have a direct flag, but
  // --unshare-pid already isolates the PID namespace. To hard-block
  // subprocess spawns we'd need seccomp; for now the PID namespace +
  // the regex layer's blocklist is the boundary. Log when requested
  // but unavailable so the gap is visible.
  if (opts.blockSubprocesses) {
    serverLog.debug(
      'bwrap: blockSubprocesses requested but no direct seccomp filter applied; ' +
        'PID namespace isolation is in effect',
    );
  }

  // Set the working directory inside the sandbox.
  args.push('--chdir', cwd);

  // Set environment inside the sandbox.
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) args.push('--setenv', k, String(v));
  }

  // The actual command to run.
  args.push('--', argv[0], ...argv.slice(1));

  serverLog.debug({ bwrap, roots, blockNetwork: opts.blockNetwork }, 'spawning bwrap sandbox');

  const proc = spawn(bwrap, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  return { proc, cleanup: () => {} };
}

// ─── macOS: sandbox-exec ──────────────────────────────────────────────

function spawnMacSandbox(
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  // Build a sandbox-exec profile. The profile allows file reads/writes
  // under each root, denies network when requested, and allows subprocess
  // execution (sandbox-exec's process model is per-line, not a hard block).
  const allowFile = (root: string) =>
    `(allow file-read* (subpath "${root}"))\n  (allow file-write* (subpath "${root}"))\n`;
  const profileLines: string[] = [
    '(version 1)',
    '(deny default)',
    // Subprocess spawning: allowed by default because sandbox-exec's
    // process model is per-line. When blockSubprocesses is true we omit
    // this allow, which causes the default-deny to block fork/exec.
    ...(opts.blockSubprocesses ? [] : ['(allow process*)']),
    // Mach IPC is required for many macOS system calls (e.g. looking up
    // system services, getting the current time via mach_absolute_time,
    // and dynamic linker resolution). Without this, even simple commands
    // like `touch` fail with "Operation not permitted".
    '(allow mach*)',
    '(allow iokit*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    // System reads needed for dynamic linking, locale, etc.
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library/Fonts"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/etc"))',
  ];

  for (const root of roots) {
    profileLines.push(allowFile(root));
  }

  if (opts.blockNetwork) {
    profileLines.push('(deny network*)');
  } else {
    profileLines.push('(allow network*)');
  }

  const profile = profileLines.join('\n');

  // Write the profile to a temp file so sandbox-exec can read it.
  const profileDir = mkdtempSync(join(tmpdir(), 'kory-sandbox-'));
  const profilePath = join(profileDir, 'profile.sb');
  writeFileSync(profilePath, profile, { mode: 0o600 });

  const macArgs = ['-p', profilePath, ...argv];

  serverLog.debug(
    { sandboxExec: '/usr/bin/sandbox-exec', roots, blockNetwork: opts.blockNetwork },
    'spawning sandbox-exec',
  );

  const proc = spawn('/usr/bin/sandbox-exec', macArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env,
    shell: false,
  });

  const cleanup = () => {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  // Clean up the profile after the process exits. We can't await here, so
  // schedule cleanup on the next tick after exit.
  proc.on('exit', () => cleanup());
  proc.on('error', () => cleanup());

  return { proc, cleanup };
}

// ─── helpers ──────────────────────────────────────────────────────────

function findOnPath(bin: string): string | null {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      // Keep searching: an existing but non-executable file is not an
      // enforceable sandbox engine.
    }
  }
  return null;
}

/**
 * Compute the default allowed roots for a sandboxed command.
 * Includes only the working directory. Global Koryphaios data can contain
 * other sessions and provider credentials and is never an implicit Bash grant.
 */
export function defaultAllowedRoots(workdir: string): string[] {
  const roots = new Set<string>();
  roots.add(safeRealpath(workdir));
  return [...roots];
}
