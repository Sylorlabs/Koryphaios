import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const isolatedRoot = mkdtempSync(join(tmpdir(), 'kory-image-history-'));
process.env.KORYPHAIOS_DATA_DIR = isolatedRoot;
process.env.DATABASE_URL = `sqlite:${join(isolatedRoot, 'image-history.sqlite')}`;

const {
  deleteImageHistoryEntry,
  getImageHistoryEntry,
  listImageHistory,
  pruneImageHistory,
  saveImageHistory,
} = await import('./image-history');
const { initDb } = await import('../db');

beforeAll(async () => {
  await initDb();
});

// NOTE: no rmSync cleanup — the shared DB singleton holds this directory open
// (WAL files), and Bun runs all test files in one process. OS tmp cleans up.

describe('image history', () => {
  test('persists, lists newest-first, and serves image bytes back', async () => {
    const first = await saveImageHistory({
      imageBase64: 'aW1hZ2U=',
      mimeType: 'image/png',
      prompt: 'A glass greenhouse',
      provider: 'openai',
      model: 'gpt-image-1',
      effect: 'neon',
      size: '1024x1024',
      quality: 'high',
      mode: 'generate',
    });
    expect(first?.id).toBeDefined();

    const second = await saveImageHistory({
      imageBase64: 'ZWRpdA==',
      mimeType: 'image/jpeg',
      prompt: 'Make it sunset',
      provider: 'openai',
      model: 'gpt-image-1',
      mode: 'edit',
    });
    expect(second?.file.endsWith('.jpg')).toBe(true);

    const list = await listImageHistory();
    expect(list.map((entry) => entry.id)).toEqual([second!.id, first!.id]);
    expect(list[1]?.mode).toBe('generate');
    expect(list[0]?.mode).toBe('edit');

    const detail = await getImageHistoryEntry(first!.id);
    expect(detail?.imageBase64).toBe('aW1hZ2U=');
    expect(detail?.revisedPrompt).toBeUndefined();
  });

  test('deletes the row and the image file together', async () => {
    const saved = await saveImageHistory({
      imageBase64: 'ZGVsZXRl',
      mimeType: 'image/png',
      prompt: 'Doomed image',
      provider: 'openai',
      model: 'gpt-image-1',
      mode: 'generate',
    });
    expect(saved).toBeDefined();
    expect(existsSync(join(isolatedRoot, 'images', saved!.file))).toBe(true);

    expect(await deleteImageHistoryEntry(saved!.id)).toBe(true);
    expect(await getImageHistoryEntry(saved!.id)).toBeUndefined();
    expect(existsSync(join(isolatedRoot, 'images', saved!.file))).toBe(false);
    expect(await deleteImageHistoryEntry(saved!.id)).toBe(false);
  });

  test('imports a legacy JSONL index once and archives it', async () => {
    const importRoot = mkdtempSync(join(tmpdir(), 'kory-image-import-'));
    const previousDataDir = process.env.KORYPHAIOS_DATA_DIR;
    process.env.KORYPHAIOS_DATA_DIR = importRoot;
    try {
      mkdirSync(join(importRoot, 'images'), { recursive: true });
      writeFileSync(join(importRoot, 'images', 'legacy.png'), Buffer.from('bGVnYWN5', 'base64'));
      writeFileSync(
        join(importRoot, 'images', 'index.jsonl'),
        [
          JSON.stringify({
            id: 'legacy-image',
            ts: Date.now(),
            provider: 'openai',
            model: 'gpt-image-1',
            mimeType: 'image/png',
            prompt: 'Legacy entry',
            mode: 'generate',
            file: 'legacy.png',
          }),
          'torn-line-without-json',
        ].join('\n'),
      );
      // @ts-expect-error Bun test query import for a fresh module instance
      const fresh = await import('./image-history?import-legacy');
      const list = await fresh.listImageHistory();
      const legacy = list.find((entry: { id: string }) => entry.id === 'legacy-image');
      expect(legacy?.prompt).toBe('Legacy entry');
      expect(existsSync(join(importRoot, 'images', 'index.jsonl'))).toBe(false);
      expect(existsSync(join(importRoot, 'images', 'index.jsonl.imported'))).toBe(true);

      const detail = await fresh.getImageHistoryEntry('legacy-image');
      expect(detail?.imageBase64).toBe('bGVnYWN5');

      // Second pass must not duplicate the archived import.
      const again = await fresh.listImageHistory();
      expect(again.filter((entry: { id: string }) => entry.id === 'legacy-image')).toHaveLength(1);
    } finally {
      process.env.KORYPHAIOS_DATA_DIR = previousDataDir;
      rmSync(importRoot, { recursive: true, force: true });
    }
  });

  test('prunes old entries together with their files', async () => {
    const old = await saveImageHistory({
      imageBase64: 'b2xk',
      mimeType: 'image/png',
      prompt: 'Ancient',
      provider: 'openai',
      model: 'gpt-image-1',
      mode: 'generate',
    });
    expect(old).toBeDefined();
    // Backdate the row directly through the module's prune window.
    const { getDb } = await import('../db');
    getDb()
      .prepare(`UPDATE image_history SET ts = ? WHERE id = ?`)
      .run(Date.now() - 200 * 24 * 60 * 60 * 1000, old!.id);

    const pruned = await pruneImageHistory(180);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(await getImageHistoryEntry(old!.id)).toBeUndefined();
    expect(existsSync(join(isolatedRoot, 'images', old!.file))).toBe(false);
  });
});
