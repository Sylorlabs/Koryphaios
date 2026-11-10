/**
 * Host OS branching for the backend.
 *
 * This is the only module allowed to ask "which OS is this?" on the server.
 * Everything that differs between Linux, macOS and Windows routes through a
 * helper here, so the differences are enumerated once and the OS-specific
 * knowledge stays in one readable place instead of being re-implemented in a
 * dozen call sites that can silently drift apart.
 *
 * Every helper reads `process.platform` at call time rather than caching it at
 * module load: tests stub the platform to exercise a foreign OS branch, and a
 * cached constant would pin them to whatever host they happen to run on.
 */

import { constants, accessSync, existsSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Detached provider transports own their descendants, including MCP children. */
export function providerProcessGroupOptions(): { detached: boolean; shell: boolean } {
  return { detached: isUnix(), shell: isWindows() };
}

export function terminateProviderProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWindows()) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5_000, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* Process group already exited. */ }
}

/** The three OSes Koryphaios supports, narrowed from `NodeJS.Platform`. */
export type HostOS = 'darwin' | 'linux' | 'win32';

export const SUPPORTED_HOSTS: readonly HostOS[] = ['darwin', 'linux', 'win32'];

export function hostOS(): NodeJS.Platform {
  return process.platform;
}

export function isMac(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isUnix(): boolean {
  return !isWindows();
}

/**
 * True when the host reports POSIX ownership and mode bits.
 *
 * Windows has neither `uid` nor `mode`, so every permission-hardening check
 * keyed on them is skipped there rather than failing closed on a value the OS
 * never sets.
 */
export function hasPosixPermissionBits(): boolean {
  return !isWindows();
}

/**
 * Suffixes a PATH lookup must try for a bare command name.
 *
 * Windows resolves `git` to `git.exe`/`git.cmd`, so a lookup that only tries the
 * literal name silently fails there while working everywhere else.
 */
export function executableSuffixes(): readonly string[] {
  return isWindows() ? ['', '.exe', '.cmd', '.bat'] : [''];
}

/** True when a command string is already a path rather than a bare name. */
export function looksLikePath(command: string): boolean {
  if (command.includes('/')) return true;
  return isWindows() && command.includes('\\');
}

/**
 * Locate an executable on PATH without spawning a process.
 *
 * Probing the filesystem beats `which`/`where` because it works for stubbed
 * PATHs and costs no subprocess.
 */
export function findOnPath(
  bin: string,
  pathEnv: string | undefined = process.env.PATH,
): string | null {
  if (!bin || !pathEnv) return null;
  const suffixes = executableSuffixes();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const full = join(dir, bin + suffix);
      try {
        if (existsSync(full)) return full;
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }
  return null;
}

/**
 * Locate an executable on PATH, requiring the execute permission.
 *
 * Distinct from `findOnPath` on purpose: a PATH entry that exists but cannot be
 * executed is not a usable sandbox engine, and silently accepting one would
 * report confinement the host cannot actually enforce.
 */
export function findExecutableOnPath(
  bin: string,
  pathEnv: string | undefined = process.env.PATH,
): string | null {
  if (!bin || !pathEnv) return null;
  const suffixes = executableSuffixes();
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const full = join(dir, bin + suffix);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        /* keep searching — an existing but non-executable file is not an engine */
      }
    }
  }
  return null;
}

/**
 * Find a matching compiler/runtime JDK pair. macOS's /usr/bin/java and
 * /usr/bin/javac can be executable launcher stubs even when a usable Homebrew
 * JDK is installed, so prefer explicit JAVA_HOME or the installed JDK keg.
 * The caller still must compile and execute a real probe before claiming
 * readiness: discovering two executable files is never qualification proof.
 */
export function javaToolchainExecutables(): { javac: string; java: string } | null {
  const configuredHomes = [process.env.KORY_SKILL_EVAL_JAVA_HOME, process.env.JAVA_HOME]
    .filter((home): home is string => Boolean(home));
  const platformDirs = isMac()
    ? ['/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin']
    : [];
  const candidates = [
    ...configuredHomes.map((home) => join(home, 'bin')),
    ...platformDirs,
    ...(process.env.PATH ?? '').split(delimiter),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    for (const suffix of executableSuffixes()) {
      const javac = join(dir, `javac${suffix}`);
      const java = join(dir, `java${suffix}`);
      try {
        accessSync(javac, constants.X_OK);
        accessSync(java, constants.X_OK);
        return { javac, java };
      } catch { /* candidate missing one executable */ }
    }
  }
  return null;
}

/** Homebrew's default openssl may be 4.x while a separate usable 3.x keg exists. */
export function openssl3ExecutableCandidates(): readonly string[] {
  // An explicit evaluator selection is authoritative. Never silently fall
  // through to a different installation when that selection is unusable.
  if (process.env.KORY_EVAL_OPENSSL3) return [process.env.KORY_EVAL_OPENSSL3];
  return [
    ...(isMac() ? [
      '/opt/homebrew/opt/openssl@3/bin/openssl',
      '/usr/local/opt/openssl@3/bin/openssl',
    ] : []),
    'openssl',
  ];
}

/**
 * True when `target` is `root` itself or lives underneath it.
 *
 * The separator differs by OS: a Windows `relative()` result that escapes the
 * root starts with `..\`, a POSIX one with `../`. Comparing against only one of
 * them is how a traversal check ends up rejecting or accepting the wrong thing.
 *
 * Containment is inclusive: the root itself is inside it, because a caller
 * scoped to a workspace must be able to act on that workspace's own directory.
 */
export function isContainedBy(root: string, target: string): boolean {
  const relation = relative(root, target);
  if (relation === '') return true;
  if (isAbsolute(relation)) return false;
  if (relation === '..') return false;
  const parentPrefix = isWindows() ? '..\\' : '../';
  return !relation.startsWith(parentPrefix);
}

/**
 * Canonicalise a path the way the OS itself resolves it.
 *
 * `realpathSync.native` is required on Windows: the JS implementation mishandles
 * junctions and drive-letter casing there, which would let a containment check
 * disagree with what the kernel actually opens. macOS also rewrites `/var` to
 * `/private/var`, so callers must compare canonical paths on every platform —
 * Seatbelt rule matching and sandbox binds both depend on it.
 */
export function canonicalizePath(target: string): string {
  return isWindows() ? (realpathSync.native ?? realpathSync)(target) : realpathSync(target);
}

/**
 * The link type to use when staging a directory.
 *
 * `symlinkSync`'s `dir` type is refused for privileged callers on Windows, so
 * staging code there has to ask for a `junction` — which is also the only kind
 * the OS resolves without a privilege the backend does not have.
 */
export function directoryLinkType(): 'junction' | 'dir' {
  return isWindows() ? 'junction' : 'dir';
}

/** The subset of `fs.Stats` these checks read, so tests can pass a literal. */
export interface PosixMetadata {
  uid: number;
  nlink: number;
  mode: number;
}

/**
 * True when the entry belongs to a different user than this process.
 *
 * Staging code writes credentials, bridges and CLI configs under an app-owned
 * root; an entry owned by anyone else means something replaced it. Hosts with
 * no `uid` (Windows) and hosts where `getuid` is unavailable can never report an
 * unexpected owner, so the check is vacuously false there rather than failing
 * closed on a value the OS never sets.
 */
export function hasUnexpectedOwner(metadata: PosixMetadata, uid = process.getuid?.()): boolean {
  if (!hasPosixPermissionBits() || uid === undefined) return false;
  return metadata.uid !== uid;
}

/** True when the entry has hard links, so a write through one name mutates another. */
export function hasHardLinks(metadata: PosixMetadata): boolean {
  if (!hasPosixPermissionBits()) return false;
  return metadata.nlink > 1;
}

/** True when the entry's permission bits are not exactly `expected`. */
export function hasUnexpectedMode(metadata: PosixMetadata, expected: number): boolean {
  if (!hasPosixPermissionBits()) return false;
  return (metadata.mode & 0o777) !== expected;
}
