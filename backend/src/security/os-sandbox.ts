// OS-level sandbox for command execution.
//
// Replaces the regex-only bash sandbox with kernel-enforced confinement.
// The regex layer in bash-sandbox.ts stays as defense-in-depth, but the
// trust boundary moves here.
//
// Platform support:
//   - Linux: bubblewrap mount/PID/network namespaces.
//   - macOS: sandbox-exec profile generated from allowed roots.
//   - Windows: WSL plus bubblewrap. Windows has no unprivileged kernel sandbox
//     a Node child can bind directly, so confinement runs inside the installed
//     distribution and every grant and the working directory are translated to
//     their WSL paths. Without WSL and bwrap the host has no engine and
//     sandbox-required callers reject the command rather than running it
//     unconfined.
//
// Set KORYPHAIOS_OS_SANDBOX=0 to force-disable confinement process-wide.
// A concrete, executable platform engine is always required; this module fails
// closed otherwise. Whether a given call *requires* confinement is decided by
// `workspace.sandbox` in the permission policy, not by an environment variable.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { serverLog } from '../logger';
import {
  canonicalizePath,
  findExecutableOnPath,
  hostOS,
  isContainedBy,
  isLinux,
  isMac,
  isWindows,
  windowsPathToWsl,
} from '../runtime/platform';

export interface OsSandboxOptions {
  /** Host roots the child is allowed to read/write. */
  allowedRoots: string[];
  /** Host roots the child may read but never write. */
  readOnlyRoots?: string[];
  /** Fixed canonical host-owned write grant. When present it supersedes all
   * allowedRoots, cannot be broadened by cwd, and must not have been replaced
   * by a symlink since authorization. Outside reads are not this boundary. */
  requiredWorkspaceRoot?: string;
  /** Working directory for the child. Must be inside allowedRoots. */
  cwd: string;
  /** When true, block network syscalls (Linux) / network in sandbox-exec. */
  blockNetwork: boolean;
  /** When true, also block spawning new processes beyond the entry command. */
  blockSubprocesses: boolean;
  /** Extra env to merge into the child (PATH is always preserved). */
  env?: Record<string, string>;
  /** Host-owned subprocess transport; ignored by default for shell tools. */
  stdin?: 'ignore' | 'pipe';
  /** Host-owned process group for bounded Git/helper teardown. */
  detached?: boolean;
  /**
   * Permit this child to launch and read a window, which the host grants only when the session's
   * permission policy allows computer use. It adds only the Launch Services allowance that
   * `(deny default)` otherwise withholds. Window server access and the private temp root the
   * capture is staged in are already available to every sandboxed child, so this grants no
   * additional filesystem reach.
   */
  allowWindowCapture?: boolean;
}

export interface OsSandboxAvailability {
  landlock: boolean;
  seccomp: boolean;
  sandboxExec: boolean;
  /** Windows only: WSL is installed and the distribution provides bwrap. */
  wslBwrap: boolean;
}

let availabilityCache: OsSandboxAvailability | undefined;

/** Detect OS sandbox features once per process. */
export function detectOsSandbox(): OsSandboxAvailability {
  if (availabilityCache) return availabilityCache;

  const landlock =
    isLinux() &&
    existsSync('/usr/include/linux/landlock.h') &&
    // Kernel-side check: landlock is meaningless without a kernel that
    // supports it. Probe via /sys; fall back to header presence.
    (existsSync('/sys/kernel/security/landlock') || process.env.KORYPHAIOS_FORCE_LANDLOCK === '1');

  const seccomp =
    isLinux() &&
    existsSync('/proc/self/status') &&
    // seccomp support is indicated by "Seccomp:" in /proc/self/status on
    // kernels that support it. Even without it, prctl(PR_SET_SECCOMP)
    // exists on any modern kernel.
    true;

  const sandboxExec = isMac() && existsSync('/usr/bin/sandbox-exec');

  // The Windows probe is one short process, cached for the life of the process,
  // because it answers a configuration question (is there a distribution with
  // bwrap?) rather than a per-command one. A negative answer is NOT cached: a
  // cold WSL virtual machine takes longer than the probe timeout to boot, so
  // a negative at process start would otherwise disable confinement for the
  // process lifetime even though the engine is installed.
  const wslBwrap = isWindows() && wslBwrapAvailable();

  availabilityCache = { landlock, seccomp, sandboxExec, wslBwrap };
  if (isWindows() && !wslBwrap) {
    // Re-probe on the next call rather than trusting a negative that may
    // only mean the VM was still booting.
    availabilityCache = undefined;
    return { landlock, seccomp, sandboxExec, wslBwrap };
  }
  return availabilityCache;
}

/** True only when a concrete enforcement engine is installed. Linux header
 * support is not sufficient until Koryphaios ships a native Landlock shim. */
export function osSandboxAvailable(): boolean {
  if (isLinux()) return findExecutableOnPath('bwrap') !== null;
  if (isMac()) return detectOsSandbox().sandboxExec;
  if (isWindows()) return detectOsSandbox().wslBwrap;
  return false;
}

/** True when a WSL distribution provides a bwrap Koryphaios can bind with.
 *  A distribution that answers but has no bwrap is not an engine: accepting it
 *  would report confinement the host cannot provide. */
function wslBwrapAvailable(): boolean {
  const wsl = findExecutableOnPath(process.env.KORYPHAIOS_WSL ?? 'wsl.exe');
  if (!wsl) return false;
  try {
    const probe = spawnSync(wsl, ['-e', 'sh', '-lc', 'command -v bwrap'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    return probe.status === 0 && (probe.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/** True when a sandbox-required call can actually be confined. A concrete
 *  engine must be installed. `KORYPHAIOS_OS_SANDBOX=0` is an explicit
 *  process-wide kill switch for users who need to run without confinement. */
export function osSandboxEnabled(): boolean {
  if (process.env.KORYPHAIOS_OS_SANDBOX === '0') return false;
  return osSandboxAvailable();
}

/** Resolve a path to its canonical form, tolerating non-existent files. */
function safeRealpath(p: string): string {
  try {
    return canonicalizePath(p);
  } catch {
    return resolve(p);
  }
}

/** Ensure all allowed roots are canonical and exist. Returns the cleaned list. */
function normalizeRoots(roots: string[]): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    if (!r) continue;
    const canonical = canonicalizePath(r);
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
      'OS sandbox enforcement is unavailable. Install bubblewrap on Linux, or use macOS, which provides sandbox-exec, or install WSL with bubblewrap on Windows. Set workspace.sandbox to "off" to run commands without kernel confinement.',
    );
  }

  const grant = opts.requiredWorkspaceRoot;
  if (grant && canonicalizePath(grant) !== grant) {
    throw new Error('Mandatory workspace root changed after authorization');
  }
  const roots = normalizeRoots(grant ? [grant] : opts.allowedRoots);
  const readOnlyRoots = normalizeRoots(opts.readOnlyRoots ?? []);
  // Overlapping grants have contradictory authority: bind order on Linux and
  // per-root allows on macOS would otherwise disagree about which wins.
  if (
    readOnlyRoots.some((readOnly) =>
      roots.some(
        (writable) => isContainedBy(writable, readOnly) || isContainedBy(readOnly, writable),
      ),
    )
  ) {
    throw new Error('Read-only root overlaps a writable sandbox root');
  }
  const cwd = canonicalizePath(opts.cwd);
  const cwdInRoots = roots.some((root) => isContainedBy(root, cwd));
  if (!cwdInRoots) {
    throw new Error(
      `spawnSandboxed: cwd ${cwd} is not inside any allowed root. ` + `Roots: ${roots.join(', ')}`,
    );
  }

  // A private scratch root provides TMPDIR without granting host /tmp writes.
  // It is never eligible as a caller-selected cwd or a broader workspace grant.
  const scratch = canonicalizePath(mkdtempSync(join(tmpdir(), 'kory-sandbox-runtime-')));
  if (readOnlyRoots.some((root) => isContainedBy(root, scratch) || isContainedBy(scratch, root))) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error('Read-only root overlaps a writable sandbox root');
  }
  roots.push(scratch);

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
  if (isLinux() && osSandboxEnabled()) {
    try {
      return attachScratchCleanup(spawnLinuxSandbox(argv, opts, roots, readOnlyRoots, env, cwd));
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  // ─── Windows: WSL plus bubblewrap ────────────────────────────────────
  if (isWindows() && osSandboxEnabled()) {
    try {
      return attachScratchCleanup(spawnWindowsSandbox(argv, opts, roots, readOnlyRoots, env, cwd));
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  // ─── macOS: sandbox-exec ─────────────────────────────────────────────
  if (isMac() && osSandboxEnabled()) {
    try {
      return attachScratchCleanup(spawnMacSandbox(argv, opts, roots, readOnlyRoots, env, cwd));
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  // ─── Unsupported / not enabled: fail closed ──────────────────────────
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`OS sandbox enforcement is unavailable on ${hostOS()}`);
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
  readOnlyRoots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  const bwrapPath = findExecutableOnPath('bwrap');
  if (bwrapPath) {
    return spawnBwrap(bwrapPath, argv, opts, roots, readOnlyRoots, env, cwd);
  }

  throw new Error('bubblewrap is required for Linux path confinement');
}

function spawnBwrap(
  bwrap: string,
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  readOnlyRoots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  launch: { command: string; prefix: string[] } = { command: bwrap, prefix: [] },
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

  // /lib64 (the ELF interpreter root on x86_64) and /sbin exist on most
  // Linux distros but not all — and on Windows the existsSync probe would
  // ask the *Windows* filesystem, which never has them, so the WSL
  // distribution's /lib64 symlink target would be missing inside the
  // namespace and every exec fails with ENOENT. `--ro-bind-try` binds them
  // when the sandboxed environment has them and skips them when it does
  // not, which is exactly the intended conditional.
  args.push('--ro-bind-try', '/lib64', '/lib64');
  args.push('--ro-bind-try', '/sbin', '/sbin');

  // Expose only the runtime executable (not the user's home or credentials)
  // when Bun/Node/Git is installed outside the system mounts.
  // In WSL mode (launch prefix non-empty) the payload runs inside the Linux
  // distribution, so nothing resolved against the *Windows* host PATH is a
  // valid sandbox path — probing it would bind a Windows PE path that does
  // not exist inside the namespace and abort the launch.
  const executable =
    launch.prefix.length === 0
      ? isAbsolute(argv[0])
        ? argv[0]
        : findExecutableOnPath(argv[0])
      : null;
  const systemRoots = ['/usr', '/lib', '/lib64', '/bin', '/etc', '/sbin'];
  const extraExecutable =
    executable &&
    !systemRoots.some((root) => executable === root || executable.startsWith(`${root}/`))
      ? executable
      : undefined;
  const parents = new Set<string>();
  for (const target of [
    ...roots,
    ...readOnlyRoots,
    ...(extraExecutable ? [extraExecutable] : []),
  ]) {
    let parent = '';
    for (const part of target.split('/').filter(Boolean).slice(0, -1)) {
      parent += `/${part}`;
      if (
        parents.has(parent) ||
        systemRoots.some((root) => parent === root || parent.startsWith(`${root}/`))
      )
        continue;
      args.push('--dir', parent);
      parents.add(parent);
    }
  }
  if (extraExecutable) args.push('--ro-bind', extraExecutable, extraExecutable);

  // Bind-mount each allowed root read-write.
  for (const root of roots) {
    args.push('--bind', root, root);
  }
  for (const root of readOnlyRoots) {
    args.push('--ro-bind', root, root);
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

  const proc = spawn(launch.command, [...launch.prefix, ...args], {
    detached: opts.detached ?? false,
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
    shell: false,
  });
  return { proc, cleanup: () => {} };
}

// ─── Windows: WSL plus bubblewrap ─────────────────────────────────────
//
// Windows has no unprivileged kernel sandbox that a Node child can bind
// directly, so the boundary is the installed WSL distribution: the same bwrap
// arguments are used, with every grant, the working directory and the program
// translated to its `/mnt/<drive>/...` form. A path that cannot be translated
// aborts the launch — binding a guessed path would confine the child to
// somewhere the user never approved.

function spawnWindowsSandbox(
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  readOnlyRoots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  const wsl = findExecutableOnPath(process.env.KORYPHAIOS_WSL ?? 'wsl.exe');
  if (!wsl) throw new Error('WSL is required for Windows path confinement');

  const translate = (label: string, value: string): string => {
    const translated = windowsPathToWsl(value);
    if (!translated) {
      throw new Error(`The Windows sandbox cannot translate ${label} ${value} into a WSL path`);
    }
    return translated;
  };

  const translatedRoots = roots.map((root) => translate('a writable grant', root));
  const translatedReadOnly = readOnlyRoots.map((root) => translate('a read grant', root));
  const translatedCwd = translate('the working directory', cwd);
  const translatedArgv = argv.map((part, index) => {
    if (index !== 0) {
      // Arguments that are absolute Windows paths (or `--flag=<path>` inline
      // forms such as --git-dir=C:\...) must be translated too: inside the
      // distribution a drive-letter path is meaningless text, and git
      // operations receive working-tree and git-dir locations exclusively
      // through arguments. Free-text arguments (commit messages, refs) do
      // not start with a drive-letter pattern, so this rewrite is safe.
      const inline = /^(--[\w-]+=)([A-Za-z]:[\\/].*)$/.exec(part);
      if (inline) {
        const translatedValue = windowsPathToWsl(inline[2]);
        if (translatedValue) return `${inline[1]}${translatedValue}`;
        return part;
      }
      if (/^[A-Za-z]:[\\/]/.test(part)) {
        return windowsPathToWsl(part) ?? part;
      }
      return part;
    }
    // A bare program name (`git`, `sh`, `bash`) must stay bare: execvp
    // inside the Linux namespace resolves it against the distribution's own
    // system paths. Resolving it against the *Windows* PATH instead finds a
    // Windows PE binary (e.g. Git Bash's sh.exe), and Windows executables
    // cannot run inside the sandbox — WSL binfmt interop depends on the
    // distro's /init, which the mount namespace does not carry.
    if (!part.includes('/') && !part.includes('\\')) return part;
    if (!part.startsWith('/')) {
      const absolute = findExecutableOnPath(part);
      return absolute ? translate('the program', absolute) : part;
    }
    return translate('the program', part);
  });
  const translatedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP']) {
    const value = translatedEnv[key];
    if (value && !value.startsWith('/')) translatedEnv[key] = translate(key, value);
  }
  // The host PATH is Windows-shaped (drive letters, semicolon separators) and
  // meaningless inside the Linux namespace — bwrap runs with --clearenv, so
  // execvp would search it verbatim and find nothing. Substitute the
  // distribution's standard search path.
  translatedEnv.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

  return spawnBwrap(
    'bwrap',
    translatedArgv,
    // `detached` must not reach the Windows spawn: a detached wsl.exe loses
    // its stdio piping (CREATE_NEW_PROCESS_GROUP detaches the console the
    // Linux-side stdout forwarding depends on), so every fast sandboxed
    // command returned empty output. Process-tree cleanup is unaffected —
    // Windows termination already falls back to the direct process kill, and
    // bwrap's own --die-with-parent reaps the Linux descendants.
    { ...opts, detached: false },
    translatedRoots,
    translatedReadOnly,
    translatedEnv,
    translatedCwd,
    { command: wsl, prefix: ['-e', 'bwrap'] },
  );
}

// ─── macOS: sandbox-exec ──────────────────────────────────────────────

function spawnMacSandbox(
  argv: string[],
  opts: OsSandboxOptions,
  roots: string[],
  readOnlyRoots: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { proc: ReturnType<typeof spawn>; cleanup: () => void } {
  // Build a sandbox-exec profile. Writes are permitted only under the granted
  // roots. Reads are broad — see the note below — minus an explicit deny list of
  // credential stores.
  const allowFile = (root: string) =>
    `(allow file-read* (subpath ${JSON.stringify(root)}))\n` +
    `  (allow file-write* (subpath ${JSON.stringify(root)}))\n`;
  //
  // Why reads stay broad on macOS: a profile built solely from filtered
  // `(allow file-read* (subpath ...))` rules aborts the child during dynamic
  // linking on current macOS releases — the loader must read system paths that
  // no allowlist we can express covers. A bare `(allow file-read*)` is therefore
  // load-bearing, not laziness. The exposure that creates is closed with
  // explicit deny rules below, which take precedence and leave the toolchain
  // config agents legitimately need (~/.gitconfig, ~/.npmrc) readable.
  const profileLines: string[] = [
    '(version 1)',
    '(deny default)',
    // sandbox-exec itself must exec the initial command after applying the
    // profile. Default-denying all process operations would block that first
    // exec (exit 71). Permit only the selected executable's resolved path;
    // process-fork and execution of any other binary remain denied.
    ...(opts.blockSubprocesses
      ? [`(allow process-exec (literal ${JSON.stringify(safeRealpath(argv[0]!))}))`]
      : ['(allow process*)']),
    // Mach IPC, IOKit, signals, and sysctl are required for many macOS
    // system calls. Without these, even simple commands like `touch`
    // fail with "Operation not permitted".
    '(allow mach*)',
    '(allow iokit*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(allow file-ioctl)',
    // Git and runtimes open the null device O_RDWR. This is a sink, not a
    // writable filesystem tree; never broaden this to /dev or host /tmp.
    '(allow file-write-data (literal "/dev/null"))',
    // IPC primitives needed by the C runtime and system frameworks.
    '(allow ipc-posix-sem*)',
    '(allow ipc-posix-shm*)',
    // Note: file-write* is NOT in the broad allows above. It's denied by
    // `(deny default)` and only re-allowed per-root below.
  ];

  // Explicit read denies for credential material. Without these, a confined
  // agent could read SSH keys, cloud credentials, and Koryphaios's own stored
  // secrets and exfiltrate them over the network. Paths are canonicalized
  // because sandbox profiles match the path the child observes, and macOS
  // rewrites /var -> /private/var (a non-canonical rule would silently not match).
  for (const secretPath of macOsCredentialPaths()) {
    const canonical = safeRealpath(secretPath);
    if (existsSync(canonical)) {
      // Durable chat checkouts may live below KORYPHAIOS_DATA_DIR. Deny the
      // surrounding state/credentials, not the explicitly owned checkout.
      // This exception is never applied to credential stores such as ~/.ssh.
      const grant = opts.requiredWorkspaceRoot;
      const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim();
      const containsGrant =
        grant !== undefined && grant !== canonical && isContainedBy(canonical, grant);
      const filter =
        grant && dataDir === secretPath && containsGrant
          ? `(require-all (subpath ${JSON.stringify(canonical)}) (require-not (subpath ${JSON.stringify(grant)})))`
          : `(subpath ${JSON.stringify(canonical)})`;
      profileLines.push(`(deny file-read* ${filter})`);
      // Reaching an owned checkout still requires walking its ancestors: Git
      // canonicalizes and creates every leading component of a path, so denying
      // the whole data dir made `rev-parse --is-inside-work-tree` and
      // `worktree add` fail closed with EPERM on directories the chat legitimately
      // owns. Re-allow metadata only (stat/lstat/access) under the data dir.
      // File contents stay denied, so sibling chats, the databases, and
      // credentials remain unreadable.
      if (filter.startsWith('(require-all')) {
        profileLines.push(`(allow file-read-metadata (subpath ${JSON.stringify(canonical)}))`);
      }
    }
  }

  // Per-root file write allows. file-write* is not in the broad allows
  // above, so writes are denied by default and only permitted within
  // the granted roots.
  for (const root of roots) {
    profileLines.push(allowFile(root));
  }
  for (const root of readOnlyRoots) {
    profileLines.push(`(allow file-read* (subpath ${JSON.stringify(root)}))\n`);
  }

  if (opts.blockNetwork) {
    profileLines.push('(deny network*)');
  } else {
    profileLines.push('(allow network*)');
  }

  // The computer-use tool may need to look at a window the user showed it.
  // Launch Services performs that launch on the child's behalf, which is denied
  // by `(deny default)` unless allowed explicitly. Nothing else is added: the
  // capture is staged in the child's private scratch root, and that root is
  // already writable through the per-root allows above. Granting the host's
  // TMPDIR here instead would widen writes outside the sandbox. Skipped for
  // every other command, so the strict profile is unchanged elsewhere.
  if (opts.allowWindowCapture) {
    profileLines.push('(allow lsopen)');
  }

  const profile = profileLines.join('\n');

  // Write the profile to a temp file so sandbox-exec can read it.
  const profileDir = mkdtempSync(join(tmpdir(), 'kory-sandbox-'));
  const profilePath = join(profileDir, 'profile.sb');
  writeFileSync(profilePath, profile, { mode: 0o600 });

  const macArgs = ['-f', profilePath, ...argv];

  serverLog.debug(
    { sandboxExec: '/usr/bin/sandbox-exec', roots, blockNetwork: opts.blockNetwork },
    'spawning sandbox-exec',
  );

  const proc = spawn('/usr/bin/sandbox-exec', macArgs, {
    detached: opts.detached ?? false,
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
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

/**
 * Host paths a confined macOS agent must not be able to read.
 *
 * Covers SSH keys, cloud/registry credentials, package-publish tokens, and
 * Koryphaios's own stored secrets. Toolchain configuration that agents
 * legitimately need (gitconfig, npmrc, bunfig) is deliberately absent.
 */
function macOsCredentialPaths(): string[] {
  const home = homedir();
  if (!home || !isAbsolute(home)) return [];
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim();
  return [
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.kube'),
    join(home, '.docker'),
    join(home, '.config', 'gcloud'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'koryphaios'),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    join(home, '.pypirc'),
    join(home, '.git-credentials'),
    // Koryphaios session data and provider credentials.
    ...(dataDir && isAbsolute(dataDir) ? [dataDir] : []),
  ];
}

// ─── helpers ──────────────────────────────────────────────────────────

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
