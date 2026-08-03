import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSecureDir } from '../security/fs-permissions';

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
    } catch {
      /* fall through to cwd detection */
    }
  }
  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, '..'), join(cwd, '..', '..')] as const;
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'koryphaios.json'))) {
      return candidate;
    }
  }
  return cwd;
}

export const PROJECT_ROOT = detectProjectRoot();

export const BACKEND_ROOT = existsSync(join(PROJECT_ROOT, 'backend', 'src'))
  ? join(PROJECT_ROOT, 'backend')
  : PROJECT_ROOT;
