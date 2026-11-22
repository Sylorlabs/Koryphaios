#!/usr/bin/env bun
/**
 * Tauri `beforeBuildCommand`: every `tauri build` packages a coherent payload.
 *
 * The shell bundles three build artifacts — compat-hash.json, the embedded
 * backend payload, and the static frontend. Nothing inside `tauri build`
 * itself rebuilds them, so without this hook a package silently ships the
 * previous backend against a fresh frontend (stale routes, compat skew).
 *
 * Two modes:
 *
 *   - Local build (default): writes the compat hash first (both payload
 *     builds read it), compiles the embedded backend for the host target,
 *     then builds the packaged frontend.
 *   - `KORY_EMBEDDED_BACKEND=prebuilt`: a target-matched payload already
 *     exists in desktop/src-tauri/embedded-backend (CI artifact handoff or
 *     scripts/build-desktop.ts). Only the frontend is rebuilt — the exact
 *     behavior of the previous beforeBuildCommand.
 *
 * A cross-target `tauri build --target X` cannot compile the backend payload
 * locally; it must supply the payload and opt into prebuilt mode.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildEmbeddedBackend, detectHostTarget } from '../../scripts/build-embedded-backend';
import { buildPackagedFrontend } from './build-frontend';

const PROJECT_ROOT = join(import.meta.dir, '..', '..');
const SPAWN_SHELL = process.platform === 'win32';

export type BeforeBuildStep = 'compat-hash' | 'embedded-backend' | 'packaged-frontend';

export interface BeforeBuildPlan {
  mode: 'local' | 'prebuilt';
  steps: BeforeBuildStep[];
}

/** Decide what this build must (re)produce before Tauri bundles it. */
export function planBeforeBuild(
  env: Pick<NodeJS.ProcessEnv, 'KORY_EMBEDDED_BACKEND' | 'TAURI_ENV_TARGET_TRIPLE'> = process.env,
  hostTarget: string = detectHostTarget().rustTarget,
): BeforeBuildPlan {
  if (env.KORY_EMBEDDED_BACKEND === 'prebuilt') {
    return { mode: 'prebuilt', steps: ['packaged-frontend'] };
  }
  if (env.TAURI_ENV_TARGET_TRIPLE && env.TAURI_ENV_TARGET_TRIPLE !== hostTarget) {
    throw new Error(
      `[before-build] Cannot compile the embedded backend for ${env.TAURI_ENV_TARGET_TRIPLE} ` +
        `on a ${hostTarget} host. Cross-target builds must supply the payload in ` +
        'desktop/src-tauri/embedded-backend and rerun with KORY_EMBEDDED_BACKEND=prebuilt.',
    );
  }
  return { mode: 'local', steps: ['compat-hash', 'embedded-backend', 'packaged-frontend'] };
}

function writeCompatHash(): void {
  const result = spawnSync('bun', ['run', 'scripts/write-compat-hash.ts'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  if (result.status !== 0) {
    throw new Error(`[before-build] write-compat-hash.ts exited with code ${result.status}`);
  }
}

async function runPlan(plan: BeforeBuildPlan): Promise<void> {
  for (const step of plan.steps) {
    switch (step) {
      case 'compat-hash':
        writeCompatHash();
        break;
      case 'embedded-backend':
        await buildEmbeddedBackend();
        break;
      case 'packaged-frontend': {
        const status = buildPackagedFrontend();
        if (status !== 0) {
          throw new Error(`[before-build] packaged frontend build exited with code ${status}`);
        }
        break;
      }
    }
  }
}

if (import.meta.main) {
  try {
    await runPlan(planBeforeBuild());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
