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
 *   - In a git checkout: a SHA-256 digest of the actual tracked and
 *     non-ignored worktree files. This is deliberately content-based rather
 *     than HEAD-based: a local build made after an uncommitted edit must not
 *     claim to be the old commit.
 *   - Fallback: 'dev'. Both sides treat 'dev' as "skip the strong check", so
 *     dev builds don't false-trip the overlay.
 *
 * Release builds pass --release (the build:desktop pipeline does this for
 * you). Release mode fails closed when git reports modified, deleted, or
 * untracked source. A clean checkout is required for an artifact to be
 * attributable to a commit.
 * The file is gitignored — it is purely a build artifact.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const OUT_PATH = resolve(PROJECT_ROOT, 'compat-hash.json');

export type HashOptions = {
  projectRoot?: string;
  requireClean?: boolean;
};

export type GitSnapshot = {
  commit: string | null;
  dirtyEntries: string[];
  sourceDigest: string;
};

function gitOutput(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
  });
}

function listWorktreeFiles(projectRoot: string): string[] {
  const output = gitOutput(projectRoot, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  return output
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function sourceDigest(projectRoot: string, files: readonly string[]): string {
  const digest = createHash('sha256');
  for (const relativePath of files) {
    const absolutePath = resolve(projectRoot, relativePath);
    digest.update(relativePath);
    digest.update('\0');

    // A deleted tracked file still belongs to the worktree's source identity.
    // Include an explicit tombstone instead of silently falling back to HEAD.
    if (!existsSync(absolutePath)) {
      digest.update('<deleted>');
      digest.update('\0');
      continue;
    }

    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      digest.update('<symlink>');
      digest.update(readFileSync(absolutePath));
    } else {
      digest.update(readFileSync(absolutePath));
    }
    digest.update('\0');
  }
  return digest.digest('hex').slice(0, 16);
}

export function inspectGitSnapshot(projectRoot = PROJECT_ROOT): GitSnapshot | null {
  try {
    const commit = gitOutput(projectRoot, ['rev-parse', '--verify', 'HEAD']).trim() || null;
    const dirtyStatus = gitOutput(projectRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]).trimEnd();
    const dirtyEntries = dirtyStatus ? dirtyStatus.split('\n') : [];
    const files = listWorktreeFiles(projectRoot);
    return { commit, dirtyEntries, sourceDigest: sourceDigest(projectRoot, files) };
  } catch {
    // Not in a git repo or git missing — fall through to the dev sentinel.
    return null;
  }
}

export function resolveHash(options: HashOptions = {}): {
  hash: string;
  commit: string | null;
  sourceDigest: string | null;
  dirtyEntries: string[];
} {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const requireClean = options.requireClean ?? process.argv.includes('--release');
  const snapshot = inspectGitSnapshot(projectRoot);

  if (!snapshot) {
    if (requireClean) {
      throw new Error(
        '[compat-hash] Refusing release build: source directory is not a git checkout with a readable HEAD.',
      );
    }
    return { hash: 'dev', commit: null, sourceDigest: null, dirtyEntries: [] };
  }

  if (requireClean && snapshot.dirtyEntries.length > 0) {
    throw new Error(
      '[compat-hash] Refusing release build from a dirty checkout. Commit or remove these entries first:\n' +
        snapshot.dirtyEntries.join('\n'),
    );
  }

  return {
    hash: snapshot.sourceDigest,
    commit: snapshot.commit,
    sourceDigest: snapshot.sourceDigest,
    dirtyEntries: snapshot.dirtyEntries,
  };
}

function main() {
  const result = resolveHash();
  if (!existsSync(PROJECT_ROOT)) mkdirSync(PROJECT_ROOT, { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        hash: result.hash,
        sourceDigest: result.sourceDigest,
        commit: result.commit,
        dirty: result.dirtyEntries.length > 0,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `[compat-hash] wrote ${OUT_PATH} (hash=${result.hash}, commit=${result.commit ?? 'dev'}, dirty=${result.dirtyEntries.length > 0})`,
  );
}

if (import.meta.main) main();
