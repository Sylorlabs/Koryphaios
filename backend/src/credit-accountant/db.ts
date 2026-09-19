/**
 * CreditAccountant local storage: sylorlabs.db (SQLite).
 * Tracks token usage → local cost estimate and cloud reconciliation snapshots.
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { serverLog } from '../logger';
import { ensureSecureDir, hardenFilePermissions } from '../security/fs-permissions';

let db: Database | null = null;
let databasePath: string | null = null;

export function initCreditDb(dataDir: string): void {
  if (db) return;
  ensureSecureDir(dataDir);
  const dbPath = join(dataDir, 'sylorlabs.db');
  db = new Database(dbPath);
  databasePath = dbPath;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // sylorlabs.db holds token-usage / cost attribution rows; tighten the DB
  // and its WAL/SHM sidecars to 0o600 so other local users can't read them.
  hardenFilePermissions(dbPath);
  hardenFilePermissions(`${dbPath}-wal`);
  hardenFilePermissions(`${dbPath}-shm`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT,
      session_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_savings_usd REAL NOT NULL DEFAULT 0,
      ttft_ms REAL,
      latency_ms REAL,
      cost_usd REAL NOT NULL DEFAULT 0,
      cost_known INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_credit_usage_ts ON credit_usage(ts);
  `);
  // Existing installations predate account-scoped attribution. These are
  // additive and preserve every old aggregate record as unattributed.
  for (const sql of [
    'ALTER TABLE credit_usage ADD COLUMN account_id TEXT',
    'ALTER TABLE credit_usage ADD COLUMN session_id TEXT',
    'ALTER TABLE credit_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE credit_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE credit_usage ADD COLUMN cache_savings_usd REAL NOT NULL DEFAULT 0',
    'ALTER TABLE credit_usage ADD COLUMN ttft_ms REAL',
    'ALTER TABLE credit_usage ADD COLUMN latency_ms REAL',
    'ALTER TABLE credit_usage ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(sql);
    } catch (err: unknown) {
      /* column already exists */ serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), sql },
        'Column already exists in credit_usage table',
      );
    }
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_credit_usage_account_ts ON credit_usage(account_id, ts);',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_credit_usage_session_provider_model ON credit_usage(session_id, provider, model);',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_credit_usage_cost_known_ts ON credit_usage(cost_known, ts);',
  );
  // Legacy non-zero rows necessarily came from a resolved numeric price.
  // Legacy zero rows remain unknown until repricing can prove zero or a cost.
  db.exec('UPDATE credit_usage SET cost_known = 1 WHERE cost_usd != 0 AND cost_known = 0;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      total_used_usd REAL,
      total_granted_usd REAL,
      total_available_usd REAL
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_snapshots_ts ON cloud_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_cloud_snapshots_source ON cloud_snapshots(source);
  `);

  serverLog.info({ dbPath }, 'CreditAccountant DB initialized (sylorlabs.db)');
}

export function getCreditDb(): Database {
  if (!db) throw new Error('CreditAccountant DB not initialized');
  return db;
}

/** The already-initialized usage ledger path, for coordinated session erasure. */
export function getCreditDbPath(): string {
  if (!databasePath) throw new Error('CreditAccountant DB not initialized');
  return databasePath;
}

export function recordUsage(
  model: string,
  provider: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  attribution?: { accountId?: string; sessionId?: string },
  cacheUsage?: {
    costKnown?: boolean;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheSavingsUsd?: number;
    ttftMs?: number;
    latencyMs?: number;
  },
): void {
  const d = getCreditDb();
  d.run(
    `INSERT INTO credit_usage (
      ts, model, provider, account_id, session_id, tokens_in, tokens_out,
      cache_read_tokens, cache_write_tokens, cache_savings_usd, ttft_ms, latency_ms, cost_usd,
      cost_known
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      model,
      provider,
      attribution?.accountId ?? null,
      attribution?.sessionId ?? null,
      tokensIn,
      tokensOut,
      Math.max(0, Math.floor(cacheUsage?.cacheReadTokens ?? 0)),
      Math.max(0, Math.floor(cacheUsage?.cacheWriteTokens ?? 0)),
      Number.isFinite(cacheUsage?.cacheSavingsUsd) ? (cacheUsage?.cacheSavingsUsd ?? 0) : 0,
      Number.isFinite(cacheUsage?.ttftMs) ? Math.max(0, cacheUsage?.ttftMs ?? 0) : null,
      Number.isFinite(cacheUsage?.latencyMs) ? Math.max(0, cacheUsage?.latencyMs ?? 0) : null,
      costUsd,
      (cacheUsage?.costKnown ?? (costUsd !== 0)) ? 1 : 0,
    ],
  );
}

export interface UsageCostBreakdownRow {
  sessionId: string | null;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  knownCostUsd: number;
  knownRows: number;
  unknownRows: number;
}

type UsageCostBreakdownDbRow = {
  session_id: string | null;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  known_cost_usd: number;
  known_rows: number;
  unknown_rows: number;
};

/** Provider/model/session billing truth without collapsing unknown price to zero. */
export function getUsageCostBreakdown(sessionId?: string): UsageCostBreakdownRow[] {
  const d = getCreditDb();
  const projection = `SELECT session_id, provider, model,
      SUM(tokens_in) AS tokens_in,
      SUM(tokens_out) AS tokens_out,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE 0 END) AS known_cost_usd,
      SUM(CASE WHEN cost_known = 1 THEN 1 ELSE 0 END) AS known_rows,
      SUM(CASE WHEN cost_known = 0 THEN 1 ELSE 0 END) AS unknown_rows
    FROM credit_usage`;
  const suffix = `AND (tokens_in > 0 OR tokens_out > 0)
    GROUP BY session_id, provider, model
    ORDER BY known_cost_usd DESC, provider, model`;
  const rows = sessionId === undefined
    ? d.query<UsageCostBreakdownDbRow, []>(`${projection} WHERE 1 = 1 ${suffix}`).all()
    : d.query<UsageCostBreakdownDbRow, [string]>(`${projection} WHERE session_id = ? ${suffix}`).all(sessionId);

  return rows.map((row) => ({
    sessionId: row.session_id,
    provider: row.provider,
    model: row.model,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    knownCostUsd: row.known_cost_usd ?? 0,
    knownRows: row.known_rows ?? 0,
    unknownRows: row.unknown_rows ?? 0,
  }));
}

export interface UnknownCostUsageRow {
  id: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function getUnknownCostUsage(limit = 1_000): UnknownCostUsageRow[] {
  const d = getCreditDb();
  const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  return d.query<{
      id: number; provider: string; model: string; tokens_in: number; tokens_out: number;
      cache_read_tokens: number; cache_write_tokens: number;
    }, [number]>(
      `SELECT id, provider, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens
       FROM credit_usage
       WHERE cost_known = 0 AND (tokens_in > 0 OR tokens_out > 0)
       ORDER BY ts DESC LIMIT ?`,
    ).all(safeLimit).map((row) => ({
      id: row.id, provider: row.provider, model: row.model,
      tokensIn: row.tokens_in ?? 0, tokensOut: row.tokens_out ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0, cacheWriteTokens: row.cache_write_tokens ?? 0,
    }));
}

export function setUsageKnownCost(id: number, costUsd: number, cacheSavingsUsd = 0): void {
  getCreditDb().run(
    `UPDATE credit_usage SET cost_usd = ?, cost_known = 1, cache_savings_usd = ? WHERE id = ?`,
    [costUsd, cacheSavingsUsd, id],
  );
}

export interface PromptCacheUsageSummary {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  savingsUsd: number;
  averageTtftMs: number | null;
  averageLatencyMs: number | null;
  byProvider: Array<{
    provider: string;
    requests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    hitRate: number;
    savingsUsd: number;
    averageTtftMs: number | null;
    averageLatencyMs: number | null;
  }>;
}

/** Durable prompt-cache accounting for Cost Center / diagnostics surfaces. */
export function getPromptCacheUsageSummary(
  since = Date.now() - 30 * 24 * 60 * 60 * 1000,
): PromptCacheUsageSummary {
  const d = getCreditDb();
  const rows = d
    .query<
      {
        provider: string;
        requests: number;
        input_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        savings_usd: number;
        average_ttft_ms: number | null;
        average_latency_ms: number | null;
      },
      [number]
    >(
      `SELECT provider,
        COUNT(*) AS requests,
        SUM(tokens_in) AS input_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(cache_savings_usd) AS savings_usd,
        AVG(ttft_ms) AS average_ttft_ms,
        AVG(latency_ms) AS average_latency_ms
       FROM credit_usage
       WHERE ts >= ? AND (tokens_in > 0 OR tokens_out > 0)
       GROUP BY provider
       ORDER BY savings_usd DESC`,
    )
    .all(since);

  const byProvider = rows.map((row) => {
    const inputTokens = Math.max(0, row.input_tokens ?? 0);
    const cacheReadTokens = Math.max(0, row.cache_read_tokens ?? 0);
    return {
      provider: row.provider,
      requests: Math.max(0, row.requests ?? 0),
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens: Math.max(0, row.cache_write_tokens ?? 0),
      hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
      savingsUsd: row.savings_usd ?? 0,
      averageTtftMs: row.average_ttft_ms ?? null,
      averageLatencyMs: row.average_latency_ms ?? null,
    };
  });
  const totals = byProvider.reduce(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      inputTokens: acc.inputTokens + row.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
      savingsUsd: acc.savingsUsd + row.savingsUsd,
      weightedTtftMs:
        acc.weightedTtftMs + (row.averageTtftMs ?? 0) * (row.averageTtftMs === null ? 0 : row.requests),
      weightedLatencyMs:
        acc.weightedLatencyMs +
        (row.averageLatencyMs ?? 0) * (row.averageLatencyMs === null ? 0 : row.requests),
      ttftRequests: acc.ttftRequests + (row.averageTtftMs === null ? 0 : row.requests),
      latencyRequests: acc.latencyRequests + (row.averageLatencyMs === null ? 0 : row.requests),
    }),
    {
      requests: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      savingsUsd: 0,
      weightedTtftMs: 0,
      weightedLatencyMs: 0,
      ttftRequests: 0,
      latencyRequests: 0,
    },
  );
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    savingsUsd: totals.savingsUsd,
    hitRate: totals.inputTokens > 0 ? totals.cacheReadTokens / totals.inputTokens : 0,
    averageTtftMs: totals.ttftRequests > 0 ? totals.weightedTtftMs / totals.ttftRequests : null,
    averageLatencyMs:
      totals.latencyRequests > 0 ? totals.weightedLatencyMs / totals.latencyRequests : null,
    byProvider,
  };
}

export function getKoryAccountUsage(since = Date.now() - 30 * 24 * 60 * 60 * 1000): Array<{
  accountId: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}> {
  const d = getCreditDb();
  return d
    .query<
      {
        account_id: string;
        provider: string;
        tokens_in: number;
        tokens_out: number;
        cost_usd: number;
      },
      [number]
    >(
      `SELECT account_id, provider, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost_usd) AS cost_usd
     FROM credit_usage WHERE account_id IS NOT NULL AND ts >= ? GROUP BY account_id, provider`,
    )
    .all(since)
    .map((row) => ({
      accountId: row.account_id,
      provider: row.provider,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
    }));
}

export function getLocalTotals(): {
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  byModel: Array<{ model: string; costUsd: number; tokensIn: number; tokensOut: number }>;
} {
  const d = getCreditDb();
  const rows = d
    .query<{ model: string; cost_usd: number; tokens_in: number; tokens_out: number }, []>(
      `SELECT model, SUM(cost_usd) as cost_usd, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out
     FROM credit_usage
     GROUP BY model
     HAVING SUM(tokens_in) > 0 OR SUM(tokens_out) > 0`,
    )
    .all();

  let totalCostUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const byModel: Array<{ model: string; costUsd: number; tokensIn: number; tokensOut: number }> =
    [];

  for (const r of rows) {
    totalCostUsd += r.cost_usd;
    tokensIn += r.tokens_in;
    tokensOut += r.tokens_out;
    byModel.push({
      model: r.model,
      costUsd: r.cost_usd,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
    });
  }

  return { totalCostUsd, tokensIn, tokensOut, byModel };
}

export function getLocalTotalsByProvider(): Array<{
  provider: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}> {
  const d = getCreditDb();
  const rows = d
    .query<{ provider: string; cost_usd: number; tokens_in: number; tokens_out: number }, []>(
      `SELECT provider, SUM(cost_usd) as cost_usd, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out
       FROM credit_usage
       GROUP BY provider
       HAVING SUM(tokens_in) > 0 OR SUM(tokens_out) > 0
       ORDER BY cost_usd DESC`,
    )
    .all();

  return rows.map((row) => ({
    provider: row.provider,
    costUsd: row.cost_usd,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
  }));
}

/** Per-turn usage samples for a specific provider, for CLI usage reporting.
 *  The credit DB records every provider stream's token usage with timestamps,
 *  so we can derive windows/daily/by-model even for CLIs that don't write
 *  parseable local session logs (e.g. antigravity's trajectory is protobuf). */
export function getUsageSamplesByProvider(
  provider: string,
  since: number,
): Array<{ ts: number; model: string; tokensIn: number; tokensOut: number }> {
  const d = getCreditDb();
  return d
    .query<{ ts: number; model: string; tokens_in: number; tokens_out: number }, [string, number]>(
      `SELECT ts, model, tokens_in, tokens_out FROM credit_usage
       WHERE provider = ? AND ts >= ? AND (tokens_in > 0 OR tokens_out > 0)
       ORDER BY ts`,
    )
    .all(provider, since)
    .map((r) => ({
      ts: r.ts,
      model: r.model,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
    }));
}

export function saveCloudSnapshot(
  source: string,
  payload: string,
  totalUsedUsd?: number,
  totalGrantedUsd?: number,
  totalAvailableUsd?: number,
): void {
  const d = getCreditDb();
  d.run(
    `INSERT INTO cloud_snapshots (ts, source, payload, total_used_usd, total_granted_usd, total_available_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      source,
      payload,
      totalUsedUsd ?? null,
      totalGrantedUsd ?? null,
      totalAvailableUsd ?? null,
    ],
  );
}

export function getLatestCloudSnapshots(): Array<{
  source: string;
  ts: number;
  totalUsedUsd: number | null;
  totalGrantedUsd: number | null;
  totalAvailableUsd: number | null;
  payload: string;
}> {
  const d = getCreditDb();
  const bySource = d
    .query<
      {
        source: string;
        ts: number;
        total_used_usd: number | null;
        total_granted_usd: number | null;
        total_available_usd: number | null;
        payload: string;
      },
      []
    >(
      `SELECT c.source, c.ts, c.total_used_usd, c.total_granted_usd, c.total_available_usd, c.payload
     FROM cloud_snapshots c
     INNER JOIN (SELECT source, MAX(ts) AS max_ts FROM cloud_snapshots GROUP BY source) m
       ON c.source = m.source AND c.ts = m.max_ts
     ORDER BY c.source`,
    )
    .all();

  return bySource.map((r) => ({
    source: r.source,
    ts: r.ts,
    totalUsedUsd: r.total_used_usd,
    totalGrantedUsd: r.total_granted_usd,
    totalAvailableUsd: r.total_available_usd,
    payload: r.payload,
  }));
}
