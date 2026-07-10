/**
 * Project sync — packages a client's project for a host-side CLI sandbox.
 *
 * A CLI harness can only work on files it can see, so an agentic-remote turn
 * ships the client's project (filtered) to the host. To keep it cheap:
 *   - skip junk (node_modules, .git, build output, caches, binaries),
 *   - text files only, per-file and total size caps,
 *   - after the first turn, send only files changed since the last sync (delta),
 *     plus a list of files deleted since then.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ProjectSync, ProjectSyncFile } from '@koryphaios/shared';

// Directories never worth shipping — dependency trees, VCS, build artifacts.
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.svelte-kit',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.turbo',
  '.cache',
  'coverage',
  '.gradle',
  '.idea',
  '.vscode',
  'vendor',
  '.terraform',
  'Pods',
  'DerivedData',
  '.mypy_cache',
  '.ruff_cache',
]);

const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// Extensions we treat as binary/non-source and skip.
const BINARY_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'tiff',
  'svgz',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'webm',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'jar',
  'war',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'o',
  'a',
  'class',
  'pyc',
  'wasm',
  'sqlite',
  'db',
  'lock',
]);

const MAX_FILE_BYTES = 1_000_000; // 1 MB per file
const MAX_TOTAL_BYTES = 60_000_000; // 60 MB per sync

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Parse top-level .gitignore entries into simple name/dir matchers. Not a full
 *  gitignore implementation — covers the common `name/`, `name`, `*.ext` cases. */
async function loadGitignore(root: string): Promise<{ names: Set<string>; exts: Set<string> }> {
  const names = new Set<string>();
  const exts = new Set<string>();
  try {
    const raw = await readFile(join(root, '.gitignore'), 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      const cleaned = t.replace(/^\//, '').replace(/\/$/, '');
      if (cleaned.startsWith('*.')) exts.add(cleaned.slice(2).toLowerCase());
      else if (!cleaned.includes('/') && !cleaned.includes('*')) names.add(cleaned);
    }
  } catch {
    /* no .gitignore */
  }
  return { names, exts };
}

export interface ScannedFile {
  path: string; // POSIX relative
  content: string;
  mtimeMs: number;
}

/** Walk the project once, returning every eligible file with its mtime. */
export async function scanProject(root: string): Promise<ScannedFile[]> {
  const gi = await loadGitignore(root);
  const out: ScannedFile[] = [];
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= MAX_TOTAL_BYTES) return;
      const name = entry.name;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(name) || gi.names.has(name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (IGNORE_FILES.has(name) || gi.names.has(name)) continue;
        const e = ext(name);
        if (BINARY_EXT.has(e) || gi.exts.has(e)) continue;
        try {
          const info = await stat(full);
          if (info.size > MAX_FILE_BYTES) continue;
          if (total + info.size > MAX_TOTAL_BYTES) continue;
          const buf = await readFile(full);
          // Skip files that look binary (contain a NUL byte).
          if (buf.includes(0)) continue;
          total += info.size;
          out.push({
            path: relative(root, full).split(sep).join('/'),
            content: buf.toString('utf-8'),
            mtimeMs: info.mtimeMs,
          });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }

  await walk(root);
  return out;
}

/** Per-session record of what we last shipped, so we can compute deltas. */
export interface SyncState {
  /** relPath → mtimeMs at last sync. */
  sent: Map<string, number>;
}

export function newSyncState(): SyncState {
  return { sent: new Map() };
}

/** Build a ProjectSync from a fresh scan against prior state. First call (empty
 *  state) yields a full snapshot; later calls yield only changed + deleted. */
export function buildSync(scanned: ScannedFile[], state: SyncState): ProjectSync {
  const mode: 'full' | 'delta' = state.sent.size === 0 ? 'full' : 'delta';
  const files: ProjectSyncFile[] = [];
  const seen = new Set<string>();

  for (const f of scanned) {
    seen.add(f.path);
    const prev = state.sent.get(f.path);
    if (prev === undefined || prev !== f.mtimeMs) {
      files.push({ path: f.path, content: f.content });
    }
    state.sent.set(f.path, f.mtimeMs);
  }

  const deletes: string[] = [];
  for (const prevPath of [...state.sent.keys()]) {
    if (!seen.has(prevPath)) {
      deletes.push(prevPath);
      state.sent.delete(prevPath);
    }
  }

  return { mode, files, deletes };
}
