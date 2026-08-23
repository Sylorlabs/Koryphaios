#!/usr/bin/env bun
/**
 * Cross-platform changed-file format checker.
 *
 * Runs `prettier --check` on supported tracked and untracked source files changed
 * since the base commit. The comparison includes the working tree, not only
 * committed changes, and includes Svelte/CSS product UI files. Also runs
 * `git diff --check` to catch whitespace errors.
 *
 * Replaces the bash-only `check-changed-format.sh` so `bun run format:changed`
 * works on macOS, Windows, and Linux without requiring bash.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dir, '..');
const SPAWN_SHELL = process.platform === 'win32';
const FORMATTABLE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const EXCLUDED_PATH = /^(frontend\/build\/|test-results\/|playwright-report\/)/;

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function gitSucceeds(args: string[]): boolean {
  return (
    spawnSync('git', args, {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
    }).status === 0
  );
}

function zeroSeparated(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function printFormattingPatch(files: string[]): void {
  if (!process.env.CI || files.length === 0) return;
  const write = spawnSync('bunx', ['prettier', '--write', '--ignore-unknown', ...files], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  if (write.status !== 0) return;

  const patch = git(['diff', '--', ...files]);
  if (patch.trim()) {
    console.error('\n--- Prettier patch (apply this diff) ---\n');
    console.error(patch);
    console.error('--- End Prettier patch ---\n');
  }
}

function main() {
  const baseArg = process.argv[2] ?? process.env['KORYPHAIOS_FORMAT_BASE'] ?? '';
  let base = baseArg;
  if (!base || /^0+$/.test(base)) {
    base = '';
  } else {
    if (!gitSucceeds(['cat-file', '-e', `${base}^{commit}`])) base = '';
  }
  if (!base) {
    base = gitSucceeds(['rev-parse', '--verify', 'HEAD^'])
      ? git(['rev-parse', 'HEAD^']).trim()
      : git(['rev-parse', 'HEAD']).trim();
  }

  const changed = zeroSeparated(
    git(['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--']),
  );
  const untracked = zeroSeparated(git(['ls-files', '--others', '--exclude-standard', '-z']));
  const files = [...new Set([...changed, ...untracked])]
    .filter((file) => FORMATTABLE_EXTENSIONS.has(extname(file).toLowerCase()))
    .filter((file) => !EXCLUDED_PATH.test(file) && existsSync(join(PROJECT_ROOT, file)))
    .sort((left, right) => left.localeCompare(right));

  if (files.length > 0) {
    const result = spawnSync('bunx', ['prettier', '--check', '--ignore-unknown', ...files], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: SPAWN_SHELL,
    });
    if (result.status !== 0) {
      printFormattingPatch(files);
      process.exit(result.status ?? 1);
    }
  }

  // Check for whitespace errors (trailing whitespace, conflict markers).
  const diffCheck = spawnSync('git', ['diff', '--check', base, '--'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  if (diffCheck.status !== 0) {
    process.exit(diffCheck.status ?? 1);
  }
}

main();
