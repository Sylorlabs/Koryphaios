// Spend Caps and Quota Enforcement
// Tracks usage per session and enforces automatic shutoff when limits are reached

import { db, messages, sessionUsage as sessionUsageTable } from '../db';
import { serverLog } from '../logger';
import { eq, gte, sql } from 'drizzle-orm';

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
  try {
    const [row] = await db
      .select({
        messageCount: sql<number>`COUNT(*)`,
        inputTokens: sql<number>`COALESCE(SUM(${messages.tokensIn}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${messages.tokensOut}), 0)`,
        totalCostUsd: sql<number>`COALESCE(SUM(${messages.cost}), 0)`,
        providerTurns: sql<number>`COALESCE(SUM(CASE WHEN ${messages.role} = 'assistant' AND ${messages.provider} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        startTime: sql<number>`MIN(${messages.createdAt})`,
        lastActivity: sql<number>`MAX(${messages.createdAt})`,
      })
      .from(messages)
      .where(eq(messages.sessionId, sessionId));
    if (!row || Number(row.messageCount) === 0) return null;
    return {
      sessionId,
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      totalCost: Math.round((Number(row.totalCostUsd) || 0) * 100),
      // This legacy field now represents recorded provider turns. Durable
      // tool-command counts do not exist in this table, so we do not invent them.
      commandCount: Number(row.providerTurns) || 0,
      startTime: Number(row.startTime),
      lastActivity: Number(row.lastActivity),
    };
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to get session usage');
    throw err;
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
    const durations: Partial<Record<typeof timeframe, number>> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = durations[timeframe] ? new Date(now - durations[timeframe]!) : null;
    let query = db
      .select({
        totalCostUsd: sql<number>`COALESCE(SUM(${messages.cost}), 0)`,
        totalTokens: sql<number>`COALESCE(SUM(${messages.tokensIn} + ${messages.tokensOut}), 0)`,
        providerTurns: sql<number>`COALESCE(SUM(CASE WHEN ${messages.role} = 'assistant' AND ${messages.provider} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        activeSessions: sql<number>`COUNT(DISTINCT ${messages.sessionId})`,
      })
      .from(messages);
    if (cutoff) query = query.where(gte(messages.createdAt, cutoff)) as typeof query;
    const [row] = await query;
    return {
      totalCostCents: Math.round((Number(row?.totalCostUsd) || 0) * 100),
      totalTokens: Number(row?.totalTokens) || 0,
      // Kept for API compatibility; this is the number of recorded provider
      // turns, not a guessed count of shell/tool commands.
      totalCommands: Number(row?.providerTurns) || 0,
      activeSessions: Number(row?.activeSessions) || 0,
    };
  } catch (err) {
    serverLog.error({ err, timeframe }, 'Failed to read recorded provider usage');
    throw err;
  }
}

export async function checkGlobalSpendCaps(): Promise<{
  allowed: boolean;
  reason?: string;
  stats?: {
    totalCostCents: number;
    totalTokens: number;
    totalCommands: number;
    activeSessions: number;
  };
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
