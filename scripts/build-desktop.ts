#!/usr/bin/env bun
/**
 * Cross-platform desktop build orchestrator.
 *
 * Replaces the old `cd desktop && bun run build` (which used shell-specific
 * `cd` and didn't prepare the embedded backend payload or handle the updater
 * signing key). This script:
 *
 *   1. Writes the compat hash (frontend + backend + desktop pin together).
 *   2. Builds the embedded backend payload for the host target.
 *   3. Patches `tauri.conf.json` to disable `createUpdaterArtifacts` when
 *      `TAURI_SIGNING_PRIVATE_KEY` is not set, so local builds don't fail.
 *      The original config is restored after the build.
 *   4. Runs `tauri build` (which triggers beforeBuildCommand to build the
 *      frontend).
 *
 * Works on macOS, Windows, and Linux without bash.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dir, '..');
const DESKTOP_DIR = join(PROJECT_ROOT, 'desktop');
const TAURI_CONF = join(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json');

const SPAWN_SHELL = process.platform === 'win32';

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> } = { cwd: PROJECT_ROOT },
): number {
  console.log(`\n[build-desktop] ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
  return result.status ?? 0;
}

function patchTauriConfig(disableUpdater: boolean): string {
  const original = readFileSync(TAURI_CONF, 'utf-8');
  if (!disableUpdater) return original;

  const config = JSON.parse(original);
  if (config.bundle?.createUpdaterArtifacts === true) {
    config.bundle.createUpdaterArtifacts = false;
    const patched = JSON.stringify(config, null, 2) + '\n';
    writeFileSync(TAURI_CONF, patched);
    console.log(
      '[build-desktop] Temporarily disabled createUpdaterArtifacts (no TAURI_SIGNING_PRIVATE_KEY set)',
    );
  }
  return original;
}

function main() {
  const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;

  // 1. Write compat hash
  console.log('[build-desktop] Writing compat hash...');
  run('bun', ['run', 'scripts/write-compat-hash.ts']);

  // 2. Build embedded backend payload for the host target
  console.log('[build-desktop] Building embedded backend payload...');
  run('bun', ['run', 'scripts/build-embedded-backend.ts']);

  // 3. Patch tauri.conf.json if no signing key
  const originalConfig = patchTauriConfig(!hasSigningKey);

  try {
    // 4. Run tauri build (beforeBuildCommand builds the frontend)
    console.log('[build-desktop] Running tauri build...');
    const tauriArgs = ['run', 'tauri', 'build'];

    // Forward extra args (e.g., --target) to tauri
    const extraArgs = process.argv.slice(2);
    if (extraArgs.length > 0) {
      tauriArgs.push(...extraArgs);
    }

    run('bun', tauriArgs, { cwd: DESKTOP_DIR });
  } finally {
    // Restore original config if it was patched
    if (!hasSigningKey && readFileSync(TAURI_CONF, 'utf-8') !== originalConfig) {
      writeFileSync(TAURI_CONF, originalConfig);
      console.log('[build-desktop] Restored original tauri.conf.json');
    }
  }

  console.log('\n[build-desktop] Build complete!');
}

main();
