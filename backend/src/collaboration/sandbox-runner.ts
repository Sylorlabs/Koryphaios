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

import { existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { serverLog } from '../logger';
import type { SandboxPolicy } from '@koryphaios/shared';
import { sessionWorkspaceOwnership } from '../kory/session-workspace';
import { findOnPath, hostOS, isMac, isLinux } from '../runtime/platform';

export type SandboxMechanism = 'bubblewrap' | 'seatbelt' | 'none';

let cached: { mechanism: SandboxMechanism; path: string | null } | undefined;

function detect(): { mechanism: SandboxMechanism; path: string | null } {
  if (cached !== undefined) return cached;
  if (isLinux()) {
    const bw = findOnPath('bwrap');
    if (bw) {
      // Verify user namespaces actually work (some kernels disable them).
      try {
        const probeArgs = ['--ro-bind', '/usr', '/usr'];
        for (const lib of ['/lib', '/lib64']) {
          if (existsSync(lib)) probeArgs.push('--ro-bind-try', lib, lib);
        }
        probeArgs.push('--', '/usr/bin/true');
        execFileSync(bw, probeArgs, {
          timeout: 4000,
          stdio: 'ignore',
        });
        cached = { mechanism: 'bubblewrap', path: bw };
        return cached;
      } catch (err: unknown) {
        // User namespaces unavailable on this kernel; fall back to no isolation.
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'bubblewrap user namespaces unavailable; falling back',
        );
      }
    }
  } else if (isMac()) {
    // sandbox-exec ships with macOS at a fixed path.
    const sb =
      findOnPath('sandbox-exec') ??
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
    platform: hostOS(),
  };
}

export interface WrapOptions {
  cwd: string;
  homeDir?: string;
  /** CLI-owned mutable runtime/config directories exposed read-write. */
  configDirs?: string[];
  /** Account/provider configuration that the CLI may inspect but never mutate. */
  readonlyConfigDirs?: string[];
  /** Unix socket paths (e.g. the D-Bus user bus for OS-keyring OAuth) bound
   *  read-write. Sockets are always bound rw — a read-only bind cannot
   *  connect. Request only what the CLI needs: the bus exposes every session
   *  service, so this is the narrowest hole that still lets keyring-backed
   *  CLIs sign in. */
  sockets?: string[];
  policy: SandboxPolicy;
}

export function sandboxHome(opts: Pick<WrapOptions, 'cwd' | 'homeDir'>): string {
  return opts.homeDir ?? opts.cwd;
}

// ─── Linux: bubblewrap ───────────────────────────────────────────────────────

const SYSTEM_RO = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/nix', '/etc/alternatives'];
const NET_RO = [
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/etc/gai.conf',
  '/etc/hosts',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
];
// Some hosts resolve through nss-resolve instead of a usable resolv.conf. Bind
// only the resolver query socket, and only when this jail permits networking.
// Exposing all of /run (or a session bus) would grant unrelated host services.
const DNS_QUERY_SOCKETS = ['/run/systemd/resolve/io.systemd.Resolve'];

function binaryBindDirs(bin: string): string[] {
  if (!bin.startsWith('/')) return [];
  const dirs = new Set<string>();
  dirs.add(dirname(bin));
  try {
    const real = realpathSync(bin);
    if (real.startsWith('/')) dirs.add(dirname(real));
  } catch {
    /* dangling or unreadable link — fall back to the literal dir */
  }
  // Script-based CLIs need their absolute shebang interpreter inside the
  // namespace too. This matters for managed test/runtime shims and for CLI
  // launchers installed outside /usr; binding only the launcher directory
  // otherwise produces the misleading `execvp ... No such file` error.
  try {
    const firstLine = readFileSync(bin, 'utf8').split('\n', 1)[0] ?? '';
    const interpreter = /^#!\s*(\/\S+)/.exec(firstLine)?.[1];
    if (interpreter) {
      const realInterpreter = realpathSync(interpreter);
      if (realInterpreter.startsWith('/')) dirs.add(dirname(realInterpreter));
    }
  } catch {
    /* binary is not a readable script — the executable directory is enough */
  }
  return [...dirs].filter((d) => !!d && existsSync(d));
}

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
    // Hide the host root before adding explicit managed-home and executable
    // binds. If this is added after those binds, a runtime installed under
    // /root (for example an npx/Bun shim) is masked and script CLIs fail with
    // the misleading `execvp ... No such file` error.
    '--tmpfs',
    '/root',
  ];
  for (const p of SYSTEM_RO) if (existsSync(p)) flags.push('--ro-bind-try', p, p);
  if (opts.policy.allowNetwork) {
    for (const p of NET_RO) if (existsSync(p)) flags.push('--ro-bind-try', p, p);
  }
  // The CLI binary itself must be visible inside the namespace. Binaries
  // installed outside the system roots (e.g. ~/.local/bin/agy, nvm shims)
  // otherwise fail with `bwrap: execvp <bin>: No such file or directory`.
  // Bind the containing directory read-only; the skeleton below creates the
  // parent --dir entries so the mount has a destination.
  const cliBinDirs = binaryBindDirs(bin);
  // bubblewrap does not create destination parents for arbitrary bind mounts.
  // Managed CLI homes and bridge runtimes commonly live below /home/<user>,
  // which is intentionally absent from the base namespace. Create only the
  // directory skeleton needed by the explicit mounts; no host content is
  // exposed by these --dir entries.
  const mountTargets = [
    opts.cwd,
    ...(opts.configDirs ?? []),
    ...(opts.readonlyConfigDirs ?? []),
    ...(opts.sockets ?? []),
    ...cliBinDirs,
    ...(opts.policy.allowNetwork ? DNS_QUERY_SOCKETS.filter((path) => existsSync(path)) : []),
  ];
  const created = new Set<string>();
  for (const target of mountTargets) {
    const parts = target.split('/').filter(Boolean);
    let parent = '';
    for (const part of parts.slice(0, -1)) {
      parent += `/${part}`;
      if (SYSTEM_RO.includes(parent) || created.has(parent)) continue;
      flags.push('--dir', parent);
      created.add(parent);
    }
  }
  flags.push(
    opts.policy.allowEdits ? '--bind' : '--ro-bind',
    opts.cwd,
    opts.cwd,
    '--chdir',
    opts.cwd,
  );
  for (const dir of opts.configDirs ?? []) {
    if (existsSync(dir)) flags.push('--bind', dir, dir);
  }
  for (const dir of opts.readonlyConfigDirs ?? []) {
    if (existsSync(dir)) flags.push('--ro-bind', dir, dir);
  }
  for (const dir of cliBinDirs) {
    if (flags.includes(dir)) continue;
    flags.push('--ro-bind-try', dir, dir);
  }
  // Session sockets (D-Bus user bus, …) need a read-write bind — connecting
  // over a read-only bind fails. The skeleton above created the parents.
  for (const sock of opts.sockets ?? []) {
    if (!sock || flags.includes(sock)) continue;
    if (existsSync(sock)) flags.push('--bind', sock, sock);
  }
  if (opts.policy.allowNetwork)
    for (const socket of DNS_QUERY_SOCKETS) {
      if (existsSync(socket)) flags.push('--bind', socket, socket);
    }
  flags.push('--setenv', 'HOME', sandboxHome(opts));
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
  return dirs.map((d) => `  (subpath ${JSON.stringify(seatbeltPath(join(home, d)))})`).join('\n');
}

/** Seatbelt matches path filters against the path the kernel resolves, not the
 *  spelling the caller used. macOS resolves `/var` → `/private/var`, so a rule
 *  built from the ambient `tmpdir()` (`/var/folders/...`) never matches and every
 *  write under it is denied. Canonicalize before quoting; the CLI still receives
 *  the original argv path, which resolves to the same vnode. */
function seatbeltPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Missing/permission-denied paths cannot be resolved; keep the literal path
    // so the rule is at least well-formed.
    return p;
  }
}

function quoteSub(p: string): string {
  return `(subpath ${JSON.stringify(seatbeltPath(p))})`;
}

export function buildSeatbeltProfile(opts: WrapOptions): string {
  const home = homedir();
  const strictChat = !!sessionWorkspaceOwnership(opts.cwd);
  const writable = [
    ...(opts.policy.allowEdits ? [opts.cwd] : []),
    ...(opts.configDirs ?? []),
    ...(strictChat
      ? opts.homeDir
        ? [opts.homeDir]
        : []
      : ['/tmp', '/private/tmp', '/private/var/folders']),
    '/dev',
  ]
    .map(quoteSub)
    .join(' ');

  // allow-default keeps the CLI runnable; specific denies do the confining.
  // Read-only config paths need no allow rule because reads are allowed by
  // default; the global file-write deny keeps them immutable.
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
 *  own config), scrubbed secrets, and a private temp. Cross-platform.
 *
 *  `homeLinks` maps a path *relative to the jail HOME* to an absolute host
 *  directory, e.g. `{ '.local/share': '/host/staged/.local/share' }`. It exists
 *  because the `configDirs` shorthand can only symlink a directory's basename,
 *  which is wrong for nested paths: passing `<staged>/.local/share` would link
 *  `<jailHome>/share`, while the CLI resolves `<jailHome>/.local/share`. Use
 *  `homeLinks` whenever the directory the CLI reads is nested. */
export function buildSoftJail(
  base: NodeJS.ProcessEnv,
  configDirs: string[] = [],
  homeLinks: Record<string, string> = {},
): SoftJail {
  const home = mkdtempSync(join(tmpdir(), 'kory-home-'));
  const tmp = join(home, '.tmp');
  try {
    mkdirSync(tmp, { recursive: true });
  } catch (err: unknown) {
    // Best-effort temp dir; the CLI can use the system temp if this fails.
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Soft-jail temp dir creation failed; best-effort',
    );
  }
  // Expose ONLY the CLI's own writable config inside the fake home. Read-only
  // account paths are referenced explicitly and are never symlinked here.
  for (const dir of configDirs) {
    if (!existsSync(dir)) continue;
    try {
      symlinkSync(dir, join(home, basename(dir)), 'dir');
    } catch (err: unknown) {
      // Symlink may need privilege on Windows — the CLI usually reads its
      // config via an absolute env var anyway, so this is best-effort.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), dir },
        'Soft-jail config symlink failed; best-effort',
      );
    }
  }
  for (const [relative, source] of Object.entries(homeLinks)) {
    if (!relative || !existsSync(source)) continue;
    const target = join(home, relative);
    try {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, 'dir');
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), source, relative },
        'Soft-jail home link failed; best-effort',
      );
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
      } catch (err: unknown) {
        // Cleanup is best-effort; the OS temp reaper will remove it eventually.
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Soft-jail home cleanup failed; best-effort',
        );
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

/**
 * Inference-transport rule for spawned CLI children.
 *
 * A CLI child IS the model transport: its own HTTPS calls (direct provider
 * APIs or a local bridge) carry the turn's inference. Cutting its network
 * (allowNetwork: false) cannot work — every request fails at connect (EPERM
 * under Seatbelt, ENETUNREACH under bwrap --unshare-net) and the turn dies
 * before any tool runs. Network restriction for AGENT tools stays enforced
 * one layer up: Koryphaios owns tool execution (kory__ MCP tools +
 * permission policy), each CLI's native web tools are hard-disabled
 * (--disallowedTools / harness rules / the CLI's own tool sandbox), so the
 * OS jail keeps filesystem confinement while inference keeps its socket.
 */
export function inferenceSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  if (policy.allowNetwork) return policy;
  return { ...policy, allowNetwork: true };
}

/** Build the spawn command. Wraps in the host's native OS sandbox when isolation
 *  is requested AND available; otherwise returns the command unchanged. */
export function wrapCommand(bin: string, args: string[], opts: WrapOptions): WrapResult {
  const d = detect();
  const strictChat = !!sessionWorkspaceOwnership(opts.cwd);
  if (
    strictChat &&
    (d.mechanism === 'none' || !d.path || process.env.KORYPHAIOS_OS_SANDBOX === '0')
  ) {
    throw new Error(
      'This CLI cannot run without enforced chat isolation. Install bubblewrap on Linux or enable the macOS sandbox.',
    );
  }
  if (strictChat) {
    opts = {
      ...opts,
      policy: { ...opts.policy, filesystemIsolation: true },
      configDirs: [...(opts.configDirs ?? []), ...(opts.homeDir ? [opts.homeDir] : [])],
    };
  }
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
