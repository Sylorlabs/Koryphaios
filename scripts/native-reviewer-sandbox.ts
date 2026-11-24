import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  canonicalizePath,
  hasHardLinks,
  hasUnexpectedMode,
  hasUnexpectedOwner,
  isContainedBy,
  isMac,
} from '../backend/src/runtime/platform';

import { readBoundedNativeDescriptor } from './native-reviewer-archive';

export const NATIVE_MAC_STAGE_MODE = 'macos-private-roots';
const MAC_PRIVATE_READ_ROOTS = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp'];

function refuse(): never {
  throw new Error('Native reviewer macOS private-root stage unavailable (details redacted).');
}

// Pure builder: callers must canonicalize existing paths first. Reads needed by
// the dynamic linker stay broad; only these explicit private roots are denied.
// This is not a universal file allowlist or a replacement for the general jail.
export function nativeMacStageProfile(
  privateRoot: string,
  readDenyRoots: readonly string[],
): string {
  for (const root of [privateRoot, ...readDenyRoots]) {
    if (!isAbsolute(root) || root === '/' || /[\u0000-\u001f]/u.test(root)) refuse();
  }
  if (
    !readDenyRoots.length ||
    new Set(readDenyRoots).size !== readDenyRoots.length ||
    readDenyRoots.some((root) => root === privateRoot || isContainedBy(privateRoot, root))
  )
    refuse();
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow mach*)',
    '(allow iokit*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(allow file-ioctl)',
    '(allow ipc-posix-sem*)',
    '(allow ipc-posix-shm*)',
    '(allow network*)',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(privateRoot)}))`,
    ...readDenyRoots.map(
      (root) =>
        `(deny file-read* (require-all (subpath ${JSON.stringify(root)}) (require-not (subpath ${JSON.stringify(privateRoot)}))))`,
    ),
  ].join('\n');
}

export interface NativeMacReviewerSandbox {
  mode: typeof NATIVE_MAC_STAGE_MODE;
  privateRoot: string;
  readDenyRoots: string[];
  protectedRoots: string[];
  profileSha256: string;
  profile: string;
  readProfileBytes(): Buffer;
  command(binary: string, args: readonly string[]): { binary: string; args: string[] };
  cleanup(): void;
}

export function createNativeMacReviewerSandbox(
  privateHome: string,
  protectedPaths: readonly string[],
): NativeMacReviewerSandbox {
  if (!isMac()) refuse();
  const privateRoot = canonicalizePath(privateHome);
  if (!statSync(privateRoot).isDirectory()) refuse();
  const protectedRoots = [...new Set(protectedPaths.map((path) => canonicalizePath(path)))];
  if (
    protectedRoots.some(
      (root) => isContainedBy(root, privateRoot) || isContainedBy(privateRoot, root),
    )
  )
    refuse();
  const readDenyRoots = [...new Set(MAC_PRIVATE_READ_ROOTS.map((path) => canonicalizePath(path)))];
  // Source/evaluation/data/credential paths outside the standard private roots
  // are explicitly denied too; no uncaptured protected path is silently admitted.
  for (const root of protectedRoots) {
    if (!readDenyRoots.some((denied) => isContainedBy(denied, root))) readDenyRoots.push(root);
  }
  const profile = nativeMacStageProfile(privateRoot, readDenyRoots);
  const sandboxExec = canonicalizePath('/usr/bin/sandbox-exec');
  accessSync(sandboxExec, constants.X_OK);
  const profileDirectory = mkdtempSync(
    join(canonicalizePath(tmpdir()), 'kory-native-stage-policy-'),
  );
  const profilePath = join(profileDirectory, 'profile.sb');
  try {
    writeFileSync(profilePath, profile, { flag: 'wx', mode: 0o600 });
    const readProfileBytes = (): Buffer => {
      const directory = lstatSync(profileDirectory);
      const literal = lstatSync(profilePath);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        hasUnexpectedOwner(directory) ||
        hasUnexpectedMode(directory, 0o700) ||
        canonicalizePath(profileDirectory) !== profileDirectory ||
        !literal.isFile() ||
        literal.isSymbolicLink()
      )
        refuse();
      const fd = openSync(
        profilePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = fstatSync(fd);
        if (
          !before.isFile() ||
          before.ino !== literal.ino ||
          before.dev !== literal.dev ||
          hasHardLinks(before) ||
          hasUnexpectedOwner(before) ||
          hasUnexpectedMode(before, 0o600) ||
          before.size !== Buffer.byteLength(profile)
        )
          refuse();
        const bytes = readBoundedNativeDescriptor(fd, Buffer.byteLength(profile));
        const after = fstatSync(fd);
        const completed = lstatSync(profilePath);
        const directoryAfter = lstatSync(profileDirectory);
        if (
          !directoryAfter.isDirectory() ||
          directoryAfter.isSymbolicLink() ||
          hasUnexpectedOwner(directoryAfter) ||
          hasUnexpectedMode(directoryAfter, 0o700) ||
          directoryAfter.dev !== directory.dev ||
          directoryAfter.ino !== directory.ino ||
          canonicalizePath(profileDirectory) !== profileDirectory ||
          !bytes.equals(Buffer.from(profile)) ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          hasHardLinks(after) ||
          hasUnexpectedOwner(after) ||
          hasUnexpectedMode(after, 0o600) ||
          completed.isSymbolicLink() ||
          completed.ino !== after.ino ||
          completed.dev !== after.dev ||
          completed.size !== before.size ||
          completed.mtimeMs !== before.mtimeMs ||
          completed.ctimeMs !== before.ctimeMs
        )
          refuse();
        return bytes;
      } finally {
        closeSync(fd);
      }
    };
    readProfileBytes();
    return {
      mode: NATIVE_MAC_STAGE_MODE,
      privateRoot,
      readDenyRoots,
      protectedRoots,
      profileSha256: createHash('sha256').update(profile).digest('hex'),
      profile,
      readProfileBytes,
      command(binary, args) {
        readProfileBytes();
        if (canonicalizePath(privateHome) !== privateRoot) refuse();
        const executable = canonicalizePath(binary);
        if (
          readDenyRoots.some((root) => isContainedBy(root, executable)) &&
          !isContainedBy(privateRoot, executable)
        )
          refuse();
        return { binary: sandboxExec, args: ['-f', profilePath, executable, ...args] };
      },
      cleanup: () => rmSync(profileDirectory, { recursive: true, force: true }),
    };
  } catch {
    rmSync(profileDirectory, { recursive: true, force: true });
    refuse();
  }
}
