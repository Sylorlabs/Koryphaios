import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir } from '../security/fs-permissions';

const HOME_MANAGED_CLI_ROOT = resolve(homedir(), '.koryphaios');
const PROJECT_MANAGED_CLI_ROOT = resolve(PROJECT_ROOT, '.koryphaios');
const STALE_ATOMIC_WRITE_MS = 60 * 60_000;

export interface ManagedCliStorageOptions {
  /**
   * Dedicated Koryphaios-owned root for this write. Callers that use a custom
   * KORYPHAIOS_DATA_DIR must pass its `cli-homes` child here so validation
   * never depends on the backend process's ambient environment.
   */
  root?: string;
}

type ManagedWriteOptions = {
  encoding?: BufferEncoding | null;
};

function isContainedBy(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === '' ||
    (!isAbsolute(relation) &&
      relation !== '..' &&
      !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

function defaultManagedRoots(): string[] {
  return [...new Set([HOME_MANAGED_CLI_ROOT, PROJECT_MANAGED_CLI_ROOT])];
}

function resolveManagedRoot(path: string, options: ManagedCliStorageOptions): string {
  const target = resolve(path);
  if (options.root) {
    const explicitRoot = resolve(options.root);
    if (!isContainedBy(explicitRoot, target)) {
      throw new Error('Managed CLI storage escaped its explicit Koryphaios root');
    }
    return explicitRoot;
  }

  const root = defaultManagedRoots().find((candidate) => isContainedBy(candidate, target));
  if (!root) throw new Error('Managed CLI storage escaped the Koryphaios roots');
  return root;
}

function assertOwnedDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Managed CLI directory target is not a real directory');
  }
  const currentUid = process.getuid?.();
  if (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('Managed CLI directory has an unexpected owner');
  }
}

function assertPrivateRegularMetadata(metadata: Stats): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Managed CLI file target is not a regular file');
  }
  const currentUid = process.getuid?.();
  if (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('Managed CLI file has an unexpected owner');
  }
  if (process.platform !== 'win32' && metadata.nlink > 1) {
    throw new Error('Managed CLI file target has multiple hard links');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error('Managed CLI file mode is not private');
  }
}

/**
 * Create and heal every app-owned directory component to 0700. Each component
 * is checked before traversal, so an existing symlink cannot redirect writes
 * outside the selected managed root.
 */
export function ensureManagedCliDirectory(
  path: string,
  options: ManagedCliStorageOptions = {},
): string {
  const target = resolve(path);
  const root = resolveManagedRoot(target, options);
  ensureSecureDir(root);
  assertOwnedDirectory(root);

  const relation = relative(root, target);
  let current = root;
  if (relation) {
    for (const segment of relation.split(/[\\/]+/).filter(Boolean)) {
      current = resolve(current, segment);
      ensureSecureDir(current);
      assertOwnedDirectory(current);
    }
  }
  return target;
}

function assertSafeManagedFile(path: string, options: ManagedCliStorageOptions): string {
  const target = resolve(path);
  const root = resolveManagedRoot(target, options);
  ensureManagedCliDirectory(dirname(target), { root });
  if (!existsSync(target)) return target;

  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Managed CLI file target is not a regular file');
  }
  const currentUid = process.getuid?.();
  if (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error('Managed CLI file has an unexpected owner');
  }
  if (process.platform !== 'win32' && metadata.nlink > 1) {
    throw new Error('Managed CLI file target has multiple hard links');
  }
  return target;
}

/** Tighten a legacy managed file to 0600 without reading or rewriting it. */
export function healManagedCliFile(path: string, options: ManagedCliStorageOptions = {}): void {
  const target = assertSafeManagedFile(path, options);
  if (!existsSync(target)) return;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(target, constants.O_RDONLY | noFollow);
  try {
    fchmodSync(fd, 0o600);
    assertPrivateRegularMetadata(fstatSync(fd));
  } finally {
    closeSync(fd);
  }
  assertPrivateRegularMetadata(lstatSync(target));
}

function syncManagedDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const directoryOnly = constants.O_DIRECTORY ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWritePrefix(target: string): string {
  return `.${basename(target)}.kory-write-`;
}

function pruneStaleAtomicWrites(target: string, now = Date.now()): void {
  const parent = dirname(target);
  const prefix = atomicWritePrefix(target);
  const currentUid = process.getuid?.();
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = resolve(parent, entry);
    try {
      const metadata = lstatSync(candidate);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        (process.platform !== 'win32' && currentUid !== undefined && metadata.uid !== currentUid) ||
        now - metadata.mtimeMs < STALE_ATOMIC_WRITE_MS
      ) {
        continue;
      }
      unlinkSync(candidate);
    } catch {
      // Another writer or cleanup pass may already own this candidate.
    }
  }
}

/**
 * Atomically replace an app-owned CLI config/rules file.
 *
 * Content is first written to an exclusive, no-follow file in the destination
 * directory, then fchmodded, validated, fsynced, and renamed. Any failure
 * before rename removes the staging file and leaves the previous target intact.
 */
export function writeManagedCliFile(
  path: string,
  content: string | NodeJS.ArrayBufferView,
  options: ManagedWriteOptions = {},
  storage: ManagedCliStorageOptions = {},
): void {
  const target = assertSafeManagedFile(path, storage);
  const parent = dirname(target);
  pruneStaleAtomicWrites(target);
  const temp = resolve(
    parent,
    `${atomicWritePrefix(target)}${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number | null = null;
  let renamed = false;

  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(fd, content, options);
    fchmodSync(fd, 0o600);
    assertPrivateRegularMetadata(fstatSync(fd));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    renameSync(temp, target);
    renamed = true;
    assertPrivateRegularMetadata(lstatSync(target));
    syncManagedDirectory(parent);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The original error is authoritative.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Preserve the authoritative write error if cleanup also fails.
      }
    }
  }
}

export const MANAGED_CLI_ROOTS_FOR_TESTING = Object.freeze({
  home: HOME_MANAGED_CLI_ROOT,
  project: PROJECT_MANAGED_CLI_ROOT,
});
