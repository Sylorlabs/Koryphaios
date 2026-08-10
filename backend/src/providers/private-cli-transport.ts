import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';

const PRIVATE_ROOT = join(
  tmpdir(),
  `koryphaios-private-cli-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
);
const STALE_ARTIFACT_AGE_MS = 60 * 60 * 1000;
const MAX_PRIVATE_TEXT_BYTES = 16 * 1024 * 1024;
const OWNER_FILE = '.owner.json';

interface PrivateArtifactOwner {
  pid: number;
  processStartId: string | null;
}

export interface PrivateCliArtifact {
  readonly directory: string;
  readonly path: string;
  cleanup(): void;
}

function safeKind(kind: string): string {
  const normalized = kind.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 40) || 'artifact';
}

function ensurePrivateRoot(): void {
  mkdirSync(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const stat = lstatSync(PRIVATE_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Koryphaios private CLI storage is not a directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Koryphaios private CLI storage has an unexpected owner');
  }
  chmodSync(PRIVATE_ROOT, 0o700);
}

function processStartId(pid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // Linux /proc stat field 22 is the process start time in clock ticks. The
    // command field may contain spaces, so parse only after its final `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return tail[19] ?? null;
  } catch {
    return null;
  }
}

function processIsSameOwner(owner: PrivateArtifactOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  const liveStart = processStartId(owner.pid);
  // On platforms without a process-start identifier, a live PID is treated as
  // active. This may retain stale files after PID reuse, but never deletes a
  // live provider's private transport.
  return !owner.processStartId || !liveStart || owner.processStartId === liveStart;
}

function readPrivateArtifactOwner(directory: string): PrivateArtifactOwner | null {
  try {
    const path = join(directory, OWNER_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrivateArtifactOwner>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (parsed.processStartId !== null && typeof parsed.processStartId !== 'string') return null;
    return parsed as PrivateArtifactOwner;
  } catch {
    return null;
  }
}

/** Remove only old, Koryphaios-owned run directories. This runs before a new
 * artifact is created so files left by a process crash do not persist forever. */
export function pruneStalePrivateCliArtifacts(now = Date.now()): void {
  try {
    ensurePrivateRoot();
    for (const name of readdirSync(PRIVATE_ROOT)) {
      if (!name.startsWith('run-')) continue;
      const candidate = join(PRIVATE_ROOT, name);
      try {
        const stat = lstatSync(candidate);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
        if (now - stat.mtimeMs <= STALE_ARTIFACT_AGE_MS) continue;
        const owner = readPrivateArtifactOwner(candidate);
        // Legacy/unowned directories are deliberately retained: age alone is
        // never proof that a long-running provider no longer owns the files.
        if (!owner || processIsSameOwner(owner)) continue;
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // A concurrent provider turn may have removed it already.
      }
    }
  } catch {
    // Creation below remains fail-closed and will report a stable error.
  }
}

/** Create a private, single-run file for prompt/system/config transport.
 * The directory is 0700 and the file is 0600. The caller must retain it until
 * the CLI exits and then invoke cleanup(); stale crash residue is pruned on a
 * later creation. */
export function createPrivateCliTextArtifact(
  kind: string,
  content: string,
  extension = 'txt',
): PrivateCliArtifact {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_PRIVATE_TEXT_BYTES) {
    throw new Error('Private CLI input exceeds the supported size');
  }

  return createPrivateCliArtifact(kind, Buffer.from(content, 'utf8'), extension);
}

export function createPrivateCliBinaryArtifact(
  kind: string,
  content: Uint8Array,
  extension: string,
): PrivateCliArtifact {
  if (content.byteLength > MAX_PRIVATE_TEXT_BYTES) {
    throw new Error('Private CLI input exceeds the supported size');
  }
  return createPrivateCliArtifact(kind, content, extension);
}

function createPrivateCliArtifact(
  kind: string,
  content: Uint8Array,
  extension: string,
): PrivateCliArtifact {

  pruneStalePrivateCliArtifacts();
  ensurePrivateRoot();
  const directory = mkdtempSync(join(PRIVATE_ROOT, 'run-'));
  chmodSync(directory, 0o700);
  writeFileSync(
    join(directory, OWNER_FILE),
    JSON.stringify({ pid: process.pid, processStartId: processStartId(process.pid) }),
    { mode: 0o600, flag: 'wx' },
  );
  const suffix = extension.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'txt';
  const path = join(directory, `${safeKind(kind)}.${suffix}`);
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });

  let cleaned = false;
  return {
    directory,
    path,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      const resolvedDirectory = resolve(directory);
      const resolvedRoot = `${resolve(PRIVATE_ROOT)}/`;
      if (!resolvedDirectory.startsWith(resolvedRoot) || basename(resolvedDirectory).length < 8) {
        return;
      }
      rmSync(resolvedDirectory, { recursive: true, force: true });
    },
  };
}

/** Defensive invariant shared by every provider before spawn. It catches a
 * future refactor that accidentally puts a private prompt back into argv. */
export function assertPrivateValuesAbsentFromArgv(
  args: readonly string[],
  privateValues: readonly (string | undefined | null)[],
): void {
  const values = privateValues.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  for (const value of values) {
    if (args.some((arg) => arg.includes(value))) {
      throw new Error('Refusing to expose private provider input in process arguments');
    }
  }
}

/** Write a prompt over the already-private stdin pipe and close it. */
export function writePrivatePromptToStdin(
  child: Pick<ChildProcessWithoutNullStreams, 'stdin'>,
  prompt: string,
): void {
  child.stdin.end(prompt, 'utf8');
}

/** Register idempotent cleanup for success, abort, and spawn failure. */
export function cleanupPrivateArtifactsWithChild(
  child: Pick<ChildProcess, 'once'>,
  artifacts: Array<PrivateCliArtifact | null | undefined>,
): () => void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const artifact of artifacts) artifact?.cleanup();
  };
  child.once('close', cleanup);
  child.once('error', cleanup);
  return cleanup;
}

export function cleanupPrivateArtifacts(
  artifacts: Array<PrivateCliArtifact | null | undefined>,
): void {
  for (const artifact of artifacts) artifact?.cleanup();
}

/** Start a child without leaving private inputs behind if spawn throws before
 * Node can emit an `error`/`close` event. */
export function spawnWithPrivateArtifactCleanup<T extends Pick<ChildProcess, 'once'>>(
  spawnChild: () => T,
  artifacts: Array<PrivateCliArtifact | null | undefined>,
  onSpawnFailure?: () => void,
): T {
  try {
    const child = spawnChild();
    cleanupPrivateArtifactsWithChild(child, artifacts);
    return child;
  } catch (error) {
    cleanupPrivateArtifacts(artifacts);
    onSpawnFailure?.();
    throw error;
  }
}

export function privateArtifactFingerprint(path: string): string {
  const stat = statSync(path);
  return createHash('sha256')
    .update(`${dirname(path)}:${stat.size}:${stat.mode & 0o777}`)
    .digest('hex')
    .slice(0, 12);
}

export const PRIVATE_CLI_ROOT_FOR_TESTING = PRIVATE_ROOT;
