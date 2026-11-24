import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  canonicalizePath,
  hasHardLinks,
  hasPosixPermissionBits,
  hasUnexpectedMode,
  hasUnexpectedOwner,
  isContainedBy,
} from '../backend/src/runtime/platform';

export interface NativeStageFileReference {
  path: string;
  sha256: string;
  bytes: number;
}

function refuse(): never {
  throw new Error('Native reviewer evidence archive unavailable (details redacted).');
}

function privateDirectory(directory: string): string {
  if (
    !hasPosixPermissionBits() ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    /[\u0000-\u001f]/u.test(directory)
  )
    refuse();
  // Reject every literal symlink component before resolving canonical identity.
  let component = parse(directory).root;
  for (const part of relative(component, directory).split(sep).filter(Boolean)) {
    component = join(component, part);
    const metadata = lstatSync(component);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) refuse();
  }
  const canonical = canonicalizePath(directory);
  const metadata = lstatSync(directory);
  if (canonical !== directory || hasUnexpectedOwner(metadata) || hasUnexpectedMode(metadata, 0o700))
    refuse();
  return canonical;
}

export function createNativeArchiveDirectory(runRoot: string): string {
  const root = privateDirectory(runRoot);
  const directory = privateDirectory(mkdtempSync(join(root, 'native-attempt-')));
  if (directory === root || !isContainedBy(root, directory)) refuse();
  return directory;
}

export function nativeArchiveDirectory(
  directory: string,
  privateHome: string,
  projectRoot: string,
): string {
  const canonical = privateDirectory(directory);
  if (
    isContainedBy(privateHome, canonical) ||
    isContainedBy(canonical, privateHome) ||
    isContainedBy(projectRoot, canonical) ||
    isContainedBy(canonical, projectRoot)
  )
    refuse();
  return canonical;
}

type NativeArchiveName =
  | 'native-cli-events.jsonl'
  | 'native-kernel-profile.sb'
  | 'reviewer-events.json'
  | 'review-task.prompt.txt';

export function archiveNativeStageBytes(
  directory: string,
  basename: NativeArchiveName,
  bytes: Buffer,
  maximumBytes: number,
): NativeStageFileReference {
  if (!bytes.length || bytes.length > maximumBytes) refuse();
  privateDirectory(directory);
  const path = join(directory, basename);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      hasUnexpectedOwner(metadata) ||
      hasUnexpectedMode(metadata, 0o600) ||
      hasHardLinks(metadata)
    )
      refuse();
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const completed = fstatSync(fd);
    const literal = lstatSync(path);
    if (
      completed.size !== bytes.length ||
      hasHardLinks(completed) ||
      literal.isSymbolicLink() ||
      literal.ino !== completed.ino ||
      literal.dev !== completed.dev
    )
      refuse();
    privateDirectory(directory);
  } finally {
    closeSync(fd);
  }
  const reference = {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  readNativeStageReference(reference, directory, maximumBytes);
  return reference;
}

// A size check followed by readFileSync(fd) is not bounded: concurrent growth
// can consume arbitrary bytes before rejection. Read only the initial size plus
// one byte, then reject growth, truncation, or metadata mutation.
export function readBoundedNativeDescriptor(fd: number, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) refuse();
  const before = fstatSync(fd);
  if (
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > maximumBytes
  )
    refuse();
  const data = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < data.length) {
    const count = readSync(fd, data, offset, data.length - offset, offset);
    if (!count) break;
    offset += count;
  }
  const after = fstatSync(fd);
  if (
    offset !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    refuse();
  return data.subarray(0, offset);
}

export function readNativeStageReference(
  value: unknown,
  directory: string,
  maximumBytes: number,
): {
  reference: NativeStageFileReference;
  data: Buffer;
} {
  privateDirectory(directory);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const ref = value as Record<string, unknown>;
  if (
    Object.keys(ref).sort().join(',') !== 'bytes,path,sha256' ||
    typeof ref.path !== 'string' ||
    !isAbsolute(ref.path) ||
    resolve(ref.path) !== ref.path ||
    /[\u0000-\u001f]/u.test(ref.path) ||
    typeof ref.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(ref.sha256) ||
    !Number.isSafeInteger(ref.bytes) ||
    (ref.bytes as number) <= 0 ||
    (ref.bytes as number) > maximumBytes ||
    !isContainedBy(directory, ref.path) ||
    relative(directory, ref.path).includes(sep) ||
    canonicalizePath(ref.path) !== ref.path
  )
    refuse();
  const metadata = lstatSync(ref.path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    hasHardLinks(metadata) ||
    hasUnexpectedOwner(metadata) ||
    hasUnexpectedMode(metadata, 0o600)
  )
    refuse();
  // Nonblocking open also refuses a FIFO swapped in after lstat without hanging.
  const fd = openSync(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.ino !== metadata.ino ||
      before.dev !== metadata.dev ||
      before.size !== ref.bytes ||
      hasHardLinks(before) ||
      hasUnexpectedOwner(before) ||
      hasUnexpectedMode(before, 0o600)
    )
      refuse();
    const data = readBoundedNativeDescriptor(fd, ref.bytes as number);
    const after = fstatSync(fd);
    const literal = lstatSync(ref.path);
    if (
      data.length !== ref.bytes ||
      createHash('sha256').update(data).digest('hex') !== ref.sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      hasHardLinks(after) ||
      hasUnexpectedOwner(after) ||
      hasUnexpectedMode(after, 0o600) ||
      literal.isSymbolicLink() ||
      literal.ino !== after.ino ||
      literal.dev !== after.dev ||
      literal.size !== before.size ||
      literal.mtimeMs !== before.mtimeMs ||
      literal.ctimeMs !== before.ctimeMs
    )
      refuse();
    privateDirectory(directory);
    return { reference: ref as unknown as NativeStageFileReference, data };
  } finally {
    closeSync(fd);
  }
}
