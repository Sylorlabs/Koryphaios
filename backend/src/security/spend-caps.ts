// Spend Caps and Quota Enforcement
// Tracks usage per session and enforces automatic shutoff when limits are reached

import { getDb } from "../db/sqlite";
import { serverLog } from "../logger";

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
  hourlyCapCents: 100,        // $1.00 per hour
  dailyCapCents: 1000,        // $10.00 per day
  monthlyCapCents: 10000,     // $100.00 per month
  maxSessionLengthMs: 4 * 60 * 60 * 1000, // 4 hours
  maxTokensPerHour: 50_000,
  maxCommandsPerHour: 200,
};

export const FREE_TIER_SPEND_CAPS: SpendCap = {
  hourlyCapCents: 10,         // $0.10 per hour
  dailyCapCents: 50,          // $0.50 per day
  monthlyCapCents: 500,       // $5.00 per month
  maxSessionLengthMs: 30 * 60 * 1000, // 30 minutes
  maxTokensPerHour: 5_000,
  maxCommandsPerHour: 20,
};

// In-memory cache for session usage (fallback to DB if needed)
const usageCache = new Map<string, SessionUsage>();

/**
 * Initialize the spend caps table.
 */
export function initSpendCapsTable(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS session_usage (
      session_id TEXT PRIMARY KEY,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_cost_cents INTEGER DEFAULT 0,
      command_count INTEGER DEFAULT 0,
      start_time INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_session_usage_time ON session_usage(last_activity)`);

  serverLog.info("Spend caps table initialized");
}

/**
 * Record usage for a session.
 */
export function recordSessionUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  costCents: number
): void {
  const now = Date.now();

  // Update cache
  let usage = usageCache.get(sessionId);
  if (!usage) {
    usage = {
      sessionId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      commandCount: 0,
      startTime: now,
      lastActivity: now,
    };
  }

  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  usage.totalCost += costCents;
  usage.commandCount += 1;
  usage.lastActivity = now;

  usageCache.set(sessionId, usage);

  // Persist to DB
  try {
    const db = getDb();
    db.run(`
      INSERT INTO session_usage (session_id, input_tokens, output_tokens, total_cost_cents, command_count, start_time, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        total_cost_cents = total_cost_cents + ?,
        command_count = command_count + 1,
        last_activity = ?
    `, [sessionId, inputTokens, outputTokens, costCents, 0, now, now,
        inputTokens, outputTokens, costCents, now]);
  } catch (err) {
    serverLog.error({ err, sessionId }, "Failed to persist session usage");
  }
}

/**
 * Get session usage from cache or DB.
 */
export function getSessionUsage(sessionId: string): SessionUsage | null {
  // Check cache first
  const cached = usageCache.get(sessionId);
  if (cached) {
    return cached;
  }

  // Fall back to DB
  try {
    const db = getDb();
    const row = db.query(
      `SELECT * FROM session_usage WHERE session_id = ?`
    ).get(sessionId) as any;

    if (!row) return null;

    const usage: SessionUsage = {
      sessionId: row.session_id,
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      totalCost: row.total_cost_cents || 0,
      commandCount: row.command_count || 0,
      startTime: row.start_time,
      lastActivity: row.last_activity,
    };

    // Cache it
    usageCache.set(sessionId, usage);
    return usage;
  } catch (err) {
    serverLog.error({ err, sessionId }, "Failed to get session usage");
    return null;
  }
}

/**
 * Check if a session has exceeded its spend caps.
 */
export function checkSpendCaps(
  sessionId: string,
  caps: SpendCap = DEFAULT_SPEND_CAPS
): {
  allowed: boolean;
  reason?: string;
  currentUsage?: SessionUsage;
  limits?: SpendCap;
} {
  const usage = getSessionUsage(sessionId);
  if (!usage) {
    return { allowed: true }; // No usage yet, allow
  }

  const now = Date.now();
  const sessionAgeMs = now - usage.startTime;
  const sessionAgeHours = sessionAgeMs / (60 * 60 * 1000);

  // Check hourly cap
  if (caps.hourlyCapCents && usage.totalCost > caps.hourlyCapCents) {
    // Only enforce if we've been in the session for at least 5 minutes
    // (prevents false positives from initial setup)
    if (sessionAgeMs > 5 * 60 * 1000) {
      return {
        allowed: false,
        reason: `Hourly spend cap exceeded ($${(usage.totalCost / 100).toFixed(2)} / $${(caps.hourlyCapCents / 100).toFixed(2)})`,
        currentUsage: usage,
        limits: caps,
      };
    }
  }

  // Check daily cap
  if (caps.dailyCapCents && usage.totalCost > caps.dailyCapCents) {
    return {
      allowed: false,
      reason: `Daily spend cap exceeded ($${(usage.totalCost / 100).toFixed(2)} / $${(caps.dailyCapCents / 100).toFixed(2)})`,
      currentUsage: usage,
      limits: caps,
    };
  }

  // Check monthly cap
  if (caps.monthlyCapCents && usage.totalCost > caps.monthlyCapCents) {
    return {
      allowed: false,
      reason: `Monthly spend cap exceeded ($${(usage.totalCost / 100).toFixed(2)} / $${(caps.monthlyCapCents / 100).toFixed(2)})`,
      currentUsage: usage,
      limits: caps,
    };
  }

  // Check session length
  if (caps.maxSessionLengthMs && sessionAgeMs > caps.maxSessionLengthMs) {
    return {
      allowed: false,
      reason: `Maximum session length exceeded (${Math.floor(sessionAgeMs / 60000)} minutes / ${Math.floor(caps.maxSessionLengthMs / 60000)} minutes)`,
      currentUsage: usage,
      limits: caps,
    };
  }

  // Check tokens per hour (rough estimate)
  if (caps.maxTokensPerHour && sessionAgeHours > 0.5) {
    const tokensPerHour = (usage.inputTokens + usage.outputTokens) / sessionAgeHours;
    if (tokensPerHour > caps.maxTokensPerHour) {
      return {
        allowed: false,
        reason: `Token rate limit exceeded (${Math.floor(tokensPerHour)} tokens/hour / ${caps.maxTokensPerHour} tokens/hour)`,
        currentUsage: usage,
        limits: caps,
      };
    }
  }

  // Check commands per hour
  if (caps.maxCommandsPerHour && sessionAgeHours > 0.5) {
    const commandsPerHour = usage.commandCount / sessionAgeHours;
    if (commandsPerHour > caps.maxCommandsPerHour) {
      return {
        allowed: false,
        reason: `Command rate limit exceeded (${Math.floor(commandsPerHour)} commands/hour / ${caps.maxCommandsPerHour} commands/hour)`,
        currentUsage: usage,
        limits: caps,
      };
    }
  }

  return { allowed: true, currentUsage: usage, limits: caps };
}

/**
 * Reset session usage (for testing or admin reset).
 */
export function resetSessionUsage(sessionId: string): void {
  usageCache.delete(sessionId);

  try {
    const db = getDb();
    db.run(`DELETE FROM session_usage WHERE session_id = ?`, [sessionId]);
    serverLog.info({ sessionId }, "Session usage reset");
  } catch (err) {
    serverLog.error({ err, sessionId }, "Failed to reset session usage");
  }
}

/**
 * Get global spend statistics.
 */
export function getGlobalSpendStats(timeframe: "hour" | "day" | "week" | "month" | "all" = "day"): {
  totalCostCents: number;
  totalTokens: number;
  totalCommands: number;
  activeSessions: number;
} {
  try {
    const db = getDb();

    let timeCondition = "";
    const now = Date.now();

    switch (timeframe) {
      case "hour":
        timeCondition = `WHERE last_activity > ${now - 60 * 60 * 1000}`;
        break;
      case "day":
        timeCondition = `WHERE last_activity > ${now - 24 * 60 * 60 * 1000}`;
        break;
      case "week":
        timeCondition = `WHERE last_activity > ${now - 7 * 24 * 60 * 60 * 1000}`;
        break;
      case "month":
        timeCondition = `WHERE last_activity > ${now - 30 * 24 * 60 * 60 * 1000}`;
        break;
    }

    const row = db.query(`
      SELECT
        COALESCE(SUM(total_cost_cents), 0) as total_cost,
        COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
        COALESCE(SUM(command_count), 0) as total_commands,
        COUNT(DISTINCT session_id) as active_sessions
      FROM session_usage
      ${timeCondition}
    `).get() as any;

    return {
      totalCostCents: row.total_cost || 0,
      totalTokens: row.total_tokens || 0,
      totalCommands: row.total_commands || 0,
      activeSessions: row.active_sessions || 0,
    };
  } catch (err) {
    serverLog.error({ err }, "Failed to get global spend stats");
    return {
      totalCostCents: 0,
      totalTokens: 0,
      totalCommands: 0,
      activeSessions: 0,
    };
  }
}

/**
 * Clean up old session usage records.
 */
export function cleanupOldUsageRecords(daysToKeep: number = 30): number {
  try {
    const db = getDb();
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const result = db.run(
      `DELETE FROM session_usage WHERE last_activity < ?`, [cutoffTime]
    );

    // Also clean up cache
    for (const [sessionId, usage] of usageCache.entries()) {
      if (usage.lastActivity < cutoffTime) {
        usageCache.delete(sessionId);
      }
    }

    serverLog.info({ deleted: result.changes, daysToKeep }, "Cleaned up old session usage records");

    return result.changes;
  } catch (err) {
    serverLog.error({ err }, "Failed to cleanup old usage records");
    return 0;
  }
}

/**
 * Get spend caps from environment or use defaults.
 */
export function getSpendCaps(): SpendCap {
  // Check for custom spend caps in environment
  if (process.env.KORYPHAIOS_SPEND_CAPS) {
    try {
      const custom = JSON.parse(process.env.KORYPHAIOS_SPEND_CAPS);
      return { ...DEFAULT_SPEND_CAPS, ...custom };
    } catch (err) {
      serverLog.warn({ err }, "Failed to parse KORYPHAIOS_SPEND_CAPS, using defaults");
    }
  }

  // Use free tier caps if specified
  if (process.env.KORYPHAIOS_TIER === "free") {
    return FREE_TIER_SPEND_CAPS;
  }

  return DEFAULT_SPEND_CAPS;
}

/**
 * Check if the system is in "shutoff mode" due to exceeding global caps.
 */
export function checkGlobalSpendCaps(): {
  allowed: boolean;
  reason?: string;
  stats?: ReturnType<typeof getGlobalSpendStats>;
} {
  const dailyStats = getGlobalSpendStats("day");
  const monthlyStats = getGlobalSpendStats("month");

  const caps = getSpendCaps();

  // Check daily global cap (10x the per-session cap by default)
  const globalDailyCap = caps.dailyCapCents ? caps.dailyCapCents * 10 : undefined;
  if (globalDailyCap && dailyStats.totalCostCents > globalDailyCap) {
    return {
      allowed: false,
      reason: `Global daily spend cap exceeded ($${(dailyStats.totalCostCents / 100).toFixed(2)} / $${(globalDailyCap / 100).toFixed(2)}). System paused.`,
      stats: dailyStats,
    };
  }

  // Check monthly global cap (100x the per-session cap by default)
  const globalMonthlyCap = caps.monthlyCapCents ? caps.monthlyCapCents * 100 : undefined;
  if (globalMonthlyCap && monthlyStats.totalCostCents > globalMonthlyCap) {
    return {
      allowed: false,
      reason: `Global monthly spend cap exceeded ($${(monthlyStats.totalCostCents / 100).toFixed(2)} / $${(globalMonthlyCap / 100).toFixed(2)}). System paused.`,
      stats: monthlyStats,
    };
  }

  return { allowed: true, stats: dailyStats };
}

/**
 * Format cost for display.
 */
export function formatCost(cents: number): string {
  if (cents < 100) {
    return `${cents}¢`;
  }
  return `$${(cents / 100).toFixed(2)}`;
}
