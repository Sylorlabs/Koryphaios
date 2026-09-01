/**
 * E2E DB-path helper — locates the disposable SQLite database the Playwright
 * webServer is writing to for the current test run.
 *
 * `playwright.config.ts` boots the backend with
 * `KORYPHAIOS_DATA_DIR=/tmp/koryphaios-playwright-<pid>`. Inside that root
 * the backend creates a `data/` subdirectory and writes `koryphaios.db`
 * there. The Playwright test runner spawns each spec in a worker whose pid
 * differs from the one baked into the path, so we can't trust `process.pid`
 * here — we discover the live directory by scanning /tmp.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function isDataDirWithDb(path: string): boolean {
  const db = join(path, 'data', 'koryphaios.db');
  return existsSync(db);
}

function listPlaywrightDataDirs(): string[] {
  try {
    return readdirSync('/tmp')
      .filter((name) => name.startsWith('koryphaios-playwright-'))
      .map((name) => join('/tmp', name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && isDataDirWithDb(p);
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function resolvePlaywrightDataDir(): string {
  const override = process.env.KORY_E2E_DATA_DIR;
  if (override) return override;

  const live = listPlaywrightDataDirs();
  if (live.length === 1) return live[0]!;
  if (live.length > 1) {
    // Multiple runs may coexist on a developer machine; pick the most
    // recently modified so the spec always lands on the live backend
    // (the older one was almost certainly killed already).
    return live
      .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]!.p;
  }
  throw new Error(
    'E2E reasoning-reload: no live `/tmp/koryphaios-playwright-*/data/koryphaios.db` was found. ' +
      'Has the Playwright webServer for this run been started?',
  );
}

export function resolvePlaywrightDbPath(): string {
  return join(resolvePlaywrightDataDir(), 'data', 'koryphaios.db');
}

/**
 * Returns the resolved DB path. The name is historical — the Playwright-
 * launched backend already owns the DB at this path, so this is a resolve
 * plus an existence assertion, not a move. We assert so the test fails fast
 * if Playwright's webServer didn't actually start.
 */
export async function moveAndReadDbPath(): Promise<string> {
  const dbPath = resolvePlaywrightDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(
      `E2E reasoning-reload: expected DB at ${dbPath} but it does not exist. ` +
        `Is the Playwright webServer for this run still running?`,
    );
  }
  return dbPath;
}