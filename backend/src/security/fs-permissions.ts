// Filesystem permission hardening for sensitive on-disk state.
//
// Koryphaios stores credentials, session tokens, master keys, and SQLite DBs
// under <projectRoot>/.koryphaios/. The directory itself and every sensitive
// file inside it must be 0o700 / 0o600 so other local users cannot read them.
// `mkdirSync(..., { recursive: true })` without an explicit mode falls back to
// the process umask, which on many systems yields 0o775 — world-readable.
// These helpers always pass an explicit mode. App-managed leaves can heal a
// looser mode from an older build; user-configured parents are instead
// validated without mutation.

import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import { serverLog } from '../logger';

export interface SecureDirectoryOptions {
  /**
   * Managed Koryphaios leaves may heal permissions left by an older build.
   * Set this to false for user-configured parent directories: an existing
   * directory must already be private and owned by this process user, and is
   * never chmodded as a side effect of startup.
   */
  repairExistingPermissions?: boolean;
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function protectedDirectoryTargets(target: string): Set<string> {
  const home = resolve(homedir());
  const targets = [parse(target).root, home, dirname(home), resolve(tmpdir())];

  // tmpdir() may be a per-user directory on some platforms. These are still
  // shared Unix roots and must never be chmodded by application startup.
  if (process.platform !== 'win32') targets.push('/tmp', '/var/tmp');

  return new Set(targets.flatMap((path) => [resolve(path), canonicalExistingPath(path)]));
}

function assertSafeDirectoryTarget(target: string): void {
  const canonicalTarget = canonicalExistingPath(target);
  const protectedTargets = protectedDirectoryTargets(target);
  if (protectedTargets.has(target) || protectedTargets.has(canonicalTarget)) {
    throw new Error(
      `Refusing to secure broad filesystem directory ${target}; use a dedicated Koryphaios subdirectory`,
    );
  }
}

function assertOwnedPrivateDirectory(target: string): void {
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to secure symbolic-link directory ${target}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Secure directory target is not a directory: ${target}`);
  }

  if (process.platform === 'win32') return;

  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(`Secure directory is not owned by the current user: ${target}`);
  }
  const mode = metadata.mode & 0o777;
  if ((mode & 0o700) !== 0o700 || (mode & 0o077) !== 0) {
    throw new Error(`Configured directory is not private (expected owner-only 0o700): ${target}`);
  }
}

/**
 * Create an app-owned leaf with 0o700. Managed leaves can explicitly heal an
 * older loose mode; configured existing parents are validated without
 * mutation. Root, the user's home, shared temporary roots, and symlinks are
 * always rejected before chmod can run.
 */
export function ensureSecureDir(dir: string, options: SecureDirectoryOptions = {}): void {
  const target = resolve(dir);
  const repairExistingPermissions = options.repairExistingPermissions ?? true;
  assertSafeDirectoryTarget(target);

  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to secure symbolic-link directory ${target}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Secure directory target is not a directory: ${target}`);
    }

    if (!repairExistingPermissions) {
      assertOwnedPrivateDirectory(target);
      return;
    }

    const currentUid = process.getuid?.();
    if (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) {
      throw new Error(`Secure directory is not owned by the current user: ${target}`);
    }
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }

  // Re-check the leaf after creation and before chmod. This prevents an
  // existing symlink from redirecting chmod to an unrelated directory.
  const createdMetadata = lstatSync(target);
  if (createdMetadata.isSymbolicLink() || !createdMetadata.isDirectory()) {
    throw new Error(`Secure directory leaf is not a real directory: ${target}`);
  }
  chmodSync(target, 0o700);
  assertOwnedPrivateDirectory(target);
}

/** Chmod a sensitive file to 0o600. Best-effort; logs a warning on failure
 *  rather than throwing, since some filesystems (FAT, network mounts) reject
 *  chmod and we still want the write to succeed. */
export function hardenFilePermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    // SQLite may remove an empty WAL/SHM sidecar between the PRAGMA that
    // creates it and this best-effort chmod. A missing file has no permissions
    // to harden and is not an operational warning.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    serverLog.warn({ err, path: filePath }, 'Could not tighten file permissions to 0o600');
  }
}
