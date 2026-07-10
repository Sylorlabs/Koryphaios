#!/usr/bin/env bun
/**
 * Write a build-coherent compatibility hash to compat-hash.json at the repo root.
 *
 * The hash identifies a coherent build of (desktop shell + frontend + backend).
 * Three places read the SAME file at build time so they pin together:
 *
 *   1. frontend/vite.config.ts           -> __KORYPHAIOS_FRONTEND_BUNDLE_HASH__
 *   2. backend/src/config/compat.ts       -> /api/health compat.bundleHash
 *   3. desktop/src-tauri/build.rs         -> embedded const used when spawning
 *                                            the embedded backend to set
 *                                            KORYPHAIOS_FRONTEND_BUNDLE_HASH env
 *
 * If the frontend build doesn't match the backend's reported hash, the frontend
 * backend-health sentinel halts normal operation via the BackendDownOverlay —
 * no silent version skew can ever run in production.
 *
 * Source of the hash:
 *   - In a git checkout: the short HEAD SHA (stable per commit; changes when
 *     the repo state changes).
 *   - Fallback: 'dev'. Both sides treat 'dev' as "skip the strong check", so
 *     dev builds don't false-trip the overlay.
 *
 * Run before any release build (the build:desktop pipeline does this for you).
 * The file is gitignored — it is purely a build artifact.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const OUT_PATH = resolve(PROJECT_ROOT, 'compat-hash.json');

function resolveHash(): string {
  // Try git HEAD first.
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    if (sha) return sha;
  } catch {
    // Not in a git repo or git missing — fall through.
  }
  return 'dev';
}

function main() {
  const hash = resolveHash();
  if (!existsSync(PROJECT_ROOT)) {
    mkdirSync(PROJECT_ROOT, { recursive: true });
  }
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ hash, generatedAt: new Date().toISOString() }, null, 2) + '\n',
  );
  console.log(`[compat-hash] wrote ${OUT_PATH} (hash=${hash})`);
}

main();
