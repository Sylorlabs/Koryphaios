/**
 * Hard Spend Caps Enforcement
 *
 * This module provides ACTUAL enforcement of spend caps - not just tracking.
 * When caps are exceeded, agents are PAUSED until manually resumed.
 */

import { db, getDb, messages, spendCapPauses } from '../db';
import { serverLog } from '../logger';
import { getContext } from '../context';
import { ValidationError } from '../errors/types';
import { eq, and, desc, gte, sql } from 'drizzle-orm';

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

export interface SpendWindowSnapshot {
  sessionHourCents: number;
  sessionDayCents: number;
  globalHourCents: number;
  globalDayCents: number;
}

export interface SpendCapViolation {
  capType: 'per_request' | 'session_hourly' | 'session_daily' | 'global_hourly' | 'global_daily';
  currentSpend: number;
  limit: number;
  reason: string;
}

const MAX_CAP_CENTS = 100_000_000;

function validateCapCents(name: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_CAP_CENTS) {
    throw new ValidationError(`${name} must be a whole number from 0 to ${MAX_CAP_CENTS} cents`);
  }
  return value as number;
}

/** Validate at the persistence boundary so direct callers cannot bypass the
 * route schema or store a config that the Settings UI cannot represent. */
export function mergeEnforcedCaps(current: EnforcedSpendCap, patch: unknown): EnforcedSpendCap {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Spend cap settings must be an object');
  }
  const input = patch as Partial<Record<keyof EnforcedSpendCap, unknown>>;
  const next: EnforcedSpendCap = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new ValidationError('enabled must be boolean');
    next.enabled = input.enabled;
  }
  for (const key of [
    'sessionHourlyCents',
    'sessionDailyCents',
    'globalHourlyCents',
    'globalDailyCents',
    'perRequestCents',
  ] as const) {
    if (input[key] !== undefined) next[key] = validateCapCents(key, input[key]);
  }
  if (input.action !== undefined) {
    if (!['pause', 'warn', 'block'].includes(String(input.action))) {
      throw new ValidationError('action must be pause, warn, or block');
    }
    next.action = input.action as EnforcedSpendCap['action'];
  }
  if (input.notifyAtPercent !== undefined) {
    if (
      !Array.isArray(input.notifyAtPercent) ||
      input.notifyAtPercent.length > 5 ||
      input.notifyAtPercent.some(
        (value) => !Number.isInteger(value) || (value as number) < 1 || (value as number) > 100,
      )
    ) {
      throw new ValidationError(
        'notifyAtPercent must contain at most five whole percentages from 1 to 100',
      );
    }
    next.notifyAtPercent = [...new Set(input.notifyAtPercent as number[])].sort(
      (left, right) => left - right,
    );
  }
  return next;
}

export function findSpendCapViolation(
  caps: EnforcedSpendCap,
  snapshot: SpendWindowSnapshot,
  estimatedCostCents = 0,
): SpendCapViolation | null {
  const candidates: Array<{
    capType: SpendCapViolation['capType'];
    currentSpend: number;
    limit: number;
    label: string;
  }> = [
    {
      capType: 'per_request',
      currentSpend: estimatedCostCents,
      limit: caps.perRequestCents,
      label: 'Request estimate',
    },
    {
      capType: 'session_hourly',
      currentSpend: snapshot.sessionHourCents,
      limit: caps.sessionHourlyCents,
      label: 'Session hourly spend',
    },
    {
      capType: 'session_daily',
      currentSpend: snapshot.sessionDayCents,
      limit: caps.sessionDailyCents,
      label: 'Session daily spend',
    },
    {
      capType: 'global_hourly',
      currentSpend: snapshot.globalHourCents,
      limit: caps.globalHourlyCents,
      label: 'App hourly spend',
    },
    {
      capType: 'global_daily',
      currentSpend: snapshot.globalDayCents,
      limit: caps.globalDailyCents,
      label: 'App daily spend',
    },
  ];
  for (const candidate of candidates) {
    if (candidate.limit <= 0 || candidate.currentSpend < candidate.limit) continue;
    return {
      capType: candidate.capType,
      currentSpend: candidate.currentSpend,
      limit: candidate.limit,
      reason: `${candidate.label} limit reached ($${(candidate.currentSpend / 100).toFixed(2)} / $${(candidate.limit / 100).toFixed(2)})`,
    };
  }
  return null;
}

// In-memory tracking of paused sessions
const pausedSessions = new Map<string, PauseRecord>();

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
    );`,
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
  pausedSessions.clear();
  const activeRows = sqlite
    .query(
      `SELECT session_id, paused_at, reason, cap_type, current_spend_cents, limit_cents,
              manually_resumed
       FROM spend_cap_pauses
       WHERE resumed_at IS NULL
       ORDER BY paused_at ASC`,
    )
    .all() as Array<{
    session_id: string;
    paused_at: number;
    reason: string;
    cap_type: string;
    current_spend_cents: number;
    limit_cents: number;
    manually_resumed: number;
  }>;
  for (const row of activeRows) {
    pausedSessions.set(row.session_id, {
      sessionId: row.session_id,
      pausedAt: row.paused_at,
      reason: row.reason,
      capType: row.cap_type,
      currentSpend: row.current_spend_cents,
      limit: row.limit_cents,
      manuallyResumed: row.manually_resumed === 1,
    });
  }
  serverLog.info({ recoveredPauses: pausedSessions.size }, 'Enforced spend caps initialized');
}

export async function getEnforcedCaps(): Promise<EnforcedSpendCap> {
  ensureSpendCapsTables();
  const sqlite = getDb();
  const row = sqlite
    .query('SELECT value FROM spend_cap_config WHERE key = ? LIMIT 1')
    .get('default') as { value?: string } | null;

  if (!row || typeof row.value !== 'string' || !row.value.trim()) {
    sqlite
      .query(
        'INSERT INTO spend_cap_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run('default', JSON.stringify(DEFAULT_ENFORCED_CAPS), Date.now());
    return { ...DEFAULT_ENFORCED_CAPS };
  }

  try {
    return mergeEnforcedCaps(DEFAULT_ENFORCED_CAPS, JSON.parse(row.value));
  } catch (error) {
    serverLog.warn({ error }, 'Invalid enforced caps config; resetting to defaults');
    sqlite
      .query(
        'INSERT INTO spend_cap_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run('default', JSON.stringify(DEFAULT_ENFORCED_CAPS), Date.now());
    return { ...DEFAULT_ENFORCED_CAPS };
  }
}

export async function setEnforcedCaps(
  config: Partial<EnforcedSpendCap>,
): Promise<EnforcedSpendCap> {
  const current = await getEnforcedCaps();
  const updated = mergeEnforcedCaps(current, config);
  const now = Date.now();
  getDb()
    .query(
      'INSERT INTO spend_cap_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run('default', JSON.stringify(updated), now);
  getContext().wsManager?.broadcast({
    type: 'system.info',
    payload: { message: 'Spend limits updated', config: updated },
    timestamp: now,
  });
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
  await db.insert(spendCapPauses).values({
    sessionId,
    pausedAt: new Date(record.pausedAt),
    reason,
    capType,
    currentSpendCents: currentSpend,
    limitCents: limit,
  });
  pausedSessions.set(sessionId, record);
  getContext().wsManager?.broadcast({
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
  try {
    await db
      .update(spendCapPauses)
      .set({ resumedAt: new Date(), manuallyResumed: 1 })
      .where(and(eq(spendCapPauses.sessionId, sessionId), sql`resumed_at IS NULL`));
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to update pause record');
    return false;
  }
  record.manuallyResumed = true;
  pausedSessions.delete(sessionId);
  getContext().wsManager?.broadcast({
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

async function recordedCostCents(sessionId: string | undefined, since: Date): Promise<number> {
  const predicates = [gte(messages.createdAt, since)];
  if (sessionId) predicates.push(eq(messages.sessionId, sessionId));
  const [row] = await db
    .select({ totalCostUsd: sql<number>`COALESCE(SUM(${messages.cost}), 0)` })
    .from(messages)
    .where(and(...predicates));
  const dollars = Number(row?.totalCostUsd ?? 0);
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error('Recorded spend is invalid');
  }
  return Math.round(dollars * 100);
}

export async function getSpendWindowSnapshot(
  sessionId: string,
  now = Date.now(),
): Promise<SpendWindowSnapshot> {
  const hourStart = new Date(now - 60 * 60 * 1000);
  const dayStart = new Date(now - 24 * 60 * 60 * 1000);
  const [sessionHourCents, sessionDayCents, globalHourCents, globalDayCents] = await Promise.all([
    recordedCostCents(sessionId, hourStart),
    recordedCostCents(sessionId, dayStart),
    recordedCostCents(undefined, hourStart),
    recordedCostCents(undefined, dayStart),
  ]);
  return { sessionHourCents, sessionDayCents, globalHourCents, globalDayCents };
}

export async function checkAndEnforceCaps(
  sessionId: string,
  estimatedCostCents: number = 0,
): Promise<{ canProceed: boolean; reason?: string; paused?: boolean }> {
  try {
    const caps = await getEnforcedCaps();
    if (!caps.enabled) return { canProceed: true };
    if (pausedSessions.has(sessionId)) {
      const record = pausedSessions.get(sessionId)!;
      return {
        canProceed: false,
        reason: `This session is paused by a spend limit: ${record.reason}. Resume it from Settings > Safety limits after reviewing the recorded usage.`,
        paused: true,
      };
    }

    const snapshot = await getSpendWindowSnapshot(sessionId);
    const violation = findSpendCapViolation(caps, snapshot, estimatedCostCents);
    if (!violation) return { canProceed: true };
    if (caps.action === 'warn') {
      return { canProceed: true, reason: violation.reason };
    }
    if (caps.action === 'pause') {
      await pauseSession(
        sessionId,
        violation.reason,
        violation.capType,
        violation.currentSpend,
        violation.limit,
      );
      return { canProceed: false, reason: violation.reason, paused: true };
    }
    return { canProceed: false, reason: violation.reason, paused: false };
  } catch (error) {
    serverLog.error({ error, sessionId }, 'Could not verify spend limits');
    return {
      canProceed: false,
      reason:
        'Koryphaios could not verify the configured spend limits, so no provider request was started. Check the local database and retry.',
      paused: false,
    };
  }
}

export interface SpendCapPauseRecord {
  id: string;
  sessionId: string;
  pausedAt: number;
  resumedAt?: number;
  reason: string | null;
  capType: string;
  currentSpend: number;
  limit: number;
  manuallyResumed: boolean;
}

export async function getPauseHistory(
  sessionId?: string,
  limit: number = 100,
): Promise<SpendCapPauseRecord[]> {
  try {
    const rows = await db
      .select()
      .from(spendCapPauses)
      .where(sessionId ? eq(spendCapPauses.sessionId, sessionId) : undefined)
      .orderBy(desc(spendCapPauses.pausedAt))
      .limit(limit);
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
