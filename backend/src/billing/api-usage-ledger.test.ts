import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const isolatedRoot = mkdtempSync(join(tmpdir(), 'kory-usage-ledger-'));
process.env.KORYPHAIOS_DATA_DIR = isolatedRoot;
process.env.DATABASE_URL = `sqlite:${join(isolatedRoot, 'usage-ledger.sqlite')}`;

const {
  apiUsageCsv,
  apiUsageDaily,
  apiUsageTotals,
  estimateImageCostUsd,
  estimateSpeechCostUsd,
  estimateTranscriptionCostUsd,
  listApiUsage,
  pruneApiUsage,
  recordApiUsage,
} = await import('./api-usage-ledger');
const { initDb } = await import('../db');
const { getDb } = await import('../db');
const { getSpendWindowSnapshot } = await import('../security/spend-caps-enforced');

beforeAll(async () => {
  await initDb();
});

// NOTE: no rmSync cleanup — the shared DB singleton holds this directory open
// (WAL files), and Bun runs all test files in one process. OS tmp cleans up.

describe('api usage ledger', () => {
  test('estimates costs only for models with known pricing', () => {
    expect(estimateImageCostUsd('gpt-image-1', 'high')).toBeCloseTo(0.15);
    expect(estimateImageCostUsd('gpt-image-1-mini', 'low')).toBeCloseTo(0.005);
    expect(estimateImageCostUsd('dall-e-3', 'hd')).toBeCloseTo(0.08);
    expect(estimateImageCostUsd('imagen-4.0-generate-001')).toBeUndefined();
    expect(estimateSpeechCostUsd('gpt-4o-mini-tts', 2000)).toBeCloseTo(0.03);
    expect(estimateSpeechCostUsd('playai-tts', 2000)).toBeUndefined();
    expect(estimateTranscriptionCostUsd('whisper-1', 32_000 * 60)).toBeCloseTo(0.006);
  });

  test('records entries and lists them newest-first with totals', async () => {
    const base = Date.now();
    await recordApiUsage({
      kind: 'image',
      provider: 'openai',
      model: 'gpt-image-1',
      estimatedCostUsd: 0.05,
      units: { measure: 'images', amount: 1 },
      detail: '1024x1024 · medium',
      sessionId: 'session-image-1',
      runId: 'run-image-1',
      ts: base,
    });
    await recordApiUsage({
      kind: 'tts',
      provider: 'groq',
      model: 'playai-tts',
      units: { measure: 'characters', amount: 120 },
      ts: base + 1,
    });
    const entries = await listApiUsage();
    expect(entries.length).toBe(2);
    expect(entries[0]?.kind).toBe('tts');
    expect(entries[1]?.estimatedCostUsd).toBeCloseTo(0.05);
    expect(entries[1]).toMatchObject({
      detail: '1024x1024 · medium',
      sessionId: 'session-image-1',
      runId: 'run-image-1',
    });
    expect(entries[0]?.id).toBeDefined();

    const totals = await apiUsageTotals();
    expect(totals.totalCount).toBe(2);
    expect(totals.byKind).toMatchObject({ image: 1, tts: 1, stt: 0 });
    expect(totals.estimatedCostUsd).toBeCloseTo(0.05);
  });

  test('buckets daily totals for the dashboard', async () => {
    const daily = await apiUsageDaily(30);
    expect(daily.length).toBeGreaterThan(0);
    const today = daily[0]!;
    expect(today.byKind.image + today.byKind.tts).toBeGreaterThanOrEqual(2);
  });

  test('exports the ledger as CSV', async () => {
    const csv = await apiUsageCsv();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'id,ts,kind,provider,model,estimated_cost_usd,unit_measure,unit_amount,detail,session_id,run_id',
    );
    expect(lines.length).toBe(3);
    expect(csv).toContain('gpt-image-1');
  });

  test('prunes entries older than the retention window', async () => {
    await recordApiUsage({
      kind: 'stt',
      provider: 'deepgram',
      model: 'nova-3',
      ts: Date.now() - 91 * 24 * 60 * 60 * 1000,
    });
    expect((await apiUsageTotals()).totalCount).toBe(3);
    const pruned = await pruneApiUsage(90);
    expect(pruned).toBe(1);
    expect((await apiUsageTotals()).totalCount).toBe(2);
  });

  test('imports a legacy JSONL ledger once and archives it', async () => {
    // New isolated DB + a legacy JSONL file.
    const importRoot = mkdtempSync(join(tmpdir(), 'kory-usage-import-'));
    const previousDataDir = process.env.KORYPHAIOS_DATA_DIR;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.KORYPHAIOS_DATA_DIR = importRoot;
    process.env.DATABASE_URL = `sqlite:${join(importRoot, 'import.sqlite')}`;
    try {
      mkdirSync(join(importRoot, 'usage'), { recursive: true });
      writeFileSync(
        join(importRoot, 'usage', 'api-usage.jsonl'),
        [
          JSON.stringify({
            id: 'legacy-1',
            ts: Date.now(),
            kind: 'image',
            provider: 'openai',
            model: 'gpt-image-1',
            estimatedCostUsd: 0.02,
          }),
          'not-json-at-all',
          JSON.stringify({
            ts: Date.now(),
            kind: 'stt',
            provider: 'groq',
            model: 'whisper-large-v3',
          }),
        ].join('\n'),
      );
      // Re-import the module fresh so its cached prune state resets.
      // @ts-expect-error Bun test query import for a fresh module instance
      const fresh = await import('./api-usage-ledger?import-legacy');
      const entries = await fresh.listApiUsage(1000);
      const legacyRows = entries.filter((entry: { id: string }) => entry.id === 'legacy-1');
      expect(legacyRows).toHaveLength(1);
      expect(existsSync(join(importRoot, 'usage', 'api-usage.jsonl'))).toBe(false);
      expect(existsSync(join(importRoot, 'usage', 'api-usage.jsonl.imported'))).toBe(true);
      // A second pass must not double-import the archived file.
      const again = await fresh.listApiUsage(1000);
      expect(again.filter((entry: { id: string }) => entry.id === 'legacy-1')).toHaveLength(1);
    } finally {
      process.env.KORYPHAIOS_DATA_DIR = previousDataDir;
      process.env.DATABASE_URL = previousDatabaseUrl;
      rmSync(importRoot, { recursive: true, force: true });
    }
  });

  test('counts a chat image ledger/message pair exactly once in spend windows', async () => {
    const database = getDb();
    const now = Date.now();
    const sessionId = 'usage-linked-image-session';
    const usageAndMessageId = 'usage-linked-image-message';
    database
      .query(
        `INSERT INTO sessions (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, 'Linked image accounting', now, now);
    await recordApiUsage({
      id: usageAndMessageId,
      kind: 'image',
      provider: 'openai',
      model: 'gpt-image-1',
      estimatedCostUsd: 0.05,
      units: { measure: 'images', amount: 1 },
      sessionId,
      runId: 'usage-linked-image-run',
      ts: now,
    });
    database
      .query(
        `INSERT INTO messages
           (id, session_id, role, content, model, provider, cost, created_at)
         VALUES (?, ?, 'assistant', '[]', 'gpt-image-1', 'openai', 0.05, ?)`,
      )
      .run(usageAndMessageId, sessionId, now);

    const snapshot = await getSpendWindowSnapshot(sessionId, now + 1);
    expect(snapshot.sessionHourCents).toBe(5);
    expect(snapshot.sessionDayCents).toBe(5);
  });
});
