import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChangeSummary } from '@koryphaios/shared';
import { getSafeSubprocessEnv } from '../runtime/safe-env';

const GIT_TIMEOUT_MS = 2_500;
const CAPTURE_DEADLINE_MS = 4_000;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_DIRTY_PATHS = 10_000;
const MAX_FULL_HASH_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 128 * 1024 * 1024;
const SAMPLE_BYTES = 64 * 1024;

interface GitCommandResult {
  success: boolean;
  stdout: Buffer;
  truncated: boolean;
  timedOut: boolean;
}

interface BoundedGitProcess {
  kill(signal?: string): void;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

interface FileFingerprint {
  signature: string;
  present: boolean;
  lines?: number;
  complete: boolean;
}

interface DirtyEntry {
  status: string;
  fingerprint: FileFingerprint;
}

/**
 * A bounded representation of Git's index plus every path Git reports as
 * different from that index. Contents are represented by hashes, never stored.
 */
export interface GitChangeEvidenceSnapshot {
  repoRoot: string;
  index: Map<string, string>;
  dirty: Map<string, DirtyEntry>;
  complete: boolean;
  capturedAt: number;
}

export interface GitChangeEvidenceDiff {
  changes: ChangeSummary[];
  complete: boolean;
  reason?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  stop: () => void,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        stop();
        return { buffer: Buffer.concat(chunks, total), truncated: true };
      }
      const chunk = Buffer.from(value);
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        stop();
        return { buffer: Buffer.concat(chunks, total), truncated: true };
      }
      chunks.push(chunk);
      total += chunk.length;
    }
    return { buffer: Buffer.concat(chunks, total), truncated: false };
  } finally {
    reader.releaseLock();
  }
}

async function runGitBounded(
  cwd: string,
  args: string[],
  maxStdoutBytes: number,
): Promise<GitCommandResult> {
  let proc: BoundedGitProcess;
  try {
    proc = Bun.spawn(['git', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: getSafeSubprocessEnv({
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
      }),
    }) as unknown as BoundedGitProcess;
  } catch {
    return { success: false, stdout: Buffer.alloc(0), truncated: false, timedOut: false };
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  };
  const stdoutPromise = readBounded(proc.stdout, maxStdoutBytes, stop);
  const stderrPromise = readBounded(proc.stderr, 64 * 1024, stop);
  type Completion = [
    number,
    { buffer: Buffer; truncated: boolean },
    { buffer: Buffer; truncated: boolean },
  ];
  const completion = Promise.all([
    proc.exited,
    stdoutPromise,
    stderrPromise,
  ]) as Promise<Completion>;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(null), GIT_TIMEOUT_MS);
  });
  const raced: Completion | null = await Promise.race([completion, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (raced === null) {
    stop();
    await Promise.race([completion, wait(250)]);
    return { success: false, stdout: Buffer.alloc(0), truncated: false, timedOut: true };
  }

  const [exitCode, stdout] = raced;
  return {
    success: exitCode === 0 && !stdout.truncated,
    stdout: stdout.buffer,
    truncated: stdout.truncated,
    timedOut: false,
  };
}

function splitNul(buffer: Buffer): string[] {
  const records: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0) continue;
    records.push(buffer.subarray(start, i).toString('utf8'));
    start = i + 1;
  }
  if (start < buffer.length) records.push(buffer.subarray(start).toString('utf8'));
  return records;
}

function isInternalOrUnsafePath(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path)) return true;
  const normalized = path.replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../')) return true;
  return normalized.split('/').some((segment) => segment === '.git' || segment === '.koryphaios');
}

function parseIndex(buffer: Buffer): Map<string, string> | null {
  const index = new Map<string, string>();
  for (const record of splitNul(buffer)) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab <= 0) return null;
    const metadata = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (metadata.length !== 3) return null;
    if (isInternalOrUnsafePath(path)) continue;
    const entry = `${metadata[0]}:${metadata[1]}:${metadata[2]}`;
    const existing = index.get(path);
    index.set(path, existing ? `${existing}|${entry}` : entry);
  }
  return index;
}

function parseDirtyPaths(buffer: Buffer): Map<string, string> | null {
  const records = splitNul(buffer);
  const dirty = new Map<string, string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 3 || record[2] !== ' ') return null;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!isInternalOrUnsafePath(path)) dirty.set(path, status);

    // With porcelain v1 -z, rename/copy records are followed by the original
    // path as a second NUL-delimited field without a status prefix.
    if (status.includes('R') || status.includes('C')) {
      const source = records[++i];
      if (source === undefined) return null;
      if (!isInternalOrUnsafePath(source)) dirty.set(source, `${status}:source`);
    }
  }
  return dirty;
}

function numberFromBigInt(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

async function fingerprintPath(
  repoRoot: string,
  path: string,
  budget: { remaining: number; deadline: number },
): Promise<FileFingerprint> {
  if (Date.now() > budget.deadline) {
    return { signature: 'deadline', present: false, complete: false };
  }
  const absolutePath = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolutePath);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return { signature: 'unsafe', present: false, complete: false };
  }

  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { signature: 'absent', present: false, complete: true, lines: 0 };
    }
    return { signature: `stat-error:${code ?? 'unknown'}`, present: false, complete: false };
  }

  const common = [Number(stat.mode & 0o7777n), stat.size.toString()].join(':');
  const metadata = `${stat.mtimeNs.toString()}:${stat.ctimeNs.toString()}`;
  if (stat.isSymbolicLink()) {
    try {
      const target = await readlink(absolutePath, { encoding: 'buffer' });
      const digest = createHash('sha256').update(target).digest('hex');
      return { signature: `link:${common}:${digest}`, present: true, complete: true, lines: 0 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        signature: `link-error:${common}:${code ?? 'unknown'}`,
        present: true,
        complete: false,
      };
    }
  }
  if (!stat.isFile()) {
    return {
      signature: `${stat.isDirectory() ? 'directory' : 'special'}:${common}:${metadata}`,
      present: true,
      complete: true,
      lines: 0,
    };
  }

  const size = numberFromBigInt(stat.size);
  const fullHash = size <= MAX_FULL_HASH_BYTES && size <= budget.remaining;
  const bytesToRead = fullHash ? size : Math.min(size, SAMPLE_BYTES * 2);
  if (bytesToRead > budget.remaining) {
    return {
      signature: `file-budget:${common}:${metadata}`,
      present: true,
      complete: false,
    };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
    const digest = createHash('sha256');
    let lines = 0;
    let sawNul = false;
    let lastByte: number | undefined;
    const readRange = async (start: number, length: number) => {
      let offset = 0;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, length)));
      while (offset < length) {
        if (Date.now() > budget.deadline) throw new Error('capture-deadline');
        const wanted = Math.min(chunk.length, length - offset);
        const { bytesRead } = await handle!.read(chunk, 0, wanted, start + offset);
        if (bytesRead === 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        digest.update(bytes);
        if (fullHash) {
          for (const byte of bytes) {
            if (byte === 0) sawNul = true;
            if (byte === 10) lines++;
            lastByte = byte;
          }
        }
        offset += bytesRead;
        budget.remaining -= bytesRead;
      }
      return offset;
    };

    if (fullHash) {
      await readRange(0, size);
    } else {
      const headLength = Math.min(size, SAMPLE_BYTES);
      await readRange(0, headLength);
      const tailStart = Math.max(headLength, size - SAMPLE_BYTES);
      if (tailStart < size) await readRange(tailStart, size - tailStart);
    }
    return {
      signature: `${fullHash ? 'file' : 'sampled-file'}:${common}:${
        fullHash ? '' : `${metadata}:`
      }${digest.digest('hex')}`,
      present: true,
      complete: fullHash,
      lines: fullHash && !sawNul ? (size === 0 ? 0 : lines + (lastByte === 10 ? 0 : 1)) : 0,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      signature: `file-error:${common}:${code ?? String((error as Error).message).slice(0, 40)}`,
      present: true,
      complete: false,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Capture a bounded index/worktree snapshot. Returns null for non-Git paths or
 * when Git cannot produce an internally consistent parse; callers should then
 * continue execution without claiming changed-file evidence.
 */
export async function captureGitChangeEvidence(
  workingDirectory: string,
): Promise<GitChangeEvidenceSnapshot | null> {
  const rootResult = await runGitBounded(
    workingDirectory,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    16 * 1024,
  );
  if (!rootResult.success) return null;
  const rootText = rootResult.stdout.toString('utf8').trim();
  if (!rootText) return null;

  let repoRoot: string;
  try {
    repoRoot = await realpath(rootText);
  } catch {
    return null;
  }

  const [statusResult, indexResult] = await Promise.all([
    runGitBounded(
      repoRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      MAX_STATUS_BYTES,
    ),
    runGitBounded(repoRoot, ['ls-files', '--stage', '-z'], MAX_INDEX_BYTES),
  ]);
  if (!statusResult.success || !indexResult.success) return null;

  const status = parseDirtyPaths(statusResult.stdout);
  const index = parseIndex(indexResult.stdout);
  if (!status || !index) return null;

  const completePathList = status.size <= MAX_DIRTY_PATHS;
  const paths = [...status.keys()].sort().slice(0, MAX_DIRTY_PATHS);
  const budget = {
    remaining: MAX_TOTAL_HASH_BYTES,
    deadline: Date.now() + CAPTURE_DEADLINE_MS,
  };
  const dirty = new Map<string, DirtyEntry>();
  let complete = completePathList;
  for (const path of paths) {
    const fingerprint = await fingerprintPath(repoRoot, path, budget);
    dirty.set(path, { status: status.get(path)!, fingerprint });
    if (!fingerprint.complete) complete = false;
  }

  return { repoRoot, index, dirty, complete, capturedAt: Date.now() };
}

function stateSignature(snapshot: GitChangeEvidenceSnapshot, path: string): string {
  const dirty = snapshot.dirty.get(path);
  return `${snapshot.index.get(path) ?? '-'}\0${dirty?.status ?? '-'}\0${dirty?.fingerprint.signature ?? '-'}`;
}

function worktreeState(
  snapshot: GitChangeEvidenceSnapshot,
  path: string,
): { present: boolean; lines: number } {
  const dirty = snapshot.dirty.get(path);
  if (dirty) {
    return {
      present: dirty.fingerprint.present,
      lines: dirty.fingerprint.lines ?? 0,
    };
  }
  return { present: snapshot.index.has(path), lines: 0 };
}

function hasCompletePathEvidence(snapshot: GitChangeEvidenceSnapshot, path: string): boolean {
  return snapshot.dirty.get(path)?.fingerprint.complete ?? true;
}

/** Compare two snapshots and return only net path/index changes. */
export function diffGitChangeEvidence(
  before: GitChangeEvidenceSnapshot | null,
  after: GitChangeEvidenceSnapshot | null,
): GitChangeEvidenceDiff {
  if (!before || !after) {
    return { changes: [], complete: false, reason: 'Git evidence was unavailable' };
  }
  if (before.repoRoot !== after.repoRoot) {
    return { changes: [], complete: false, reason: 'The command changed Git repository roots' };
  }
  const paths = new Set<string>([
    ...before.index.keys(),
    ...after.index.keys(),
    ...before.dirty.keys(),
    ...after.dirty.keys(),
  ]);
  const changes: ChangeSummary[] = [];
  for (const path of [...paths].sort()) {
    if (!hasCompletePathEvidence(before, path) || !hasCompletePathEvidence(after, path)) {
      continue;
    }
    if (stateSignature(before, path) === stateSignature(after, path)) continue;
    const previous = worktreeState(before, path);
    const next = worktreeState(after, path);
    const operation: ChangeSummary['operation'] =
      !previous.present && next.present
        ? 'create'
        : previous.present && !next.present
          ? 'delete'
          : 'edit';
    changes.push({
      path: resolve(after.repoRoot, path),
      operation,
      linesAdded: operation === 'create' ? next.lines : Math.max(0, next.lines - previous.lines),
      linesDeleted:
        operation === 'delete' ? previous.lines : Math.max(0, previous.lines - next.lines),
    });
  }
  const complete = before.complete && after.complete;
  return {
    changes,
    complete,
    reason: complete ? undefined : 'Some Git evidence exceeded a capture bound',
  };
}
