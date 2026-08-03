/**
 * CreditAccountant local storage: sylorlabs.db (SQLite).
 * Tracks token usage → local cost estimate and cloud reconciliation snapshots.
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { serverLog } from '../logger';
import { ensureSecureDir, hardenFilePermissions } from '../security/fs-permissions';

let db: Database | null = null;

export function initCreditDb(dataDir: string): void {
  if (db) return;
  ensureSecureDir(dataDir);
  const dbPath = join(dataDir, 'sylorlabs.db');
  db = new Database(dbPath);
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
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_credit_usage_ts ON credit_usage(ts);
  `);
  // Existing installations predate account-scoped attribution. These are
  // additive and preserve every old aggregate record as unattributed.
  for (const sql of [
    'ALTER TABLE credit_usage ADD COLUMN account_id TEXT',
    'ALTER TABLE credit_usage ADD COLUMN session_id TEXT',
  ]) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_credit_usage_account_ts ON credit_usage(account_id, ts);');

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

export function recordUsage(
  model: string,
  provider: string,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
  attribution?: { accountId?: string; sessionId?: string },
): void {
  const d = getCreditDb();
  d.run(
    `INSERT INTO credit_usage (ts, model, provider, account_id, session_id, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Date.now(), model, provider, attribution?.accountId ?? null, attribution?.sessionId ?? null, tokensIn, tokensOut, costUsd],
  );
}

export function getKoryAccountUsage(since = Date.now() - 30 * 24 * 60 * 60 * 1000): Array<{
  accountId: string; provider: string; tokensIn: number; tokensOut: number; costUsd: number;
}> {
  const d = getCreditDb();
  return d.query<{ account_id: string; provider: string; tokens_in: number; tokens_out: number; cost_usd: number }, [number]>(
    `SELECT account_id, provider, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost_usd) AS cost_usd
     FROM credit_usage WHERE account_id IS NOT NULL AND ts >= ? GROUP BY account_id, provider`,
  ).all(since).map((row) => ({ accountId: row.account_id, provider: row.provider, tokensIn: row.tokens_in, tokensOut: row.tokens_out, costUsd: row.cost_usd }));
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
