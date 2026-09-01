#!/usr/bin/env bun
/**
 * Cross-platform frontend build script for Tauri's beforeBuildCommand.
 *
 * Tauri runs `beforeBuildCommand` from the directory where `tauri build` is
 * invoked (i.e., `desktop/`). The old config used `cd ../frontend && bun run
 * build`, which relies on shell-specific `cd` and doesn't work on Windows
 * cmd.exe. This script resolves the frontend directory relative to itself and
 * runs the build there, working on all platforms.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND_DIR = join(import.meta.dir, '..', '..', 'frontend');
export const PACKAGED_FRONTEND_DIST = join(FRONTEND_DIR, 'build', 'client');

/**
 * A regular frontend build uses svelte-adapter-bun. Its `build/client`
 * directory contains browser assets, while `build/handler.js` owns the HTML
 * response. Tauri cannot execute that server handler: `frontendDist` loads
 * `build/client` on Tauri's app origin, and the same directory is bundled as
 * the embedded Kory backend's optional static resource. Always force the
 * adapter-static branch for this packaging entry point.
 */
export function createPackagedFrontendEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...source,
    BUILD_MODE: 'static',
    NODE_ENV: 'production',
  };
}

/** Fail the desktop build before Tauri can package an asset-only directory. */
export function assertPackagedFrontendArtifact(
  frontendDist: string = PACKAGED_FRONTEND_DIST,
): void {
  const entry = join(frontendDist, 'index.html');
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(
      `Packaged frontend is missing ${entry}. ` +
        'The Tauri build must use the Svelte static adapter (BUILD_MODE=static).',
    );
  }
}

export function buildPackagedFrontend(): number {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: createPackagedFrontendEnvironment(),
  });

  if (result.status !== 0) return result.status ?? 1;

  try {
    assertPackagedFrontendArtifact();
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(buildPackagedFrontend());
}
