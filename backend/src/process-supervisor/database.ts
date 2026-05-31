/**
 * Process Supervisor Database Layer
 *
 * Persists process state for crash recovery and monitoring.
 */

import { db, supervisedProcesses, processEvents, processHealthChecks } from '@/db';
import { serverLog } from '../logger';
import { eq, and, inArray, desc, lte, sql } from 'drizzle-orm';

export interface PersistedProcess {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  sessionId: string;
  status: 'starting' | 'running' | 'exited' | 'killed' | 'crashed' | 'orphaned';
  exitCode?: number;
  signal?: string;
  restartCount: number;
  lastRestartAt?: number;
  maxRestarts: number;
  restartPolicy: 'never' | 'on-failure' | 'always';
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  metadata?: string; // JSON string for extensibility
}

export interface PersistedProcessEvent {
  id: number;
  processId: string;
  eventType: string;
  eventData?: string | null;
  timestamp: number;
}

export interface PersistedProcessHealth {
  processId: string;
  lastHeartbeat?: number;
  checkCount: number;
  failureCount: number;
  consecutiveFailures: number;
  isHealthy: boolean;
  lastError?: string | null;
  updatedAt: number;
}

let schemaEnsured = false;

function ensureSchema(): void {
  if (schemaEnsured) return;

  const sqlite = (db as any).$client;
  if (!sqlite) {
    schemaEnsured = true;
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervised_processes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pid INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'starting',
      exit_code INTEGER,
      signal TEXT,
      restart_count INTEGER DEFAULT 0,
      last_restart_at INTEGER,
      max_restarts INTEGER DEFAULT 3,
      restart_policy TEXT DEFAULT 'on-failure',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS process_health_checks (
      process_id TEXT PRIMARY KEY,
      last_heartbeat INTEGER,
      check_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      consecutive_failures INTEGER DEFAULT 0,
      is_healthy INTEGER DEFAULT 1,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_supervised_processes_session
      ON supervised_processes(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervised_processes_status
      ON supervised_processes(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_process_events_process
      ON process_events(process_id, timestamp DESC);
  `);

  schemaEnsured = true;
}

function toTimestamp(value: unknown): number | undefined {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function normalizeProcess(row: any): PersistedProcess {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    cwd: row.cwd,
    pid: row.pid,
    sessionId: row.sessionId,
    status: row.status,
    exitCode: row.exitCode ?? undefined,
    signal: row.signal ?? undefined,
    restartCount: row.restartCount ?? 0,
    lastRestartAt: toTimestamp(row.lastRestartAt),
    maxRestarts: row.maxRestarts ?? 0,
    restartPolicy: row.restartPolicy,
    createdAt: toTimestamp(row.createdAt) ?? 0,
    updatedAt: toTimestamp(row.updatedAt) ?? 0,
    endedAt: toTimestamp(row.endedAt),
    metadata: row.metadata ?? undefined,
  };
}

export function initProcessSupervisorTables(): void {
  ensureSchema();
  serverLog.info('Process supervisor tables initialized');
}

export async function persistProcess(process: PersistedProcess): Promise<void> {
  try {
    ensureSchema();
    await db
      .insert(supervisedProcesses)
      .values({
        id: process.id,
        name: process.name,
        command: process.command,
        cwd: process.cwd,
        pid: process.pid,
        sessionId: process.sessionId,
        status: process.status,
        exitCode: process.exitCode ?? null,
        signal: process.signal ?? null,
        restartCount: process.restartCount,
        lastRestartAt: process.lastRestartAt ? new Date(process.lastRestartAt) : null,
        maxRestarts: process.maxRestarts,
        restartPolicy: process.restartPolicy,
        createdAt: new Date(process.createdAt),
        updatedAt: new Date(process.updatedAt),
        endedAt: process.endedAt ? new Date(process.endedAt) : null,
        metadata: process.metadata ?? null,
      })
      .onConflictDoUpdate({
        target: supervisedProcesses.id,
        set: {
          status: process.status,
          exitCode: process.exitCode ?? null,
          signal: process.signal ?? null,
          restartCount: process.restartCount,
          lastRestartAt: process.lastRestartAt ? new Date(process.lastRestartAt) : null,
          updatedAt: new Date(process.updatedAt),
          endedAt: process.endedAt ? new Date(process.endedAt) : null,
          metadata: process.metadata ?? null,
        },
      });
  } catch (err) {
    serverLog.error({ err, processId: process.id }, 'Failed to persist process');
    throw err;
  }
}

export async function updateProcessStatus(
  id: string,
  status: PersistedProcess['status'],
  updates?: Partial<Pick<PersistedProcess, 'exitCode' | 'signal' | 'endedAt'>>,
): Promise<void> {
  try {
    ensureSchema();
    await db
      .update(supervisedProcesses)
      .set({
        status,
        updatedAt: new Date(),
        ...(updates?.exitCode !== undefined && { exitCode: updates.exitCode }),
        ...(updates?.signal !== undefined && { signal: updates.signal }),
        ...(updates?.endedAt !== undefined && { endedAt: new Date(updates.endedAt) }),
      })
      .where(eq(supervisedProcesses.id, id));
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to update process status');
  }
}

export async function incrementRestartCount(id: string): Promise<number> {
  try {
    ensureSchema();
    await db
      .update(supervisedProcesses)
      .set({
        restartCount: sql`${supervisedProcesses.restartCount} + 1`,
        lastRestartAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(supervisedProcesses.id, id));

    const row = await getProcessById(id);
    return row?.restartCount ?? 0;
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to increment restart count');
    return 0;
  }
}

export async function getProcessById(id: string): Promise<PersistedProcess | undefined> {
  try {
    ensureSchema();
    const [row] = await db
      .select()
      .from(supervisedProcesses)
      .where(eq(supervisedProcesses.id, id))
      .limit(1);

    if (!row) return undefined;

    return normalizeProcess(row);
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to get process');
    return undefined;
  }
}

export async function getActiveProcesses(): Promise<PersistedProcess[]> {
  try {
    ensureSchema();
    const rows = await db
      .select()
      .from(supervisedProcesses)
      .where(inArray(supervisedProcesses.status, ['starting', 'running']))
      .orderBy(desc(supervisedProcesses.createdAt));

    return rows.map(normalizeProcess);
  } catch (err) {
    serverLog.error({ err }, 'Failed to get active processes');
    return [];
  }
}

export async function getProcessesBySession(sessionId: string): Promise<PersistedProcess[]> {
  try {
    ensureSchema();
    const rows = await db
      .select()
      .from(supervisedProcesses)
      .where(eq(supervisedProcesses.sessionId, sessionId))
      .orderBy(desc(supervisedProcesses.createdAt));

    return rows.map(normalizeProcess);
  } catch (err) {
    serverLog.error({ err, sessionId }, 'Failed to get processes by session');
    return [];
  }
}

export async function listProcesses(
  includeInactive: boolean = true,
  limit: number = 100,
): Promise<PersistedProcess[]> {
  try {
    ensureSchema();
    let query = db.select().from(supervisedProcesses).orderBy(desc(supervisedProcesses.createdAt));
    if (!includeInactive) {
      query = query.where(inArray(supervisedProcesses.status, ['starting', 'running'])) as any;
    }
    const rows = await query.limit(limit);
    return rows.map(normalizeProcess);
  } catch (err) {
    serverLog.error({ err, includeInactive, limit }, 'Failed to list processes');
    return [];
  }
}

export async function deleteProcess(id: string): Promise<void> {
  try {
    ensureSchema();
    await db.delete(supervisedProcesses).where(eq(supervisedProcesses.id, id));
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to delete process');
  }
}

export async function cleanupOldProcesses(daysToKeep: number = 7): Promise<number> {
  try {
    ensureSchema();
    const sqlite = (db as any).$client ?? null;
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    await db
      .delete(supervisedProcesses)
      .where(
        and(
          inArray(supervisedProcesses.status, ['exited', 'killed', 'crashed', 'orphaned']),
          lte(supervisedProcesses.endedAt, cutoff),
        ),
      );

    serverLog.info({ daysToKeep }, 'Cleaned up old processes');
    return sqlite?.changes ?? 0;
  } catch (err) {
    serverLog.error({ err }, 'Failed to cleanup old processes');
    return 0;
  }
}

export async function getProcessEventsById(
  processId: string,
  limit: number = 50,
): Promise<PersistedProcessEvent[]> {
  try {
    ensureSchema();
    const rows = await db
      .select()
      .from(processEvents)
      .where(eq(processEvents.processId, processId))
      .orderBy(desc(processEvents.timestamp))
      .limit(limit);

    return rows.map((row: any) => ({
      id: row.id,
      processId: row.processId,
      eventType: row.eventType,
      eventData: row.eventData ?? null,
      timestamp: toTimestamp(row.timestamp) ?? 0,
    }));
  } catch (err) {
    serverLog.error({ err, processId }, 'Failed to get process events');
    return [];
  }
}

export async function getProcessHealthById(
  processId: string,
): Promise<PersistedProcessHealth | undefined> {
  try {
    ensureSchema();
    const [row] = await db
      .select()
      .from(processHealthChecks)
      .where(eq(processHealthChecks.processId, processId))
      .limit(1);

    if (!row) return undefined;

    return {
      processId: row.processId,
      lastHeartbeat: toTimestamp(row.lastHeartbeat),
      checkCount: row.checkCount ?? 0,
      failureCount: row.failureCount ?? 0,
      consecutiveFailures: row.consecutiveFailures ?? 0,
      isHealthy: row.isHealthy === 1,
      lastError: row.lastError ?? null,
      updatedAt: toTimestamp(row.updatedAt) ?? 0,
    };
  } catch (err) {
    serverLog.error({ err, processId }, 'Failed to get process health');
    return undefined;
  }
}

export async function logProcessEvent(
  processId: string,
  eventType: string,
  eventData?: Record<string, unknown>,
): Promise<void> {
  try {
    ensureSchema();
    await db.insert(processEvents).values({
      processId,
      eventType,
      eventData: eventData ? JSON.stringify(eventData) : null,
      timestamp: new Date(),
    });
  } catch (err) {
    serverLog.error({ err, processId }, 'Failed to log process event');
  }
}

export async function updateHealthCheck(
  processId: string,
  isHealthy: boolean,
  error?: string,
): Promise<void> {
  try {
    ensureSchema();
    const now = new Date();
    if (isHealthy) {
      await db
        .insert(processHealthChecks)
        .values({
          processId,
          lastHeartbeat: now,
          checkCount: 1,
          isHealthy: 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: processHealthChecks.processId,
          set: {
            lastHeartbeat: now,
            checkCount: sql`${processHealthChecks.checkCount} + 1`,
            consecutiveFailures: 0,
            isHealthy: 1,
            lastError: null,
            updatedAt: now,
          },
        });
    } else {
      await db
        .insert(processHealthChecks)
        .values({
          processId,
          checkCount: 1,
          failureCount: 1,
          consecutiveFailures: 1,
          isHealthy: 0,
          lastError: error ?? 'Health check failed',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: processHealthChecks.processId,
          set: {
            checkCount: sql`${processHealthChecks.checkCount} + 1`,
            failureCount: sql`${processHealthChecks.failureCount} + 1`,
            consecutiveFailures: sql`${processHealthChecks.consecutiveFailures} + 1`,
            isHealthy: 0,
            lastError: error ?? 'Health check failed',
            updatedAt: now,
          },
        });
    }
  } catch (err) {
    serverLog.error({ err, processId }, 'Failed to update health check');
  }
}
