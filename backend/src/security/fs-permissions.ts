// Filesystem permission hardening for sensitive on-disk state.
//
// Koryphaios stores credentials, session tokens, master keys, and SQLite DBs
// under <projectRoot>/.koryphaios/. The directory itself and every sensitive
// file inside it must be 0o700 / 0o600 so other local users cannot read them.
// `mkdirSync(..., { recursive: true })` without an explicit mode falls back to
// the process umask, which on many systems yields 0o775 — world-readable.
// These helpers always pass an explicit mode AND chmod existing paths so a
// looser-permissioned directory created by an older build is healed on the
// next startup.

import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { serverLog } from '../logger';

/** Create `dir` (and parents) with 0o700, and chmod it to 0o700 if it already
 *  exists with looser permissions. Idempotent and safe to call on every boot. */
export function ensureSecureDir(dir: string): void {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Always re-apply: recursive mkdir only sets the mode on the leaf, and a
    // pre-existing dir may have been created with a looser umask.
    chmodSync(dir, 0o700);
  } catch (err) {
    // Best-effort on exotic filesystems (network mounts, FAT, etc.) that
    // ignore chmod. The sensitive files inside still get their own 0o600.
    serverLog.warn({ err, dir }, 'Could not tighten directory permissions to 0o700');
  }
}

/** Chmod a sensitive file to 0o600. Best-effort; logs a warning on failure
 *  rather than throwing, since some filesystems (FAT, network mounts) reject
 *  chmod and we still want the write to succeed. */
export function hardenFilePermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    serverLog.warn({ err, path: filePath }, 'Could not tighten file permissions to 0o600');
  }
}
