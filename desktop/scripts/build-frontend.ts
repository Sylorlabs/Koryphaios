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
import { join } from 'node:path';

const FRONTEND_DIR = join(import.meta.dir, '..', '..', 'frontend');

const result = spawnSync('bun', ['run', 'build'], {
  cwd: FRONTEND_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    BUILD_MODE: process.env.BUILD_MODE ?? 'static',
    NODE_ENV: 'production',
  },
});

process.exit(result.status ?? 1);
