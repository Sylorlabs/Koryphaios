// Compat-hash resolution.
//
// The backend exposes a "bundle hash" on /api/health that the frontend compares
// against its own compile-time hash. Production builds pin the hash to the same
// value the desktop shell stamps in via KORYPHAIOS_FRONTEND_BUNDLE_HASH; in dev
// both sides fall back to 'dev' (or null), which the comparator treats as
// "skip the strong-coupling check".
//
// Resolution order (first non-empty wins):
//   1. process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH (set by Tauri spawn_embedded_backend)
//   2. <project-root>/compat-hash.json (written by scripts/write-compat-hash.ts)
//   3. null — no contract enforced.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';

type CompatHashFile = { hash?: string };

let cached: string | null | undefined = undefined;

export function resolveBundleHash(): string | null {
  if (cached !== undefined) return cached;

  const fromEnv = process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH?.trim();
  if (fromEnv && fromEnv !== 'dev' && fromEnv !== 'null') {
    cached = fromEnv;
    return cached;
  }

  const candidate = join(PROJECT_ROOT, 'compat-hash.json');
  if (existsSync(candidate)) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as CompatHashFile;
      const fromFile = parsed.hash?.trim();
      if (fromFile && fromFile !== 'dev') {
        cached = fromFile;
        return cached;
      }
    } catch {
      // ignore malformed file
    }
  }

  cached = null;
  return null;
}

/**
 * Returns true if a strong-coupling comparison is meaningful on this backend
 * instance, i.e. we actually have a pinned hash (production) versus a 'dev'/null
 * instance where mismatches are not enforced.
 */
export function isBundleHashEnforced(): boolean {
  const h = resolveBundleHash();
  return h !== null && h !== 'dev';
}
