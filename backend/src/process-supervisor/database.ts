/**
 * Process Supervisor Database Layer
 *
 * Persists process state for crash recovery and monitoring.
 */

import { db, supervisedProcesses, processEvents, processHealthChecks } from '@/db';
import { serverLog } from '../logger';
import { eq, and, inArray, desc, lte, sql } from 'drizzle-orm';
import type {
  ProcessProvenance,
  ProcessStatus,
  ProcessSupervision,
  ProcessTerminalReason,
} from '@koryphaios/shared';
import { redactSecretsInText } from '../security';

const MAX_PERSISTED_NAME_LENGTH = 500;
const MAX_PERSISTED_COMMAND_LENGTH = 4_000;
const MAX_PERSISTED_LOG_LENGTH = 16_000;
const MAX_PERSISTED_ERROR_LENGTH = 2_000;
const MAX_PERSISTED_JSON_LENGTH = 16_000;
const MAX_STRUCTURED_DEPTH = 5;
const MAX_STRUCTURED_ENTRIES = 50;
const MIN_PROCESS_RETENTION_DAYS = 0;
const MAX_PROCESS_RETENTION_DAYS = 3_650;

export interface PersistedProcess {
  id: string;
  name: string;
  command: string;
  /** False when the durable command was redacted or truncated. Such a record
   * cannot be executed again; the user must submit a fresh command. */
  commandReplayable?: boolean;
  cwd: string;
  pid: number;
  sessionId: string;
  status: ProcessStatus;
  provenance: ProcessProvenance;
  supervision: ProcessSupervision;
  isBackground: boolean;
  exitCode?: number;
  signal?: string;
  terminalReason?: ProcessTerminalReason;
  terminalError?: string;
  stdoutSnapshot?: string;
  stderrSnapshot?: string;
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

interface SqliteMigrationClient {
  exec(sql: string): unknown;
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

/** Add the lifecycle contract to a pre-contract process table without guessing ownership. */
export function migrateLegacyProcessColumns(sqlite: SqliteMigrationClient): void {
  const columns = sqlite.query('PRAGMA table_info(supervised_processes)').all() as Array<{
    name: string;
  }>;
  const addColumn = (name: string, definition: string) => {
    if (!columns.some((column) => column.name === name)) {
      sqlite.exec(`ALTER TABLE supervised_processes ADD COLUMN ${name} ${definition}`);
    }
  };
  addColumn('provenance', "TEXT NOT NULL DEFAULT 'legacy-unknown'");
  addColumn('supervision', "TEXT NOT NULL DEFAULT 'legacy-unknown'");
  addColumn('is_background', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('terminal_reason', 'TEXT');
  addColumn('terminal_error', 'TEXT');
  addColumn('stdout_snapshot', 'TEXT');
  addColumn('stderr_snapshot', 'TEXT');
  // Legacy commands predate persistence-boundary redaction and are therefore
  // fail-closed for replay until the user explicitly starts a fresh process.
  addColumn('command_replayable', 'INTEGER NOT NULL DEFAULT 0');
  sqlite.exec(`
    UPDATE supervised_processes
    SET provenance = 'legacy-unknown'
    WHERE provenance IS NULL OR provenance = '';
    UPDATE supervised_processes
    SET supervision = 'legacy-unknown'
    WHERE supervision IS NULL OR supervision = '';
  `);
}

function sanitizePrefix(value: string, maxLength: number): string {
  return redactSecretsInText(value, maxLength);
}

export function preparePersistedProcessCommand(command: string): {
  command: string;
  replayable: boolean;
} {
  const persisted = sanitizePrefix(command, MAX_PERSISTED_COMMAND_LENGTH);
  return { command: persisted, replayable: persisted === command };
}

function sanitizeTail(value: string, maxLength: number): string {
  const fullyRedacted = redactSecretsInText(value, Math.max(value.length + 1, maxLength + 1));
  return fullyRedacted.length > maxLength
    ? `…${fullyRedacted.slice(-(maxLength - 1))}`
    : fullyRedacted;
}

function sanitizeStructuredValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizePrefix(value, MAX_PERSISTED_ERROR_LENGTH);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return undefined;
  if (depth >= MAX_STRUCTURED_DEPTH) return '[TRUNCATED_DEPTH]';
  if (typeof value !== 'object') return sanitizePrefix(String(value), MAX_PERSISTED_ERROR_LENGTH);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_STRUCTURED_ENTRIES)
      .map((entry) => sanitizeStructuredValue(entry, depth + 1, seen));
    if (value.length > MAX_STRUCTURED_ENTRIES) sanitized.push('[TRUNCATED_ENTRIES]');
    return sanitized;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries.slice(0, MAX_STRUCTURED_ENTRIES)) {
    result[sanitizePrefix(key, 200)] = sanitizeStructuredValue(entry, depth + 1, seen);
  }
  if (entries.length > MAX_STRUCTURED_ENTRIES) result.__truncated = true;
  return result;
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(sanitizeStructuredValue(value));
  if (json.length <= MAX_PERSISTED_JSON_LENGTH) return json;
  return JSON.stringify({
    truncated: true,
    // Keep enough head context for diagnostics while leaving ample room for
    // JSON escaping (control characters can expand sixfold).
    preview: sanitizePrefix(json, 1_000),
  });
}

function sanitizeMetadata(metadata?: string): string | null {
  if (!metadata) return null;
  try {
    return boundedJson(JSON.parse(metadata));
  } catch {
    return boundedJson({ unparsed: metadata });
  }
}

/** One-time-at-startup cleanup for evidence written by older versions before
 * the persistence boundary existed. Legacy commands remain non-replayable. */
function sanitizeExistingProcessEvidence(sqlite: SqliteMigrationClient): void {
  const processes = sqlite
    .query(
      `SELECT id, name, command, command_replayable AS commandReplayable,
              terminal_error AS terminalError, stdout_snapshot AS stdoutSnapshot,
              stderr_snapshot AS stderrSnapshot, metadata
       FROM supervised_processes`,
    )
    .all() as Array<{
    id: string;
    name: string;
    command: string;
    commandReplayable: number;
    terminalError?: string | null;
    stdoutSnapshot?: string | null;
    stderrSnapshot?: string | null;
    metadata?: string | null;
  }>;
  const updateProcess = sqlite.query(
    `UPDATE supervised_processes
     SET name = ?, command = ?, command_replayable = ?, terminal_error = ?,
         stdout_snapshot = ?, stderr_snapshot = ?, metadata = ?
     WHERE id = ?`,
  );
  for (const process of processes) {
    const command = sanitizePrefix(process.command, MAX_PERSISTED_COMMAND_LENGTH);
    const name = sanitizePrefix(process.name, MAX_PERSISTED_NAME_LENGTH);
    const commandReplayable =
      process.commandReplayable === 1 && command === process.command ? 1 : 0;
    const terminalError = process.terminalError
      ? sanitizePrefix(process.terminalError, MAX_PERSISTED_ERROR_LENGTH)
      : null;
    const stdoutSnapshot = process.stdoutSnapshot
      ? sanitizeTail(process.stdoutSnapshot, MAX_PERSISTED_LOG_LENGTH)
      : null;
    const stderrSnapshot = process.stderrSnapshot
      ? sanitizeTail(process.stderrSnapshot, MAX_PERSISTED_LOG_LENGTH)
      : null;
    const metadata = sanitizeMetadata(process.metadata ?? undefined);

    // This is a startup maintenance pass, not a migration. Avoid taking a
    // write lock when an already-safe row needs no change: another legitimate
    // local SQLite client may be writing while Koryphaios starts.
    if (
      name === process.name &&
      command === process.command &&
      commandReplayable === process.commandReplayable &&
      terminalError === (process.terminalError ?? null) &&
      stdoutSnapshot === (process.stdoutSnapshot ?? null) &&
      stderrSnapshot === (process.stderrSnapshot ?? null) &&
      metadata === (process.metadata ?? null)
    ) {
      continue;
    }
    updateProcess.run(
      name,
      command,
      commandReplayable,
      terminalError,
      stdoutSnapshot,
      stderrSnapshot,
      metadata,
      process.id,
    );
  }

  const events = sqlite
    .query('SELECT id, event_data AS eventData FROM process_events')
    .all() as Array<{
    id: number;
    eventData?: string | null;
  }>;
  const updateEvent = sqlite.query('UPDATE process_events SET event_data = ? WHERE id = ?');
  for (const event of events) {
    if (!event.eventData) continue;
    try {
      const sanitized = boundedJson(JSON.parse(event.eventData));
      if (sanitized !== event.eventData) updateEvent.run(sanitized, event.id);
    } catch {
      const sanitized = boundedJson({ unparsed: event.eventData });
      if (sanitized !== event.eventData) updateEvent.run(sanitized, event.id);
    }
  }

  const health = sqlite
    .query('SELECT process_id AS processId, last_error AS lastError FROM process_health_checks')
    .all() as Array<{ processId: string; lastError?: string | null }>;
  const updateHealth = sqlite.query(
    'UPDATE process_health_checks SET last_error = ? WHERE process_id = ?',
  );
  for (const entry of health) {
    if (!entry.lastError) continue;
    const sanitized = sanitizePrefix(entry.lastError, MAX_PERSISTED_ERROR_LENGTH);
    if (sanitized !== entry.lastError) updateHealth.run(sanitized, entry.processId);
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_BUSY'
  );
}

function ensureSchema(): void {
  if (schemaEnsured) return;

  const sqlite = db.$client;
  if (!sqlite) {
    schemaEnsured = true;
    return;
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervised_processes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      command_replayable INTEGER NOT NULL DEFAULT 0,
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
      provenance TEXT NOT NULL DEFAULT 'legacy-unknown',
      supervision TEXT NOT NULL DEFAULT 'legacy-unknown',
      is_background INTEGER NOT NULL DEFAULT 0,
      terminal_reason TEXT,
      terminal_error TEXT,
      stdout_snapshot TEXT,
      stderr_snapshot TEXT,
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

  // Developer databases can predate the process lifecycle contract. SQLite
  // does not support `ADD COLUMN IF NOT EXISTS`, so inspect before applying
  // the additive migration. Old rows remain explicitly legacy/unknown; we do
  // not guess ownership from mutable metadata or command text.
  migrateLegacyProcessColumns(sqlite);
  try {
    sanitizeExistingProcessEvidence(sqlite);
  } catch (error) {
    // Sanitizing pre-existing diagnostic evidence is valuable, but it must
    // never make the product unavailable. A concurrent local SQLite writer
    // can hold the write lock longer than our busy timeout. Fresh writes are
    // still sanitized at their normal persistence boundary, and this pass
    // will be retried on the next startup.
    if (!isSqliteBusyError(error)) throw error;
    serverLog.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Deferred process-evidence maintenance because the database is busy',
    );
  }

  schemaEnsured = true;
}

function toTimestamp(value: unknown): number | undefined {
  if (!value) return undefined;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function normalizeProcess(row: typeof supervisedProcesses.$inferSelect): PersistedProcess {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    commandReplayable: row.commandReplayable === 1,
    cwd: row.cwd,
    pid: row.pid,
    sessionId: row.sessionId,
    status: row.status as ProcessStatus,
    provenance: (row.provenance ?? 'legacy-unknown') as ProcessProvenance,
    supervision: (row.supervision ?? 'legacy-unknown') as ProcessSupervision,
    isBackground: row.isBackground === 1,
    exitCode: row.exitCode ?? undefined,
    signal: row.signal ?? undefined,
    terminalReason: (row.terminalReason ?? undefined) as ProcessTerminalReason | undefined,
    terminalError: row.terminalError ?? undefined,
    stdoutSnapshot: row.stdoutSnapshot ?? undefined,
    stderrSnapshot: row.stderrSnapshot ?? undefined,
    restartCount: row.restartCount ?? 0,
    lastRestartAt: toTimestamp(row.lastRestartAt),
    maxRestarts: row.maxRestarts ?? 0,
    restartPolicy: (row.restartPolicy ?? 'on-failure') as 'never' | 'on-failure' | 'always',
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

/**
 * Reset the schema-ensured flag so the next `ensureSchema()` call re-creates
 * tables on a fresh database connection. Used by tests that close and reopen
 * the database singleton via `reopenDatabase()`.
 */
export function resetSchemaEnsured(): void {
  schemaEnsured = false;
}

export async function persistProcess(process: PersistedProcess): Promise<void> {
  try {
    ensureSchema();
    const persistedName = sanitizePrefix(process.name, MAX_PERSISTED_NAME_LENGTH);
    const preparedCommand = preparePersistedProcessCommand(process.command);
    const persistedCommand = preparedCommand.command;
    const commandReplayable = process.commandReplayable !== false && preparedCommand.replayable;
    const terminalError = process.terminalError
      ? sanitizePrefix(process.terminalError, MAX_PERSISTED_ERROR_LENGTH)
      : null;
    const stdoutSnapshot = process.stdoutSnapshot
      ? sanitizeTail(process.stdoutSnapshot, MAX_PERSISTED_LOG_LENGTH)
      : null;
    const stderrSnapshot = process.stderrSnapshot
      ? sanitizeTail(process.stderrSnapshot, MAX_PERSISTED_LOG_LENGTH)
      : null;
    const metadata = sanitizeMetadata(process.metadata);
    await db
      .insert(supervisedProcesses)
      .values({
        id: process.id,
        name: persistedName,
        command: persistedCommand,
        commandReplayable: commandReplayable ? 1 : 0,
        cwd: process.cwd,
        pid: process.pid,
        sessionId: process.sessionId,
        status: process.status,
        provenance: process.provenance,
        supervision: process.supervision,
        isBackground: process.isBackground ? 1 : 0,
        exitCode: process.exitCode ?? null,
        signal: process.signal ?? null,
        terminalReason: process.terminalReason ?? null,
        terminalError,
        stdoutSnapshot,
        stderrSnapshot,
        restartCount: process.restartCount,
        lastRestartAt: process.lastRestartAt ? new Date(process.lastRestartAt) : null,
        maxRestarts: process.maxRestarts,
        restartPolicy: process.restartPolicy,
        createdAt: new Date(process.createdAt),
        updatedAt: new Date(process.updatedAt),
        endedAt: process.endedAt ? new Date(process.endedAt) : null,
        metadata,
      })
      .onConflictDoUpdate({
        target: supervisedProcesses.id,
        set: {
          name: persistedName,
          command: persistedCommand,
          commandReplayable: commandReplayable ? 1 : 0,
          cwd: process.cwd,
          pid: process.pid,
          sessionId: process.sessionId,
          status: process.status,
          provenance: process.provenance,
          supervision: process.supervision,
          isBackground: process.isBackground ? 1 : 0,
          exitCode: process.exitCode ?? null,
          signal: process.signal ?? null,
          terminalReason: process.terminalReason ?? null,
          terminalError,
          stdoutSnapshot,
          stderrSnapshot,
          restartCount: process.restartCount,
          lastRestartAt: process.lastRestartAt ? new Date(process.lastRestartAt) : null,
          updatedAt: new Date(process.updatedAt),
          endedAt: process.endedAt ? new Date(process.endedAt) : null,
          metadata,
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
  updates?: Partial<
    Pick<
      PersistedProcess,
      | 'exitCode'
      | 'signal'
      | 'endedAt'
      | 'terminalReason'
      | 'terminalError'
      | 'stdoutSnapshot'
      | 'stderrSnapshot'
    >
  >,
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
        ...(updates?.terminalReason !== undefined && { terminalReason: updates.terminalReason }),
        ...(updates?.terminalError !== undefined && {
          terminalError: sanitizePrefix(updates.terminalError, MAX_PERSISTED_ERROR_LENGTH),
        }),
        ...(updates?.stdoutSnapshot !== undefined && {
          stdoutSnapshot: sanitizeTail(updates.stdoutSnapshot, MAX_PERSISTED_LOG_LENGTH),
        }),
        ...(updates?.stderrSnapshot !== undefined && {
          stderrSnapshot: sanitizeTail(updates.stderrSnapshot, MAX_PERSISTED_LOG_LENGTH),
        }),
      })
      .where(eq(supervisedProcesses.id, id));
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to update process status');
    throw err;
  }
}

/**
 * Persist a bounded, redacted live-output checkpoint without touching lifecycle
 * fields. A late stream flush must never turn a terminal process back into
 * `running` after a backend restart race.
 */
export async function updateLiveProcessLogSnapshot(
  id: string,
  stdoutSnapshot: string,
  stderrSnapshot: string,
): Promise<void> {
  try {
    ensureSchema();
    await db
      .update(supervisedProcesses)
      .set({
        updatedAt: new Date(),
        stdoutSnapshot: sanitizeTail(stdoutSnapshot, MAX_PERSISTED_LOG_LENGTH),
        stderrSnapshot: sanitizeTail(stderrSnapshot, MAX_PERSISTED_LOG_LENGTH),
      })
      .where(
        and(
          eq(supervisedProcesses.id, id),
          inArray(supervisedProcesses.status, ['starting', 'running', 'detached']),
        ),
      );
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to persist live process log snapshot');
    throw err;
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
    if (!row) throw new Error(`Process ${id} disappeared while recording its restart`);
    return row.restartCount;
  } catch (err) {
    serverLog.error({ err, processId: id }, 'Failed to increment restart count');
    throw err;
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

/** Startup recovery must distinguish an empty active set from a failed read.
 * A failed read cannot safely authorize new writers or Time Travel. */
export async function getActiveProcessesStrict(): Promise<PersistedProcess[]> {
  ensureSchema();
  const rows = await db
    .select()
    .from(supervisedProcesses)
    .where(inArray(supervisedProcesses.status, ['starting', 'running']))
    .orderBy(desc(supervisedProcesses.createdAt));

  return rows.map(normalizeProcess);
}

/** Tolerant read for monitoring/list surfaces where an empty degraded result
 * is preferable to crashing the request. Never use this for recovery gates. */
export async function getActiveProcesses(): Promise<PersistedProcess[]> {
  try {
    return await getActiveProcessesStrict();
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
    const rows = await db
      .select()
      .from(supervisedProcesses)
      .where(
        includeInactive ? undefined : inArray(supervisedProcesses.status, ['starting', 'running']),
      )
      .orderBy(desc(supervisedProcesses.createdAt))
      .limit(limit);
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
  if (
    !Number.isSafeInteger(daysToKeep) ||
    daysToKeep < MIN_PROCESS_RETENTION_DAYS ||
    daysToKeep > MAX_PROCESS_RETENTION_DAYS
  ) {
    throw new RangeError(
      `daysToKeep must be an integer between ${MIN_PROCESS_RETENTION_DAYS} and ${MAX_PROCESS_RETENTION_DAYS}`,
    );
  }
  try {
    ensureSchema();
    const sqlite = db.$client ?? null;
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const result = await db
      .delete(supervisedProcesses)
      .where(
        and(
          inArray(supervisedProcesses.status, [
            'exited',
            'killed',
            'crashed',
            'spawn_failed',
            'orphaned',
            'detached',
          ]),
          lte(supervisedProcesses.endedAt, cutoff),
          sql`NOT EXISTS (
            SELECT 1
            FROM session_run_continuation_processes AS continuation_process
            INNER JOIN session_run_continuations AS continuation
              ON continuation.id = continuation_process.continuation_id
            WHERE continuation_process.process_id = ${supervisedProcesses.id}
              AND continuation.state IN ('pending', 'ready', 'claimed')
          )`,
        ),
      );

    const deleted =
      (result as unknown as { changes?: number }).changes ??
      (sqlite as { changes?: number } | null)?.changes ??
      0;
    serverLog.info({ daysToKeep, deleted }, 'Cleaned up old processes');
    return deleted;
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

    return rows.map((row: typeof processEvents.$inferSelect) => ({
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
      eventType: sanitizePrefix(eventType, 200),
      eventData: eventData ? boundedJson(eventData) : null,
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
          lastError: sanitizePrefix(error ?? 'Health check failed', MAX_PERSISTED_ERROR_LENGTH),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: processHealthChecks.processId,
          set: {
            checkCount: sql`${processHealthChecks.checkCount} + 1`,
            failureCount: sql`${processHealthChecks.failureCount} + 1`,
            consecutiveFailures: sql`${processHealthChecks.consecutiveFailures} + 1`,
            isHealthy: 0,
            lastError: sanitizePrefix(error ?? 'Health check failed', MAX_PERSISTED_ERROR_LENGTH),
            updatedAt: now,
          },
        });
    }
  } catch (err) {
    serverLog.error({ err, processId }, 'Failed to update health check');
  }
}
