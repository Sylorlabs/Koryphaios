#!/usr/bin/env bun
/**
 * Cross-platform isolated backend test runner.
 *
 * Each test file runs in its own Bun process with a fresh SQLite database so
 * state from a previous file cannot leak into the next one (notes aliases and
 * FTS rows made this especially visible). Keeping the databases in one
 * temporary directory also lets SQLite create its WAL/SHM sidecars safely.
 *
 * Replaces the bash-only `test-backend-isolated.sh` so `bun run test:core`
 * works on macOS, Windows, and Linux without requiring bash.
 */

import { mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dir, '..');
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');
const BACKEND_TEST_TIMEOUT_MS = 60_000;
const LIVE_PROVIDER_TEST_FLAG = 'KORY_RUN_LIVE_PROVIDER_TESTS';
const SAFE_HOST_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'CI',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
]);

/** Build the environment used by the default core gate. Closed-transport is
 * the default: ambient provider secrets, endpoints, CLI accounts, and live
 * opt-ins never cross into a test process. A live provider run requires the
 * explicit KORY_RUN_LIVE_PROVIDER_TESTS=1 boundary and is not part of core. */
export function createIsolatedTestEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedHome: string,
): Record<string, string | undefined> {
  const allowLiveProviders = source[LIVE_PROVIDER_TEST_FLAG] === '1';
  const env: Record<string, string | undefined> = {};

  if (allowLiveProviders) {
    Object.assign(env, source);
  } else {
    for (const name of SAFE_HOST_ENV) {
      if (source[name] !== undefined) {
        env[name] = source[name];
      }
    }
    env[LIVE_PROVIDER_TEST_FLAG] = '0';
    env.KORY_LIVE_PROVIDER_TESTS = '0';
    env.KORY_LIVE_CLAUDE = '0';
    env.KORY_DISABLE_CLI_AUTODETECT = '1';
    env.AWS_EC2_METADATA_DISABLED = 'true';
    env.HOME = isolatedHome;
    env.USER = 'kory-test';
    env.USERNAME = 'kory-test';
    env.LOGNAME = 'kory-test';
    env.USERPROFILE = isolatedHome;
    env.TMPDIR = join(isolatedHome, 'tmp');
    env.TEMP = join(isolatedHome, 'tmp');
    env.TMP = join(isolatedHome, 'tmp');
    env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
    env.XDG_DATA_HOME = join(isolatedHome, '.local', 'share');
    env.XDG_CACHE_HOME = join(isolatedHome, '.cache');
    env.APPDATA = join(isolatedHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(isolatedHome, 'AppData', 'Local');
    env.KORYPHAIOS_DATA_DIR = join(isolatedHome, '.koryphaios');
    env.KORYPHAIOS_SKILLS_HOME = join(isolatedHome, '.koryphaios', 'skills');
    env.KORYPHAIOS_WORKFLOWS_HOME = join(isolatedHome, '.koryphaios', 'workflows');
    env.PROJECT_ROOT = join(isolatedHome, 'project');
    env.LOG_DIR = join(isolatedHome, '.koryphaios', 'logs');
  }

  env.NODE_ENV = 'test';
  env.SESSION_TOKEN_SECRET = 'test_only_not_for_production_aaaaaaaaaa';
  env.KORYPHAIOS_KMS_PASSPHRASE = 'test_only_kms_passphrase_not_for_production';
  return env;
}

function gatherTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      gatherTestFiles(full, acc);
    } else if (entry.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  const testDbDir = mkdtempSync(join(tmpdir(), 'kory-test-'));
  const testHome = join(testDbDir, 'home');
  mkdirSync(join(testHome, 'tmp'), { recursive: true });
  mkdirSync(join(testHome, 'project'), { recursive: true });
  const env = createIsolatedTestEnvironment(process.env, testHome);
  let exitCode = 0;

  try {
    const searchRoots = [
      join(BACKEND_DIR, '__tests__'),
      join(BACKEND_DIR, 'src'),
      join(BACKEND_DIR, 'test'),
    ];

    const testFiles: string[] = [];
    for (const root of searchRoots) {
      try {
        gatherTestFiles(root, testFiles);
      } catch {
        // directory may not exist
      }
    }

    // Sort for deterministic ordering (matches `sort -z` in the old bash script).
    testFiles.sort();

    let testIndex = 0;
    for (const testFile of testFiles) {
      testIndex++;
      const display = relative(PROJECT_ROOT, testFile).split(sep).join('/');
      console.log(`Testing ${display}`);
      const dbUrl = `sqlite:${join(testDbDir, `${testIndex}.db`)}`;

      const result = spawnSync(
        process.execPath,
        [
          '--no-env-file',
          'test',
          '--timeout',
          String(BACKEND_TEST_TIMEOUT_MS),
          '--preload',
          './backend/src/__tests__/setup-db.ts',
          testFile,
        ],
        {
          cwd: PROJECT_ROOT,
          env: { ...env, DATABASE_URL: dbUrl },
          stdio: 'inherit',
        },
      );

      if (result.status !== 0) {
        exitCode = result.status ?? 1;
        // Keep going so the user sees all failures, not just the first.
      }
    }
  } finally {
    rmSync(testDbDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

if (import.meta.main) main();
