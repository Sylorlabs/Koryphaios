import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir, hardenFilePermissions } from '../security/fs-permissions';

const STORE_VERSION = 1;
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PersistedContextProjectionCheckpoint {
  version: typeof STORE_VERSION;
  checkpointKey: string;
  summary: string;
  summaryHash: string;
  sourceTokens: number;
  checkpointTokens: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface WriteContextProjectionCheckpointInput {
  checkpointKey: string;
  summary: string;
  sourceTokens: number;
  checkpointTokens: number;
  createdAt?: number;
  lastUsedAt?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function dataRoot(): string {
  return process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
}

export function contextProjectionStoreDirectory(): string {
  return join(dataRoot(), 'cache', 'context-projections');
}

function assertKey(checkpointKey: string): void {
  if (!KEY_PATTERN.test(checkpointKey)) {
    throw new Error('Invalid context projection checkpoint key');
  }
}

function pathForKey(checkpointKey: string): string {
  assertKey(checkpointKey);
  return join(contextProjectionStoreDirectory(), `${checkpointKey}.json`);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function decodeRecord(
  value: unknown,
  expectedKey: string,
): PersistedContextProjectionCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<PersistedContextProjectionCheckpoint>;
  if (
    record.version !== STORE_VERSION ||
    record.checkpointKey !== expectedKey ||
    typeof record.summary !== 'string' ||
    Buffer.byteLength(record.summary, 'utf8') > MAX_SUMMARY_BYTES ||
    typeof record.summaryHash !== 'string' ||
    record.summaryHash !== sha256(record.summary) ||
    !finiteNonNegative(record.sourceTokens) ||
    !finiteNonNegative(record.checkpointTokens) ||
    !finiteNonNegative(record.createdAt) ||
    !finiteNonNegative(record.lastUsedAt)
  ) {
    return undefined;
  }
  return record as PersistedContextProjectionCheckpoint;
}

export function readContextProjectionCheckpoint(
  checkpointKey: string,
): PersistedContextProjectionCheckpoint | undefined {
  const path = pathForKey(checkpointKey);
  if (!existsSync(path)) return undefined;
  try {
    return decodeRecord(JSON.parse(readFileSync(path, 'utf8')), checkpointKey);
  } catch {
    return undefined;
  }
}

export function writeContextProjectionCheckpoint(
  input: WriteContextProjectionCheckpointInput,
): PersistedContextProjectionCheckpoint {
  assertKey(input.checkpointKey);
  if (!input.summary || Buffer.byteLength(input.summary, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new Error('Context projection checkpoint summary is empty or too large');
  }
  if (!finiteNonNegative(input.sourceTokens) || !finiteNonNegative(input.checkpointTokens)) {
    throw new Error('Context projection token counts must be finite and non-negative');
  }

  const directory = contextProjectionStoreDirectory();
  ensureSecureDir(directory);
  const now = Date.now();
  const record: PersistedContextProjectionCheckpoint = {
    version: STORE_VERSION,
    checkpointKey: input.checkpointKey,
    summary: input.summary,
    summaryHash: sha256(input.summary),
    sourceTokens: input.sourceTokens,
    checkpointTokens: input.checkpointTokens,
    createdAt: input.createdAt ?? now,
    lastUsedAt: input.lastUsedAt ?? now,
  };
  const destination = pathForKey(input.checkpointKey);
  const temporary = join(directory, `.${input.checkpointKey}.${process.pid}.${now}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  hardenFilePermissions(temporary);
  renameSync(temporary, destination);
  hardenFilePermissions(destination);
  return record;
}

export function touchContextProjectionCheckpoint(
  checkpoint: PersistedContextProjectionCheckpoint,
  now = Date.now(),
): PersistedContextProjectionCheckpoint {
  return writeContextProjectionCheckpoint({
    checkpointKey: checkpoint.checkpointKey,
    summary: checkpoint.summary,
    sourceTokens: checkpoint.sourceTokens,
    checkpointTokens: checkpoint.checkpointTokens,
    createdAt: checkpoint.createdAt,
    lastUsedAt: now,
  });
}

export function pruneContextProjectionStore(options?: {
  maxEntries?: number;
  maxAgeMs?: number;
  now?: number;
}): number {
  const directory = contextProjectionStoreDirectory();
  if (!existsSync(directory)) return 0;
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxAgeMs = Math.max(0, options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const now = options?.now ?? Date.now();
  const candidates = readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      const key = name.slice(0, -'.json'.length);
      const record = readContextProjectionCheckpoint(key);
      return { path, touchedAt: record?.lastUsedAt ?? stat.mtimeMs };
    })
    .sort((a, b) => b.touchedAt - a.touchedAt);

  let removed = 0;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    if (index < maxEntries && now - candidate.touchedAt <= maxAgeMs) continue;
    try {
      unlinkSync(candidate.path);
      removed++;
    } catch {
      // Best-effort cache pruning must never make a model turn fail.
    }
  }
  return removed;
}
