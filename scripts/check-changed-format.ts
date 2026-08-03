#!/usr/bin/env bun
/**
 * Cross-platform changed-file format checker.
 *
 * Runs `prettier --check` on TS/JS/JSON/MD files changed since the base commit,
 * matching the scope of the canonical `format` script (svelte is intentionally
 * excluded — svelte-check covers it). Also runs `git diff --check` to catch
 * whitespace errors.
 *
 * Replaces the bash-only `check-changed-format.sh` so `bun run format:changed`
 * works on macOS, Windows, and Linux without requiring bash.
 */

import { execSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dir, '..');
const SPAWN_SHELL = process.platform === 'win32';

function git(args: string[]): string {
  return execSync(`git ${args.join(' ')}`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: SPAWN_SHELL,
  }).trim();
}

function main() {
  const baseArg = process.argv[2] ?? '';
  let base = baseArg;
  if (!base || /^0+$/.test(base)) {
    base = '';
  } else {
    // Verify the base commit exists
    try {
      execSync(`git cat-file -e ${base}^{commit}`, {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
        shell: SPAWN_SHELL,
      });
    } catch {
      base = '';
    }
  }
  if (!base) {
    base = git(['rev-parse', 'HEAD^']);
  }

  // Get changed files matching the format script's scope.
  const raw = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    base,
    'HEAD',
    '--',
    '*.ts',
    '*.tsx',
    '*.js',
    '*.jsx',
    '*.json',
    '*.md',
  ]);

  const excludeRegex = /^(frontend\/build\/|test-results\/|playwright-report\/)/;
  const files = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !excludeRegex.test(l));

  if (files.length > 0) {
    const result = spawnSync('bunx', ['prettier', '--check', ...files], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: SPAWN_SHELL,
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  // Check for whitespace errors (trailing whitespace, conflict markers).
  const diffCheck = spawnSync('git', ['diff', '--check', base, 'HEAD'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  if (diffCheck.status !== 0) {
    process.exit(diffCheck.status ?? 1);
  }
}

main();
