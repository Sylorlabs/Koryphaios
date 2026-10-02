import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSecureDir } from '../security/fs-permissions';
import { serverLog } from '../logger';

export function detectProjectRoot(): string {
  // Packaged desktop app: the Tauri shell passes its per-user data dir — all
  // backend state (koryphaios.json, .koryphaios, DBs) must live there, never
  // in whatever directory the AppImage happened to be launched from.
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim();
  if (dataDir) {
    try {
      // The data dir holds credentials.json, master keys, and SQLite DBs —
      // tighten it to 0o700 so other local users can't traverse into it.
      ensureSecureDir(dataDir);
      return dataDir;
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), dataDir },
        'Failed to secure data dir, falling through to cwd detection',
      );
    }
  }
  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, '..'), join(cwd, '..', '..')] as const;
  const matches = candidates.filter((candidate) => existsSync(join(candidate, 'koryphaios.json')));
  if (matches.length > 1) {
    // Innermost wins (a nested checkout is a deliberate project), but a
    // shadowed outer config is a classic source of "I edited koryphaios.json
    // and nothing changed" confusion — name both sides once per boot.
    serverLog.warn(
      { chosen: matches[0], shadowed: matches.slice(1) },
      'Multiple koryphaios.json files found in parent directories; using the innermost. The outer file(s) are ignored.',
    );
  }
  return matches[0] ?? cwd;
}

export const PROJECT_ROOT = detectProjectRoot();

export const BACKEND_ROOT = existsSync(join(PROJECT_ROOT, 'backend', 'src'))
  ? join(PROJECT_ROOT, 'backend')
  : PROJECT_ROOT;
