// Spend Caps and Quota Enforcement
// Tracks usage per session and enforces automatic shutoff when limits are reached

import { db, sessionUsage as sessionUsageTable } from '../db';
import { serverLog } from '../logger';
import { eq, gt, sql } from 'drizzle-orm';

export interface SessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number; // in cents
  commandCount: number;
  startTime: number;
  lastActivity: number;
}

export interface SpendCap {
  hourlyCapCents?: number;
  dailyCapCents?: number;
  monthlyCapCents?: number;
  maxSessionLengthMs?: number;
  maxTokensPerHour?: number;
  maxCommandsPerHour?: number;
}

export const DEFAULT_SPEND_CAPS: SpendCap = {
  hourlyCapCents: 100,
  dailyCapCents: 1000,
  monthlyCapCents: 10000,
  maxSessionLengthMs: 4 * 60 * 60 * 1000,
  maxTokensPerHour: 50_000,
  maxCommandsPerHour: 200,
};

export const FREE_TIER_SPEND_CAPS: SpendCap = {
  hourlyCapCents: 10,
  dailyCapCents: 50,
  monthlyCapCents: 500,
  maxSessionLengthMs: 30 * 60 * 1000,
  maxTokensPerHour: 5_000,
  maxCommandsPerHour: 20,
};

const usageCache = new Map<string, SessionUsage>();

export async function recordSessionUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  costCents: number,
): Promise<void> {
  const now = new Date();
  let usage = usageCache.get(sessionId);
  if (!usage) {
    usage = {
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      commandCount: 0,
      startTime: now.getTime(),
      lastActivity: now.getTime(),
    };
  }
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalCost += costCents;
  usage.commandCount += 1;
  usage.lastActivity = now.getTime();
  usageCache.set(sessionId, usage);

  try {
    await db
      .insert(sessionUsageTable)
      .values({
        sessionId,
        inputTokens,
        outputTokens,
        totalCostCents: costCents,
        commandCount: 1,
        startTime: now,
        lastActivity: now,
      })
      .onConflictDoUpdate({
        target: sessionUsageTable.sessionId,
        set: {
          inputTokens: sql`${sessionUsageTable.inputTokens} + ${inputTokens}`,
          outputTokens: sql`${sessionUsageTable.outputTokens} + ${outputTokens}`,
          totalCostCents: sql`${sessionUsageTable.totalCostCents} + ${costCents}`,
          commandCount: sql`${sessionUsageTable.commandCount} + 1`,
          lastActivity: now,
        },
      });
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to persist session usage');
  }
}

export async function getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
  const cached = usageCache.get(sessionId);
  if (cached) return cached;
  try {
    const [row] = await db
      .select()
      .from(sessionUsageTable)
      .where(eq(sessionUsageTable.sessionId, sessionId))
      .limit(1);
    if (!row) return null;
    const usage: SessionUsage = {
      sessionId: row.sessionId,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      totalCost: row.totalCostCents || 0,
      commandCount: row.commandCount || 0,
      startTime: row.startTime.getTime(),
      lastActivity: row.lastActivity.getTime(),
    };
    usageCache.set(sessionId, usage);
    return usage;
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to get session usage');
    return null;
  }
}

export async function checkSpendCaps(
  sessionId: string,
  caps: SpendCap = DEFAULT_SPEND_CAPS,
): Promise<{ allowed: boolean; reason?: string; currentUsage?: SessionUsage; limits?: SpendCap }> {
  const usage = await getSessionUsage(sessionId);
  if (!usage) return { allowed: true };
  const now = Date.now();
  const ageMs = now - usage.startTime;
  if (caps.hourlyCapCents && usage.totalCost > caps.hourlyCapCents && ageMs > 5 * 60 * 1000)
    return {
      allowed: false,
      reason: `Hourly spend cap exceeded`,
      currentUsage: usage,
      limits: caps,
    };
  if (caps.dailyCapCents && usage.totalCost > caps.dailyCapCents)
    return {
      allowed: false,
      reason: `Daily spend cap exceeded`,
      currentUsage: usage,
      limits: caps,
    };
  return { allowed: true, currentUsage: usage, limits: caps };
}

export async function getGlobalSpendStats(
  timeframe: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day',
): Promise<{
  totalCostCents: number;
  totalTokens: number;
  totalCommands: number;
  activeSessions: number;
}> {
  try {
    const now = Date.now();
    let cutoff = 0;
    if (timeframe === 'hour') cutoff = now - 60 * 60 * 1000;
    else if (timeframe === 'day') cutoff = now - 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoff);
    const [row] = await db
      .select({
        total_cost: sql<number>`SUM(total_cost_cents)`,
        total_tokens: sql<number>`SUM(input_tokens + output_tokens)`,
        total_commands: sql<number>`SUM(command_count)`,
        active_sessions: sql<number>`COUNT(DISTINCT session_id)`,
      })
      .from(sessionUsageTable)
      .where(gt(sessionUsageTable.lastActivity, cutoffDate));
    return {
      totalCostCents: row?.total_cost || 0,
      totalTokens: row?.total_tokens || 0,
      totalCommands: row?.total_commands || 0,
      activeSessions: row?.active_sessions || 0,
    };
  } catch (err) {
    return { totalCostCents: 0, totalTokens: 0, totalCommands: 0, activeSessions: 0 };
  }
}

export async function checkGlobalSpendCaps(): Promise<{
  allowed: boolean;
  reason?: string;
  stats?: any;
}> {
  const dailyStats = await getGlobalSpendStats('day');
  const caps = getSpendCaps();
  const globalDailyCap = caps.dailyCapCents ? caps.dailyCapCents * 10 : undefined;
  if (globalDailyCap && dailyStats.totalCostCents > globalDailyCap)
    return { allowed: false, reason: `Global daily spend cap exceeded`, stats: dailyStats };
  return { allowed: true, stats: dailyStats };
}

export function getSpendCaps(): SpendCap {
  return DEFAULT_SPEND_CAPS;
}
export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
export async function resetSessionUsage(sessionId: string): Promise<void> {
  usageCache.delete(sessionId);
  await db.delete(sessionUsageTable).where(eq(sessionUsageTable.sessionId, sessionId));
}
