import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextProjectionStoreDirectory,
  pruneContextProjectionStore,
  readContextProjectionCheckpoint,
  touchContextProjectionCheckpoint,
  writeContextProjectionCheckpoint,
} from './context-projection-store';

const originalDataDir = process.env.KORYPHAIOS_DATA_DIR;
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-context-projection-store-'));
  process.env.KORYPHAIOS_DATA_DIR = root;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.KORYPHAIOS_DATA_DIR;
  else process.env.KORYPHAIOS_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

const key = 'a'.repeat(64);

describe('context projection store', () => {
  test('round-trips an integrity-checked private checkpoint', () => {
    const written = writeContextProjectionCheckpoint({
      checkpointKey: key,
      summary: '# checkpoint\nimportant state',
      sourceTokens: 500_000,
      checkpointTokens: 4_000,
    });
    expect(readContextProjectionCheckpoint(key)).toEqual(written);
    if (process.platform !== 'win32') {
      const mode = statSync(join(contextProjectionStoreDirectory(), `${key}.json`)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('rejects a tampered summary instead of trusting stale disk state', () => {
    writeContextProjectionCheckpoint({
      checkpointKey: key,
      summary: 'trusted',
      sourceTokens: 100,
      checkpointTokens: 10,
    });
    const path = join(contextProjectionStoreDirectory(), `${key}.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    parsed.summary = 'tampered';
    writeFileSync(path, JSON.stringify(parsed));
    expect(readContextProjectionCheckpoint(key)).toBeUndefined();
  });

  test('touch preserves creation time and advances LRU time', () => {
    const written = writeContextProjectionCheckpoint({
      checkpointKey: key,
      summary: 'state',
      sourceTokens: 100,
      checkpointTokens: 10,
      createdAt: 10,
      lastUsedAt: 20,
    });
    const touched = touchContextProjectionCheckpoint(written, 30);
    expect(touched.createdAt).toBe(10);
    expect(touched.lastUsedAt).toBe(30);
  });

  test('prunes old and excess entries', () => {
    for (let index = 0; index < 3; index++) {
      writeContextProjectionCheckpoint({
        checkpointKey: String(index + 1).repeat(64),
        summary: `state-${index}`,
        sourceTokens: 100,
        checkpointTokens: 10,
        createdAt: 100 + index,
        lastUsedAt: 100 + index,
      });
    }
    expect(pruneContextProjectionStore({ maxEntries: 2, maxAgeMs: 10_000, now: 200 })).toBe(1);
  });
});
