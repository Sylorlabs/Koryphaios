import type { Database } from 'bun:sqlite';

const DIRECT_SESSION_TABLES = [
  'abort_controllers',
  'active_workers',
  'messages',
  'ordered_session_events',
  'replay_events',
  'routing_audit_log',
  'session_feed_entries',
  'session_feed_tombstones',
  'session_changes',
  'session_compactions',
  'session_run_events',
  'session_run_continuations',
  'session_run_handoffs',
  'session_runs',
  'session_event_causes',
  'session_event_cursors',
  'session_tags',
  'session_usage',
  'spend_cap_pauses',
  'tasks',
  'user_inputs',
  'session_turn_commands',
] as const;

const SPECIAL_SESSION_TABLES = new Set([
  ...DIRECT_SESSION_TABLES,
  'goals',
  'session_participants',
  'supervised_processes',
  'session_run_continuation_processes',
]);

export type SessionErasureScope =
  | { kind: 'selected'; sessionIds: readonly string[] }
  | { kind: 'all' };

export interface SessionErasureReport {
  deletedSessions: number;
  deletedRows: Record<string, number>;
  updatedGoals: number;
}

interface SqliteRunResult {
  changes?: number;
}

type SqlValue = string | number | bigint | boolean | null | Uint8Array;

function tableExists(sqlite: Database, table: string, database = 'main'): boolean {
  const row = sqlite
    .query(`SELECT 1 AS present FROM ${database}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { present: number } | null;
  return row?.present === 1;
}

function tableColumns(sqlite: Database, table: string, database = 'main'): string[] {
  return (
    sqlite.query(`PRAGMA ${database}.table_info(${JSON.stringify(table)})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

const LINK_COLUMN_POLICIES = new Map<string, ReadonlySet<string>>([
  ['base_session_id', new Set(['collaboration_sessions'])],
  ['linked_session_ids', new Set(['goals'])],
  [
    'process_id',
    new Set([
      'process_events',
      'process_health_checks',
      'session_run_continuation_processes',
    ]),
  ],
]);

function assertTableColumns(
  sqlite: Database,
  table: string,
  columns: readonly string[],
  database = 'main',
): void {
  if (!tableExists(sqlite, table, database)) return;
  const actual = new Set(tableColumns(sqlite, table, database));
  const missing = columns.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Session erasure refused incompatible ${table} schema; missing: ${missing.join(', ')}`,
    );
  }
}

function assertKnownSessionSchema(sqlite: Database): void {
  const tables = sqlite
    .query(
      `SELECT name FROM main.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const unknown: string[] = [];
  for (const { name } of tables) {
    const columns = tableColumns(sqlite, name);
    if (columns.includes('session_id') && !SPECIAL_SESSION_TABLES.has(name)) unknown.push(name);
    for (const [column, allowedTables] of LINK_COLUMN_POLICIES) {
      if (columns.includes(column) && !allowedTables.has(name)) unknown.push(`${name}.${column}`);
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Session erasure refused: unrecognized session-keyed tables: ${unknown.join(', ')}`,
    );
  }
  assertTableColumns(sqlite, 'sessions', ['id', 'parent_id']);
  assertTableColumns(sqlite, 'persistent_sessions', ['id']);
  assertTableColumns(sqlite, 'goals', [
    'id',
    'scope',
    'session_id',
    'linked_session_ids',
    'activity',
    'execution',
  ]);
  assertTableColumns(sqlite, 'collaboration_sessions', ['id', 'base_session_id']);
  assertTableColumns(sqlite, 'session_participants', ['session_id']);
  assertTableColumns(sqlite, 'supervised_processes', ['id', 'session_id']);
  assertTableColumns(sqlite, 'process_events', ['process_id']);
  assertTableColumns(sqlite, 'process_health_checks', ['process_id']);
  assertTableColumns(sqlite, 'session_run_continuation_processes', [
    'continuation_id',
    'process_id',
  ]);
  assertTableColumns(sqlite, 'session_turn_commands', [
    'command_key',
    'session_id',
    'source',
    'source_command_id',
    'input_hash',
    'user_message_id',
    'response_message_id',
    'run_id',
    'status',
    'created_at',
    'updated_at',
  ]);
  assertTableColumns(sqlite, 'audit_logs', ['resource_type', 'resource_id']);
  assertTableColumns(sqlite, 'audit_log_archive', ['resource_type', 'resource_id']);
}

function normalizeSessionIds(sessionIds: readonly string[]): string[] {
  const normalized = [
    ...new Set(
      sessionIds.map((sessionId) => {
        if (
          typeof sessionId !== 'string' ||
          !sessionId ||
          sessionId.length > 512 ||
          /[\0-\x1f\x7f]/.test(sessionId)
        ) {
          throw new Error('Session erasure refused an invalid session ID');
        }
        return sessionId;
      }),
    ),
  ];
  if (normalized.length === 0) throw new Error('Session erasure requires at least one session');
  return normalized;
}

function changes(result: unknown): number {
  return Number((result as SqliteRunResult | undefined)?.changes ?? 0);
}

function recordDelete(
  report: SessionErasureReport,
  sqlite: Database,
  table: string,
  sql: string,
  params: readonly SqlValue[] = [],
): void {
  if (!tableExists(sqlite, table)) return;
  const result = sqlite.query(sql).run(...params);
  report.deletedRows[table] = (report.deletedRows[table] ?? 0) + changes(result);
}

function deleteDirectRows(
  sqlite: Database,
  report: SessionErasureReport,
  table: (typeof DIRECT_SESSION_TABLES)[number],
  sessionIds: readonly string[] | null,
): void {
  if (!tableExists(sqlite, table)) return;
  if (sessionIds === null) {
    recordDelete(report, sqlite, table, `DELETE FROM ${table}`);
    return;
  }
  for (const sessionId of sessionIds) {
    recordDelete(report, sqlite, table, `DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
  }
}

function readIds(
  sqlite: Database,
  table: string,
  idColumn: string,
  where: string,
  params: readonly SqlValue[] = [],
): string[] {
  if (!tableExists(sqlite, table)) return [];
  return (
    sqlite.query(`SELECT ${idColumn} AS id FROM ${table} WHERE ${where}`).all(...params) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

function eraseProcesses(
  sqlite: Database,
  report: SessionErasureReport,
  sessionIds: readonly string[] | null,
): void {
  if (!tableExists(sqlite, 'supervised_processes')) return;
  const processIds =
    sessionIds === null
      ? readIds(sqlite, 'supervised_processes', 'id', '1 = 1')
      : sessionIds.flatMap((sessionId) =>
          readIds(sqlite, 'supervised_processes', 'id', 'session_id = ?', [sessionId]),
        );
  for (const processId of processIds) {
    recordDelete(
      report,
      sqlite,
      'session_run_continuation_processes',
      'DELETE FROM session_run_continuation_processes WHERE process_id = ?',
      [processId],
    );
    recordDelete(report, sqlite, 'process_events', 'DELETE FROM process_events WHERE process_id = ?', [
      processId,
    ]);
    recordDelete(
      report,
      sqlite,
      'process_health_checks',
      'DELETE FROM process_health_checks WHERE process_id = ?',
      [processId],
    );
  }
  if (sessionIds === null) {
    recordDelete(report, sqlite, 'supervised_processes', 'DELETE FROM supervised_processes');
  } else {
    for (const sessionId of sessionIds) {
      recordDelete(
        report,
        sqlite,
        'supervised_processes',
        'DELETE FROM supervised_processes WHERE session_id = ?',
        [sessionId],
      );
    }
  }
}

function eraseCollaborations(
  sqlite: Database,
  report: SessionErasureReport,
  sessionIds: readonly string[] | null,
): void {
  if (!tableExists(sqlite, 'collaboration_sessions')) return;
  const collaborationIds =
    sessionIds === null
      ? readIds(sqlite, 'collaboration_sessions', 'id', '1 = 1')
      : sessionIds.flatMap((sessionId) =>
          readIds(sqlite, 'collaboration_sessions', 'id', 'base_session_id = ?', [sessionId]),
        );
  for (const collaborationId of collaborationIds) {
    recordDelete(
      report,
      sqlite,
      'session_participants',
      'DELETE FROM session_participants WHERE session_id = ?',
      [collaborationId],
    );
  }
  if (sessionIds === null) {
    recordDelete(report, sqlite, 'collaboration_sessions', 'DELETE FROM collaboration_sessions');
  } else {
    for (const sessionId of sessionIds) {
      recordDelete(
        report,
        sqlite,
        'collaboration_sessions',
        'DELETE FROM collaboration_sessions WHERE base_session_id = ?',
        [sessionId],
      );
    }
  }
}

function parseGoalJson<T>(value: string, label: string, goalId: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Session erasure refused damaged ${label} JSON for goal ${goalId}`);
  }
}

/** Enumerate every session identifier referenced by the main database. Used by
 * delete-all to install live tombstones even for orphan rows with no session. */
export function inventorySessionIdsForErasure(sqlite: Database): string[] {
  assertKnownSessionSchema(sqlite);
  const ids = new Set<string>();
  const collect = (table: string, column: string, where = `${column} IS NOT NULL`) => {
    if (!tableExists(sqlite, table)) return;
    const rows = sqlite
      .query(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${where}`)
      .all() as Array<{ id: unknown }>;
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id.length > 0) ids.add(row.id);
    }
  };
  collect('sessions', 'id');
  collect('persistent_sessions', 'id');
  for (const table of DIRECT_SESSION_TABLES) collect(table, 'session_id');
  collect('supervised_processes', 'session_id');
  collect('collaboration_sessions', 'base_session_id');
  for (const table of ['audit_logs', 'audit_log_archive']) {
    collect(table, 'resource_id', `lower(COALESCE(resource_type, '')) IN ('session', 'chat')`);
  }
  if (tableExists(sqlite, 'goals')) {
    const goals = sqlite
      .query('SELECT id, session_id, linked_session_ids, activity, execution FROM goals')
      .all() as Array<{
      id: string;
      session_id: string | null;
      linked_session_ids: string;
      activity: string;
      execution: string | null;
    }>;
    for (const goal of goals) {
      if (goal.session_id) ids.add(goal.session_id);
      const linked = parseGoalJson<unknown[]>(goal.linked_session_ids, 'linked_session_ids', goal.id);
      const activity = parseGoalJson<Array<Record<string, unknown>>>(
        goal.activity,
        'activity',
        goal.id,
      );
      const execution = goal.execution
        ? parseGoalJson<Record<string, unknown>>(goal.execution, 'execution', goal.id)
        : null;
      if (!Array.isArray(linked) || !Array.isArray(activity)) {
        throw new Error(`Session erasure refused structurally damaged session links for goal ${goal.id}`);
      }
      for (const value of linked) if (typeof value === 'string' && value) ids.add(value);
      for (const value of activity) {
        if (typeof value?.sessionId === 'string' && value.sessionId) ids.add(value.sessionId);
      }
      if (typeof execution?.sessionId === 'string' && execution.sessionId) {
        ids.add(execution.sessionId);
      }
    }
  }
  return [...ids];
}

function eraseGoalLinks(
  sqlite: Database,
  report: SessionErasureReport,
  sessionIds: readonly string[] | null,
): void {
  if (!tableExists(sqlite, 'goals')) return;
  const rows = sqlite
    .query(
      `SELECT id, scope, session_id, status, linked_session_ids, activity, execution,
              active_duration_ms, active_started_at
       FROM goals`,
    )
    .all() as Array<{
    id: string;
    scope: string;
    session_id: string | null;
    status: string;
    linked_session_ids: string;
    activity: string;
    execution: string | null;
    active_duration_ms: number;
    active_started_at: number | null;
  }>;
  const selected = sessionIds === null ? null : new Set(sessionIds);
  const now = Date.now();

  for (const row of rows) {
    const ownsSelectedSession =
      row.scope === 'session' && (selected === null || selected.has(row.session_id ?? ''));
    if (ownsSelectedSession) {
      recordDelete(report, sqlite, 'goals', 'DELETE FROM goals WHERE id = ?', [row.id]);
      continue;
    }

    if (sessionIds === null) {
      const nextStatus = ['queued', 'planning', 'running'].includes(row.status)
        ? 'paused'
        : row.status;
      const activeDuration =
        row.status === 'running' && row.active_started_at
          ? row.active_duration_ms + Math.max(0, now - row.active_started_at)
          : row.active_duration_ms;
      sqlite
        .query(
          `UPDATE goals
           SET session_id = NULL, linked_session_ids = '[]', activity = '[]', execution = NULL,
               status = ?, blocker = CASE WHEN ? = 'paused'
                 THEN 'Paused because its execution chat was deleted' ELSE blocker END,
               active_duration_ms = ?, active_started_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextStatus, nextStatus, activeDuration, now, row.id);
      report.updatedGoals++;
      continue;
    }

    const linked = parseGoalJson<unknown[]>(row.linked_session_ids, 'linked_session_ids', row.id);
    const activity = parseGoalJson<Array<Record<string, unknown>>>(row.activity, 'activity', row.id);
    const execution = row.execution
      ? parseGoalJson<Record<string, unknown>>(row.execution, 'execution', row.id)
      : null;
    if (!Array.isArray(linked) || !Array.isArray(activity) || (execution && typeof execution !== 'object')) {
      throw new Error(`Session erasure refused structurally damaged session links for goal ${row.id}`);
    }
    if (!selected) throw new Error('Session erasure lost its selected-session scope');
    const nextLinked = linked.filter((value) => typeof value !== 'string' || !selected.has(value));
    const nextActivity = activity.filter(
      (value) => typeof value?.sessionId !== 'string' || !selected.has(value.sessionId),
    );
    const executionMatches =
      typeof execution?.sessionId === 'string' && selected.has(execution.sessionId);
    const scalarMatches = row.session_id !== null && selected.has(row.session_id);
    if (
      nextLinked.length === linked.length &&
      nextActivity.length === activity.length &&
      !executionMatches &&
      !scalarMatches
    ) {
      continue;
    }
    const nextStatus =
      executionMatches && ['queued', 'planning', 'running'].includes(row.status)
        ? 'paused'
        : row.status;
    const activeDuration =
      row.status === 'running' && executionMatches && row.active_started_at
        ? row.active_duration_ms + Math.max(0, now - row.active_started_at)
        : row.active_duration_ms;
    sqlite
      .query(
        `UPDATE goals
         SET session_id = ?, linked_session_ids = ?, activity = ?, execution = ?, status = ?,
             blocker = CASE WHEN ? = 1 THEN 'Paused because its execution chat was deleted'
               ELSE blocker END,
             active_duration_ms = ?, active_started_at = CASE WHEN ? = 1 THEN NULL
               ELSE active_started_at END, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        scalarMatches ? null : row.session_id,
        JSON.stringify(nextLinked),
        JSON.stringify(nextActivity),
        executionMatches ? null : row.execution,
        nextStatus,
        executionMatches ? 1 : 0,
        activeDuration,
        executionMatches ? 1 : 0,
        now,
        row.id,
      );
    report.updatedGoals++;
  }
}

function eraseAuditRows(
  sqlite: Database,
  report: SessionErasureReport,
  sessionIds: readonly string[] | null,
): void {
  for (const table of ['audit_logs', 'audit_log_archive']) {
    if (!tableExists(sqlite, table)) continue;
    if (sessionIds === null) {
      recordDelete(
        report,
        sqlite,
        table,
        `DELETE FROM ${table} WHERE lower(COALESCE(resource_type, '')) IN ('session', 'chat')`,
      );
    } else {
      for (const sessionId of sessionIds) {
        recordDelete(
          report,
          sqlite,
          table,
          `DELETE FROM ${table}
           WHERE lower(COALESCE(resource_type, '')) IN ('session', 'chat') AND resource_id = ?`,
          [sessionId],
        );
      }
    }
  }
}

/** Credit usage lives in a separate WAL database, so it cannot truthfully be
 * described as crash-atomic with the main database. Erase it in its own
 * transaction after the main commit and track it in the durable file receipt. */
export function eraseCreditUsageTransaction(
  sqlite: Database,
  scope: SessionErasureScope,
): number {
  assertTableColumns(sqlite, 'credit_usage', ['session_id']);
  if (!tableExists(sqlite, 'credit_usage')) {
    throw new Error('Session credit erasure refused because credit_usage is unavailable');
  }
  const sessionIds = scope.kind === 'selected' ? normalizeSessionIds(scope.sessionIds) : null;
  const transaction = sqlite.transaction(() => {
    let deleted = 0;
    if (sessionIds === null) {
      deleted += changes(sqlite.query('DELETE FROM credit_usage WHERE session_id IS NOT NULL').run());
    } else {
      for (const sessionId of sessionIds) {
        deleted += changes(
          sqlite.query('DELETE FROM credit_usage WHERE session_id = ?').run(sessionId),
        );
      }
    }
    const remaining =
      sessionIds === null
        ? Number(
            (
              sqlite
                .query('SELECT COUNT(*) AS count FROM credit_usage WHERE session_id IS NOT NULL')
                .get() as { count: number }
            ).count,
          )
        : sessionIds.reduce(
            (total, sessionId) =>
              total +
              Number(
                (
                  sqlite
                    .query('SELECT COUNT(*) AS count FROM credit_usage WHERE session_id = ?')
                    .get(sessionId) as { count: number }
                ).count,
              ),
            0,
          );
    if (remaining > 0) throw new Error('Session credit erasure verification failed');
    return deleted;
  });
  return transaction();
}

function assertNoRemnants(
  sqlite: Database,
  sessionIds: readonly string[] | null,
  processIds: readonly string[],
  collaborationIds: readonly string[],
): void {
  const remaining = (sql: string, params: readonly SqlValue[] = []): number =>
    Number((sqlite.query(sql).get(...params) as { count: number }).count);
  for (const table of DIRECT_SESSION_TABLES) {
    if (!tableExists(sqlite, table)) continue;
    if (sessionIds === null) {
      if (remaining(`SELECT COUNT(*) AS count FROM ${table}`) > 0) {
        throw new Error(`Session erasure verification failed for ${table}`);
      }
    } else {
      for (const sessionId of sessionIds) {
        if (
          remaining(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`, [sessionId]) > 0
        ) {
          throw new Error(`Session erasure verification failed for ${table}`);
        }
      }
    }
  }
  for (const processId of processIds) {
    for (const table of [
      'process_events',
      'process_health_checks',
      'session_run_continuation_processes',
    ]) {
      if (
        tableExists(sqlite, table) &&
        remaining(`SELECT COUNT(*) AS count FROM ${table} WHERE process_id = ?`, [processId]) > 0
      ) {
        throw new Error(`Session erasure verification failed for ${table}`);
      }
    }
  }
  for (const collaborationId of collaborationIds) {
    if (
      tableExists(sqlite, 'session_participants') &&
      remaining('SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ?', [
        collaborationId,
      ]) > 0
    ) {
      throw new Error('Session erasure verification failed for session_participants');
    }
  }
}

/**
 * Delete every known SQLite record owned by one or all chat sessions in a
 * single synchronous transaction. The schema inventory is fail-closed: adding
 * a new table with a `session_id` column requires an explicit erasure policy
 * before deletion can succeed.
 */
export function eraseSessionDataTransaction(
  sqlite: Database,
  scope: SessionErasureScope,
): SessionErasureReport {
  const sessionIds = scope.kind === 'selected' ? normalizeSessionIds(scope.sessionIds) : null;
  assertKnownSessionSchema(sqlite);

  const transaction = sqlite.transaction((): SessionErasureReport => {
      const report: SessionErasureReport = {
        deletedSessions: 0,
        deletedRows: {},
        updatedGoals: 0,
      };
      const processIds =
        sessionIds === null
          ? readIds(sqlite, 'supervised_processes', 'id', '1 = 1')
          : sessionIds.flatMap((sessionId) =>
              readIds(sqlite, 'supervised_processes', 'id', 'session_id = ?', [sessionId]),
            );
      const collaborationIds =
        sessionIds === null
          ? readIds(sqlite, 'collaboration_sessions', 'id', '1 = 1')
          : sessionIds.flatMap((sessionId) =>
              readIds(sqlite, 'collaboration_sessions', 'id', 'base_session_id = ?', [sessionId]),
            );

      // Continuations own normalized process references with a RESTRICT edge
      // to supervised_processes. Remove the session-owned continuation graph
      // before deleting process rows; bridge rows cascade with it. Corrupt
      // cross-session process references are removed explicitly by
      // eraseProcesses so privacy erasure cannot be blocked by stale metadata.
      deleteDirectRows(sqlite, report, 'session_run_continuations', sessionIds);
      eraseProcesses(sqlite, report, sessionIds);
      eraseCollaborations(sqlite, report, sessionIds);
      eraseGoalLinks(sqlite, report, sessionIds);
      eraseAuditRows(sqlite, report, sessionIds);
      for (const table of DIRECT_SESSION_TABLES) {
        if (table === 'session_run_continuations') continue;
        deleteDirectRows(sqlite, report, table, sessionIds);
      }

      if (tableExists(sqlite, 'persistent_sessions')) {
        if (sessionIds === null) {
          recordDelete(report, sqlite, 'persistent_sessions', 'DELETE FROM persistent_sessions');
        } else {
          for (const sessionId of sessionIds) {
            recordDelete(
              report,
              sqlite,
              'persistent_sessions',
              'DELETE FROM persistent_sessions WHERE id = ?',
              [sessionId],
            );
          }
        }
      }

      if (tableExists(sqlite, 'sessions')) {
        if (sessionIds === null) {
          const result = sqlite.query('DELETE FROM sessions').run();
          report.deletedSessions = changes(result);
        } else {
          for (const sessionId of sessionIds) {
            sqlite.query('UPDATE sessions SET parent_id = NULL WHERE parent_id = ?').run(sessionId);
            report.deletedSessions += changes(
              sqlite.query('DELETE FROM sessions WHERE id = ?').run(sessionId),
            );
          }
        }
      }

      assertNoRemnants(sqlite, sessionIds, processIds, collaborationIds);
      return report;
  });
  return transaction();
}
