/**
 * Hard Spend Caps Enforcement
 *
 * This module provides ACTUAL enforcement of spend caps - not just tracking.
 * When caps are exceeded, agents are PAUSED until manually resumed.
 */

import { db, getDb, spendCapPauses, spendCapConfig } from '../db';
import { serverLog } from '../logger';
import { wsManager } from '../ws/ws-manager';
import { eq, and, desc, sql } from 'drizzle-orm';

export interface EnforcedSpendCap {
  enabled: boolean;
  sessionHourlyCents: number;
  sessionDailyCents: number;
  globalHourlyCents: number;
  globalDailyCents: number;
  perRequestCents: number;
  action: 'pause' | 'warn' | 'block';
  notifyAtPercent: number[]; // [80, 95] = notify at 80% and 95%
}

export const DEFAULT_ENFORCED_CAPS: EnforcedSpendCap = {
  enabled: true,
  sessionHourlyCents: 200, // $2/hour per session
  sessionDailyCents: 1000, // $10/day per session
  globalHourlyCents: 1000, // $10/hour globally
  globalDailyCents: 5000, // $50/day globally
  perRequestCents: 50, // $0.50 max per request
  action: 'pause', // Default: pause agents
  notifyAtPercent: [80, 95],
};

export interface PauseRecord {
  sessionId: string;
  pausedAt: number;
  reason: string;
  capType: string;
  currentSpend: number;
  limit: number;
  manuallyResumed: boolean;
}

// In-memory tracking of paused sessions
const pausedSessions = new Map<string, PauseRecord>();
const notifiedThresholds = new Map<string, Set<number>>();

function ensureSpendCapsTables(): void {
  const sqlite = getDb();
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS spend_cap_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS spend_cap_pauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      paused_at INTEGER NOT NULL,
      resumed_at INTEGER,
      reason TEXT NOT NULL,
      cap_type TEXT NOT NULL,
      current_spend_cents INTEGER NOT NULL,
      limit_cents INTEGER NOT NULL,
      manually_resumed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );`
  );
}

export function isSessionPaused(sessionId: string): boolean {
  return pausedSessions.has(sessionId);
}

export function getSessionPauseRecord(sessionId: string): PauseRecord | undefined {
  return pausedSessions.get(sessionId);
}

export function getAllPausedSessions(): PauseRecord[] {
  return Array.from(pausedSessions.values());
}

export async function initEnforcedSpendCapsTable(): Promise<void> {
  ensureSpendCapsTables();
  const sqlite = getDb();
  const existing = sqlite
    .query('SELECT value FROM spend_cap_config WHERE key = ? LIMIT 1')
    .get('default') as { value?: string } | null;

  if (!existing) {
    sqlite
      .query(
        'INSERT INTO spend_cap_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run('default', JSON.stringify(DEFAULT_ENFORCED_CAPS), Date.now());
  }
  serverLog.info('Enforced spend caps table initialized');
}

export async function getEnforcedCaps(): Promise<EnforcedSpendCap> {
  try {
    ensureSpendCapsTables();
    const sqlite = getDb();
    const row = sqlite
      .query('SELECT value FROM spend_cap_config WHERE key = ? LIMIT 1')
      .get('default') as { value?: string } | null;

    if (!row || typeof row.value !== 'string') return DEFAULT_ENFORCED_CAPS;

    const trimmed = row.value.trim();
    if (!trimmed) return DEFAULT_ENFORCED_CAPS;

    try {
      const parsed = JSON.parse(trimmed) as Partial<EnforcedSpendCap>;
      if (!parsed || Array.isArray(parsed)) return DEFAULT_ENFORCED_CAPS;
      return { ...DEFAULT_ENFORCED_CAPS, ...parsed };
    } catch (error) {
      serverLog.warn(
        { error, rawValue: trimmed },
        'Invalid enforced caps config; resetting to defaults',
      );
      sqlite
        .query(
          'INSERT INTO spend_cap_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .run('default', JSON.stringify(DEFAULT_ENFORCED_CAPS), Date.now());
      return DEFAULT_ENFORCED_CAPS;
    }
  } catch (err) {
    serverLog.error({ err }, 'Failed to load enforced caps config');
  }
  return DEFAULT_ENFORCED_CAPS;
}

export async function setEnforcedCaps(
  config: Partial<EnforcedSpendCap>,
): Promise<EnforcedSpendCap> {
  const current = await getEnforcedCaps();
  const updated = { ...current, ...config };
  try {
    ensureSpendCapsTables();
    await db
      .insert(spendCapConfig)
      .values({
        key: 'default',
        value: JSON.stringify(updated),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: spendCapConfig.key,
        set: {
          value: JSON.stringify(updated),
          updatedAt: new Date(),
        },
      });
    wsManager?.broadcast({
      type: 'system.info',
      payload: { message: 'Spend caps updated', config: updated },
      timestamp: Date.now(),
    });
  } catch (err) {
    serverLog.error({ err }, 'Failed to save enforced caps config');
  }
  return updated;
}

export async function pauseSession(
  sessionId: string,
  reason: string,
  capType: string,
  currentSpend: number,
  limit: number,
): Promise<void> {
  if (pausedSessions.has(sessionId)) return;
  const record: PauseRecord = {
    sessionId,
    pausedAt: Date.now(),
    reason,
    capType,
    currentSpend,
    limit,
    manuallyResumed: false,
  };
  pausedSessions.set(sessionId, record);
  try {
    await db.insert(spendCapPauses).values({
      sessionId,
      pausedAt: new Date(record.pausedAt),
      reason,
      capType,
      currentSpendCents: currentSpend,
      limitCents: limit,
    });
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to persist pause record');
  }
  wsManager?.broadcast({
    type: 'session.updated',
    payload: {
      sessionId,
      updates: {
        workflowState: 'paused',
        pauseReason: reason,
        capType,
        currentSpend,
        limit,
        pausedAt: record.pausedAt,
      },
    },
    timestamp: Date.now(),
    sessionId,
  });
}

export async function resumeSession(sessionId: string, userId?: string): Promise<boolean> {
  const record = pausedSessions.get(sessionId);
  if (!record) return false;
  record.manuallyResumed = true;
  pausedSessions.delete(sessionId);
  try {
    await db
      .update(spendCapPauses)
      .set({ resumedAt: new Date(), manuallyResumed: 1 })
      .where(and(eq(spendCapPauses.sessionId, sessionId), sql`resumed_at IS NULL`));
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to update pause record');
  }
  notifiedThresholds.delete(sessionId);
  wsManager?.broadcast({
    type: 'session.updated',
    payload: {
      sessionId,
      updates: { workflowState: 'idle', resumedAt: Date.now(), manuallyResumed: true, userId },
    },
    timestamp: Date.now(),
    sessionId,
  });
  return true;
}

export async function checkAndEnforceCaps(
  sessionId: string,
  estimatedCostCents: number = 0,
): Promise<{ canProceed: boolean; reason?: string; paused?: boolean }> {
  const caps = await getEnforcedCaps();
  if (!caps.enabled) return { canProceed: true };
  if (pausedSessions.has(sessionId)) {
    const record = pausedSessions.get(sessionId)!;
    return {
      canProceed: false,
      reason: `Session is PAUSED: ${record.reason}. Click Resume to override.`,
      paused: true,
    };
  }
  const { getSessionUsage, getGlobalSpendStats } = await import('./spend-caps');
  const sessionUsage = await getSessionUsage(sessionId);
  const globalStats = await getGlobalSpendStats('hour');
  const sessionCost = sessionUsage?.totalCost || 0;
  const globalCost = globalStats.totalCostCents;

  if (caps.perRequestCents > 0 && estimatedCostCents > caps.perRequestCents) {
    const reason = `Request cost ($${(estimatedCostCents / 100).toFixed(2)}) exceeds per-request cap ($${(caps.perRequestCents / 100).toFixed(2)})`;
    if (caps.action === 'block' || caps.action === 'pause') {
      await pauseSession(
        sessionId,
        reason,
        'per_request',
        estimatedCostCents,
        caps.perRequestCents,
      );
      return { canProceed: false, reason, paused: true };
    }
    return { canProceed: true, reason };
  }
  if (caps.sessionHourlyCents > 0 && sessionCost > caps.sessionHourlyCents) {
    const reason = `Session hourly spend cap exceeded ($${(sessionCost / 100).toFixed(2)} / $${(caps.sessionHourlyCents / 100).toFixed(2)})`;
    if (caps.action === 'block' || caps.action === 'pause') {
      await pauseSession(sessionId, reason, 'session_hourly', sessionCost, caps.sessionHourlyCents);
      return { canProceed: false, reason, paused: true };
    }
    return { canProceed: true, reason };
  }
  return { canProceed: true };
}

export async function getPauseHistory(sessionId?: string, limit: number = 100): Promise<any[]> {
  try {
    let query = db.select().from(spendCapPauses);
    if (sessionId) query = query.where(eq(spendCapPauses.sessionId, sessionId)) as any;
    const rows = await query.orderBy(desc(spendCapPauses.pausedAt)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      pausedAt: r.pausedAt.getTime(),
      resumedAt: r.resumedAt ? r.resumedAt.getTime() : undefined,
      reason: r.reason,
      capType: r.capType,
      currentSpend: r.currentSpendCents,
      limit: r.limitCents,
      manuallyResumed: !!r.manuallyResumed,
    }));
  } catch (err) {
    serverLog.error({ err }, 'Failed to get pause history');
    return [];
  }
}
