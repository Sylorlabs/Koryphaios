/**
 * Audit Logging Service
 */

import { db, auditLogs, auditLogArchive } from '../db';
import { serverLog } from '../logger';
import { eq, and, gte, lte, desc, count, sql } from 'drizzle-orm';

export interface AuditLogEntry {
  id?: number;
  userId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  reason?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export interface AuditLogQuery {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  startTime?: number;
  endTime?: number;
  success?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditLogQueryResult {
  entries: AuditLogEntry[];
  total: number;
  hasMore: boolean;
}

// Sensitive actions that require audit logging
export const SENSITIVE_ACTIONS = [
  'credential_access',
  'credential_store',
  'credential_delete',
  'credential_rotate',
  'login',
  'logout',
  'password_change',
  'api_key_create',
  'api_key_revoke',
  'admin_user_create',
  'admin_user_delete',
  'admin_config_change',
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export class AuditLogService {
  async log(entry: AuditLogEntry): Promise<number> {
    try {
      const [row] = await db
        .insert(auditLogs)
        .values({
          userId: entry.userId,
          action: entry.action,
          resourceType: entry.resourceType || null,
          resourceId: entry.resourceId || null,
          ipAddress: entry.ipAddress || null,
          userAgent: entry.userAgent || null,
          success: entry.success ? 1 : 0,
          reason: entry.reason || null,
          metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
          timestamp: new Date(entry.timestamp),
        })
        .returning();

      return row.id;
    } catch (error) {
      serverLog.error(
        { error, action: entry.action, userId: entry.userId },
        'Failed to create audit log entry',
      );
      throw error;
    }
  }

  async query(query: AuditLogQuery): Promise<AuditLogQueryResult> {
    const conditions = [];
    if (query.userId) conditions.push(eq(auditLogs.userId, query.userId));
    if (query.action) conditions.push(eq(auditLogs.action, query.action));
    if (query.resourceType) conditions.push(eq(auditLogs.resourceType, query.resourceType));
    if (query.resourceId) conditions.push(eq(auditLogs.resourceId, query.resourceId));
    if (query.startTime) conditions.push(gte(auditLogs.timestamp, new Date(query.startTime)));
    if (query.endTime) conditions.push(lte(auditLogs.timestamp, new Date(query.endTime)));
    if (query.success !== undefined) conditions.push(eq(auditLogs.success, query.success ? 1 : 0));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit || 100;
    const offset = query.offset || 0;

    const [countRes] = await db.select({ total: count() }).from(auditLogs).where(whereClause);
    const total = countRes.total;

    const entries = await db
      .select()
      .from(auditLogs)
      .where(whereClause)
      .orderBy(desc(auditLogs.timestamp))
      .limit(limit)
      .offset(offset);

    return {
      entries: entries.map((row) => this.rowToEntry(row)),
      total,
      hasMore: total > offset + limit,
    };
  }

  /** All recorded accesses for a specific credential (newest first). */
  async getCredentialAccessHistory(credentialId: string): Promise<AuditLogEntry[]> {
    const { entries } = await this.query({
      action: 'credential_access',
      resourceId: credentialId,
      limit: 1000,
    });
    return entries;
  }

  async detectSuspiciousActivity(
    userId: string,
  ): Promise<{ suspicious: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [failedLogins] = await db
      .select({ count: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, userId),
          eq(auditLogs.action, 'login'),
          eq(auditLogs.success, 0),
          gte(auditLogs.timestamp, oneHourAgo),
        ),
      );

    if (failedLogins.count >= 5)
      reasons.push(`Multiple failed logins (${failedLogins.count} in last hour)`);

    const [creds] = await db
      .select({ total: count() })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.userId, userId),
          eq(auditLogs.action, 'credential_access'),
          gte(auditLogs.timestamp, oneHourAgo),
        ),
      );

    if (creds.total > 50) reasons.push(`High credential access rate (${creds.total}/hour)`);

    return { suspicious: reasons.length > 0, reasons };
  }

  private rowToEntry(row: any): AuditLogEntry {
    return {
      id: row.id,
      userId: row.userId,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      success: row.success === 1,
      reason: row.reason,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      timestamp: row.timestamp.getTime(),
    };
  }
}

let instance: AuditLogService | null = null;
export function createAuditLogService(): AuditLogService {
  if (!instance) instance = new AuditLogService();
  return instance;
}
