// API usage ledger — records every billable cloud image/voice call so users
// can see what the multi-modal features spent. Entries are estimates: pricing
// tables are approximate and providers change them; unknown pricing is simply
// omitted rather than guessed. Rows live in SQLite (migration 0030); a legacy
// JSONL ledger is imported once and archived.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';

export type ApiUsageKind = 'image' | 'tts' | 'stt';

export interface ApiUsageEntry {
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  kind: ApiUsageKind;
  provider: string;
  model: string;
  /** Rough USD estimate when pricing is known. Never a quote. */
  estimatedCostUsd?: number;
  /** Billable units the estimate is based on. */
  units?: { measure: 'images' | 'characters' | 'minutes'; amount: number };
  /** Short human-readable context, e.g. "1024x1024 · high". */
  detail?: string;
  /** Owning chat session when the API call was made from a session turn. */
  sessionId?: string;
  /** Authoritative session-run generation that initiated the call. */
  runId?: string;
}

export interface ApiUsageDailyBucket {
  /** YYYY-MM-DD (UTC). */
  day: string;
  byKind: Record<ApiUsageKind, number>;
  estimatedCostUsd: number | undefined;
}

export interface ApiUsageTotals {
  totalCount: number;
  byKind: Record<ApiUsageKind, number>;
  estimatedCostUsd: number | undefined;
}

const DEFAULT_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const ATTRIBUTION_VERSION = 1;
let lastPruneAt = 0;

interface StoredUsageDetail {
  _koryUsage: typeof ATTRIBUTION_VERSION;
  detail?: string;
  sessionId?: string;
  runId?: string;
}

function encodeStoredDetail(
  entry: Pick<ApiUsageEntry, 'detail' | 'sessionId' | 'runId'>,
): string | null {
  if (!entry.sessionId && !entry.runId) return entry.detail ?? null;
  return JSON.stringify({
    _koryUsage: ATTRIBUTION_VERSION,
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
  } satisfies StoredUsageDetail);
}

function decodeStoredDetail(value: unknown): Pick<ApiUsageEntry, 'detail' | 'sessionId' | 'runId'> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as Partial<StoredUsageDetail>;
    if (parsed?._koryUsage !== ATTRIBUTION_VERSION) return { detail: value };
    return {
      ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
      ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
    };
  } catch {
    return { detail: value };
  }
}

function legacyLedgerPath(): string {
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim() || join(PROJECT_ROOT, '.koryphaios');
  return join(dataDir, 'usage', 'api-usage.jsonl');
}

function db(): Database {
  return getDb();
}

/** Rough per-image USD pricing by model family (estimates, not quotes). */
const IMAGE_COST_USD: Array<{ pattern: RegExp; cost: (quality: string) => number }> = [
  {
    pattern: /gpt-image-1-mini/i,
    cost: (q) => ({ low: 0.005, medium: 0.011, high: 0.036 })[q] ?? 0.011,
  },
  { pattern: /gpt-image/i, cost: (q) => ({ low: 0.02, medium: 0.05, high: 0.15 })[q] ?? 0.05 },
  { pattern: /dall-e-3/i, cost: (q) => (q === 'hd' ? 0.08 : 0.04) },
  { pattern: /dall-e-2/i, cost: () => 0.02 },
];

/** Rough USD per 1,000 characters for speech synthesis. */
const TTS_COST_PER_KCHAR: Array<{ pattern: RegExp; cost: number }> = [
  { pattern: /tts-1-hd/i, cost: 0.03 },
  { pattern: /tts-1|gpt-4o-mini-tts/i, cost: 0.015 },
];

/** Rough USD per minute of audio for transcription. */
const STT_COST_PER_MINUTE: Array<{ pattern: RegExp; cost: number }> = [
  { pattern: /gpt-4o-mini-transcribe/i, cost: 0.003 },
  { pattern: /whisper|gpt-4o-transcribe|nova|universal/i, cost: 0.006 },
];

function priceFor<T>(table: Array<{ pattern: RegExp; cost: T }>, model: string): T | undefined {
  return table.find((row) => row.pattern.test(model))?.cost;
}

export function estimateImageCostUsd(model: string, quality?: string): number | undefined {
  const pricing = priceFor(IMAGE_COST_USD, model);
  if (!pricing) return undefined;
  return pricing((quality ?? 'medium').toLowerCase());
}

export function estimateSpeechCostUsd(model: string, characters: number): number | undefined {
  const perK = priceFor(TTS_COST_PER_KCHAR, model);
  if (perK === undefined) return undefined;
  return (characters / 1000) * perK;
}

export function estimateTranscriptionCostUsd(
  model: string,
  audioBytes: number,
): number | undefined {
  const perMinute = priceFor(STT_COST_PER_MINUTE, model);
  if (perMinute === undefined) return undefined;
  // 16 kHz mono 16-bit PCM ≈ 32 KB/s — recording bitrates land near this.
  const minutes = audioBytes / 32_000 / 60;
  return minutes * perMinute;
}

function rowToEntry(row: Record<string, unknown>): ApiUsageEntry {
  const entry: ApiUsageEntry = {
    id: String(row.id),
    ts: Number(row.ts),
    kind: String(row.kind) as ApiUsageKind,
    provider: String(row.provider),
    model: String(row.model),
  };
  if (typeof row.estimated_cost_usd === 'number')
    entry.estimatedCostUsd = row.estimated_cost_usd as number;
  if (
    typeof row.unit_measure === 'string' &&
    typeof row.unit_amount === 'number' &&
    ['images', 'characters', 'minutes'].includes(row.unit_measure)
  ) {
    entry.units = {
      measure: row.unit_measure as 'images' | 'characters' | 'minutes',
      amount: row.unit_amount,
    };
  }
  Object.assign(entry, decodeStoredDetail(row.detail));
  return entry;
}

/**
 * One-time import of the legacy JSONL ledger. The file is archived
 * (renamed to .imported) so the import never doubles rows.
 */
function importLegacyLedger(database: Database): void {
  const path = legacyLedgerPath();
  if (!existsSync(path)) return;
  const archived = `${path}.imported`;
  try {
    const raw = readFileSync(path, 'utf8');
    const rows: ApiUsageEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ApiUsageEntry;
        if (parsed && typeof parsed.ts === 'number' && typeof parsed.kind === 'string') {
          // Stable id derived from the line: a re-import after a crash
          // between INSERT and archive becomes a no-op via INSERT OR IGNORE.
          rows.push({
            ...parsed,
            id: parsed.id || createHash('sha256').update(line).digest('hex').slice(0, 32),
          });
        }
      } catch {
        // Skip torn/corrupt lines.
      }
    }
    const insert = database.prepare(
      `INSERT OR IGNORE INTO api_usage
         (id, ts, kind, provider, model, estimated_cost_usd, unit_measure, unit_amount, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.ts,
          row.kind,
          row.provider,
          row.model,
          row.estimatedCostUsd ?? null,
          row.units?.measure ?? null,
          row.units?.amount ?? null,
          encodeStoredDetail(row),
        );
      }
    })();
    renameSync(path, archived);
    serverLog.info({ imported: rows.length, archived }, 'Imported legacy API usage ledger');
  } catch (err: unknown) {
    serverLog.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'Failed to import legacy API usage ledger',
    );
  }
}

function ensureSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'tts', 'stt')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      estimated_cost_usd REAL,
      unit_measure TEXT CHECK (unit_measure IN ('images', 'characters', 'minutes')),
      unit_amount REAL,
      detail TEXT
    );
  `);
}

function withDb(): Database {
  const database = db();
  ensureSchema(database);
  importLegacyLedger(database);
  return database;
}

type NewApiUsageEntry = Omit<ApiUsageEntry, 'id' | 'ts'> & { id?: string; ts?: number };

function persistApiUsage(entry: NewApiUsageEntry): string {
  const id = entry.id ?? randomUUID();
  const storedDetail = encodeStoredDetail(entry);
  const result = withDb()
    .prepare(
      `INSERT OR IGNORE INTO api_usage
         (id, ts, kind, provider, model, estimated_cost_usd, unit_measure, unit_amount, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      entry.ts ?? Date.now(),
      entry.kind,
      entry.provider,
      entry.model,
      entry.estimatedCostUsd ?? null,
      entry.units?.measure ?? null,
      entry.units?.amount ?? null,
      storedDetail,
    );
  if (result.changes === 0) {
    const existing = withDb()
      .prepare(
        `SELECT kind, provider, model, estimated_cost_usd, unit_measure, unit_amount, detail
         FROM api_usage WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | null;
    const same =
      existing?.kind === entry.kind &&
      existing.provider === entry.provider &&
      existing.model === entry.model &&
      (existing.estimated_cost_usd ?? null) === (entry.estimatedCostUsd ?? null) &&
      (existing.unit_measure ?? null) === (entry.units?.measure ?? null) &&
      (existing.unit_amount ?? null) === (entry.units?.amount ?? null) &&
      (existing.detail ?? null) === storedDetail;
    if (!same) throw new Error(`API usage id collision: ${id}`);
  }
  void maybePruneOldEntries();
  return id;
}

/** Record one billable call. Best-effort: logging never breaks voice requests. */
export async function recordApiUsage(entry: NewApiUsageEntry): Promise<string | undefined> {
  try {
    return persistApiUsage(entry);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), kind: entry.kind },
      'Failed to record API usage entry',
    );
    return undefined;
  }
}

/**
 * Required write for a paid image boundary. Callers must not report a clean
 * image success when its durable usage attribution could not be committed.
 */
export async function recordApiUsageRequired(entry: NewApiUsageEntry): Promise<string> {
  return persistApiUsage(entry);
}

/**
 * Known image spend recorded by the API ledger. Session-scoped reads include
 * only rows carrying the versioned attribution envelope; global reads also
 * include older rows so historical Studio spend does not disappear.
 */
export function recordedImageUsageCostUsd(sessionId: string | undefined, since: Date): number {
  const database = withDb();
  const sessionPredicate = sessionId
    ? `AND CASE
         WHEN json_valid(detail) THEN json_extract(detail, '$._koryUsage') = ?
              AND json_extract(detail, '$.sessionId') = ?
         ELSE 0
       END`
    : '';
  const parameters: Array<string | number> = [since.getTime()];
  if (sessionId) parameters.push(ATTRIBUTION_VERSION, sessionId);
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
       FROM api_usage
       WHERE kind = 'image' AND ts >= ? ${sessionPredicate}`,
    )
    .get(...parameters) as { total?: number } | null;
  const total = Number(row?.total ?? 0);
  if (!Number.isFinite(total) || total < 0) throw new Error('Recorded image spend is invalid');
  return total;
}

export async function listApiUsage(limit = 100): Promise<ApiUsageEntry[]> {
  try {
    const rows = withDb()
      .prepare(`SELECT * FROM api_usage ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
    return rows.map(rowToEntry);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to list API usage entries',
    );
    return [];
  }
}

export async function apiUsageTotals(): Promise<ApiUsageTotals> {
  try {
    const database = withDb();
    const kindRows = database
      .prepare(`SELECT kind, COUNT(*) AS count FROM api_usage GROUP BY kind`)
      .all() as Array<{ kind: string; count: number }>;
    const byKind: Record<ApiUsageKind, number> = { image: 0, tts: 0, stt: 0 };
    for (const row of kindRows) {
      if (row.kind in byKind) byKind[row.kind as ApiUsageKind] = row.count;
    }
    const total = (
      database.prepare(`SELECT COUNT(*) AS count FROM api_usage`).all() as Array<{
        count: number;
      }>
    )[0];
    const cost = (
      database.prepare(`SELECT SUM(estimated_cost_usd) AS total FROM api_usage`).all() as Array<{
        total: number | null;
      }>
    )[0];
    return {
      totalCount: total?.count ?? 0,
      byKind,
      estimatedCostUsd: typeof cost?.total === 'number' ? Number(cost.total.toFixed(4)) : undefined,
    };
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to compute API usage totals',
    );
    return { totalCount: 0, byKind: { image: 0, tts: 0, stt: 0 }, estimatedCostUsd: undefined };
  }
}

/** Daily buckets (UTC) for the usage dashboard trend. */
export async function apiUsageDaily(days = 30): Promise<ApiUsageDailyBucket[]> {
  try {
    const since = Date.now() - Math.max(1, Math.min(days, 365)) * 24 * 60 * 60 * 1000;
    const rows = withDb()
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch') AS day, kind,
                COUNT(*) AS count, SUM(estimated_cost_usd) AS cost
         FROM api_usage WHERE ts >= ?
         GROUP BY day, kind ORDER BY day DESC`,
      )
      .all(since) as Array<{ day: string; kind: string; count: number; cost: number | null }>;

    const buckets = new Map<string, ApiUsageDailyBucket>();
    for (const row of rows) {
      let bucket = buckets.get(row.day);
      if (!bucket) {
        bucket = { day: row.day, byKind: { image: 0, tts: 0, stt: 0 }, estimatedCostUsd: 0 };
        buckets.set(row.day, bucket);
      }
      if (row.kind in bucket.byKind) bucket.byKind[row.kind as ApiUsageKind] += row.count;
      bucket.estimatedCostUsd = Number(
        (((bucket.estimatedCostUsd ?? 0) + (row.cost ?? 0)) as number).toFixed(4),
      );
    }
    return [...buckets.values()].map((bucket) => ({
      ...bucket,
      estimatedCostUsd:
        bucket.estimatedCostUsd && bucket.estimatedCostUsd > 0
          ? bucket.estimatedCostUsd
          : undefined,
    }));
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to bucket API usage by day',
    );
    return [];
  }
}

/** Delete entries older than the retention window. Returns rows removed. */
export async function pruneApiUsage(maxAgeDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  try {
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
    return withDb().prepare(`DELETE FROM api_usage WHERE ts < ?`).run(cutoff).changes;
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to prune API usage entries',
    );
    return 0;
  }
}

/** Throttled retention pass — at most once per hour, best-effort. */
export async function maybePruneOldEntries(): Promise<number> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  const pruned = await pruneApiUsage();
  lastPruneAt = Date.now();
  return pruned;
}

/** RFC 4180 field escaping: quote when needed, double embedded quotes. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Every entry, paged in batches so exports never truncate. */
async function listAllApiUsage(): Promise<ApiUsageEntry[]> {
  const all: ApiUsageEntry[] = [];
  const pageSize = 1000;
  for (;;) {
    const page = withDb()
      .prepare(`SELECT * FROM api_usage ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(pageSize, all.length) as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    all.push(...page.map(rowToEntry));
    if (page.length < pageSize) break;
  }
  return all;
}

/** Full ledger as CSV (usage dashboard export). */
export async function apiUsageCsv(): Promise<string> {
  const entries = await listAllApiUsage();
  const header =
    'id,ts,kind,provider,model,estimated_cost_usd,unit_measure,unit_amount,detail,session_id,run_id';
  const lines = entries.map((entry) =>
    [
      csvField(entry.id),
      csvField(new Date(entry.ts).toISOString()),
      csvField(entry.kind),
      csvField(entry.provider),
      csvField(entry.model),
      entry.estimatedCostUsd !== undefined ? String(entry.estimatedCostUsd) : '',
      entry.units?.measure ?? '',
      entry.units?.amount !== undefined ? String(entry.units.amount) : '',
      csvField(entry.detail ?? ''),
      csvField(entry.sessionId ?? ''),
      csvField(entry.runId ?? ''),
    ].join(','),
  );
  return [header, ...lines].join('\n');
}
