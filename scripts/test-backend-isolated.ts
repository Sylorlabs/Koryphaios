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

import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dir, '..');
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');

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
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    SESSION_TOKEN_SECRET:
      process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa',
  };

  const testDbDir = mkdtempSync(join(tmpdir(), 'kory-test-'));
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
        ['test', '--preload', './backend/test/setup-db.ts', testFile],
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

main();
