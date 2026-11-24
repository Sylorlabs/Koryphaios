/**
 * Durable ledgers for automatic continuation.
 *
 * Two kinds of record live here, both in SQLite so a restart cannot lose them:
 *
 *   - `session_run_resumes`: one row per interrupted run that was considered for
 *     a restart continuation. `source_run_id` is the primary key, so a run is
 *     resumed at most once no matter how many restarts follow.
 *   - `session_pending_resumes`: at most one per session, the durable record of
 *     a turn that stopped on a provider usage limit and will be retried when the
 *     limit resets. Clearing the row is the user's "Cancel".
 *
 * Admission itself always goes through `KoryManager.startSessionTurn`; this
 * module only records intent and outcome.
 */

import type { Database } from 'bun:sqlite';
import { getDb } from '../db';

export type RunResumeState = 'pending' | 'admitted' | 'skipped';

export interface RunResumeRecord {
  sourceRunId: string;
  sessionId: string;
  state: RunResumeState;
  commandKey: string | null;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export type PendingResumeState = 'scheduled' | 'resuming';

export interface PendingResumeRecord {
  id: string;
  sessionId: string;
  reason: 'usage_limit';
  provider: string | null;
  model: string | null;
  resumeAt: number;
  attempt: number;
  state: PendingResumeState;
  message: string;
  /** The stopped run whose partial output the continuation carries. */
  sourceRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RunResumeRow {
  source_run_id: string;
  session_id: string;
  state: RunResumeState;
  command_key: string | null;
  reason: string;
  created_at: number;
  updated_at: number;
}

interface PendingResumeRow {
  id: string;
  session_id: string;
  reason: 'usage_limit';
  provider: string | null;
  model: string | null;
  resume_at: number;
  attempt: number;
  state: PendingResumeState;
  message: string;
  source_run_id: string | null;
  created_at: number;
  updated_at: number;
}

function runResumeFromRow(row: RunResumeRow): RunResumeRecord {
  return {
    sourceRunId: row.source_run_id,
    sessionId: row.session_id,
    state: row.state,
    commandKey: row.command_key,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pendingResumeFromRow(row: PendingResumeRow): PendingResumeRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    reason: row.reason,
    provider: row.provider,
    model: row.model,
    resumeAt: row.resume_at,
    attempt: row.attempt,
    state: row.state,
    message: row.message,
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunResumptionStore {
  constructor(private readonly sqlite: Database = getDb()) {}

  /** Record an interrupted run as pending a continuation. Returns false when the
   *  run was already considered (any state), which is what makes resumes once-only. */
  recordPendingRunResume(
    sourceRunId: string,
    sessionId: string,
    reason: string,
    now = Date.now(),
  ): boolean {
    const result = this.sqlite
      .query(
        `INSERT OR IGNORE INTO session_run_resumes
           (source_run_id, session_id, state, command_key, reason, created_at, updated_at)
         VALUES (?, ?, 'pending', NULL, ?, ?, ?)`,
      )
      .run(sourceRunId, sessionId, reason, now, now);
    return result.changes === 1;
  }

  getRunResume(sourceRunId: string): RunResumeRecord | null {
    const row = this.sqlite
      .query<RunResumeRow, [string]>('SELECT * FROM session_run_resumes WHERE source_run_id = ?')
      .get(sourceRunId);
    return row ? runResumeFromRow(row) : null;
  }

  listPendingRunResumes(limit = 100): RunResumeRecord[] {
    return this.sqlite
      .query<RunResumeRow, [number]>(
        `SELECT * FROM session_run_resumes WHERE state = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit)
      .map(runResumeFromRow);
  }

  markRunResumeAdmitted(sourceRunId: string, commandKey: string, now = Date.now()): void {
    this.sqlite
      .query(
        `UPDATE session_run_resumes SET state = 'admitted', command_key = ?, updated_at = ?
         WHERE source_run_id = ? AND state = 'pending'`,
      )
      .run(commandKey, now, sourceRunId);
  }

  markRunResumeSkipped(sourceRunId: string, reason: string, now = Date.now()): void {
    this.sqlite
      .query(
        `UPDATE session_run_resumes SET state = 'skipped', reason = ?, updated_at = ?
         WHERE source_run_id = ? AND state = 'pending'`,
      )
      .run(reason, now, sourceRunId);
  }

  /** Insert or replace the one pending usage-limit resume for a session. */
  upsertPendingResume(record: PendingResumeRecord): void {
    this.sqlite
      .query(
        `INSERT INTO session_pending_resumes
           (session_id, id, reason, provider, model, resume_at, attempt, state, message, source_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           id = excluded.id,
           reason = excluded.reason,
           provider = excluded.provider,
           model = excluded.model,
           resume_at = excluded.resume_at,
           attempt = excluded.attempt,
           state = excluded.state,
           message = excluded.message,
           source_run_id = excluded.source_run_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.sessionId,
        record.id,
        record.reason,
        record.provider,
        record.model,
        record.resumeAt,
        record.attempt,
        record.state,
        record.message,
        record.sourceRunId,
        record.createdAt,
        record.updatedAt,
      );
  }

  getPendingResume(sessionId: string): PendingResumeRecord | null {
    const row = this.sqlite
      .query<PendingResumeRow, [string]>(
        'SELECT * FROM session_pending_resumes WHERE session_id = ?',
      )
      .get(sessionId);
    return row ? pendingResumeFromRow(row) : null;
  }

  listPendingResumes(limit = 500): PendingResumeRecord[] {
    return this.sqlite
      .query<PendingResumeRow, [number]>(
        'SELECT * FROM session_pending_resumes ORDER BY resume_at ASC LIMIT ?',
      )
      .all(limit)
      .map(pendingResumeFromRow);
  }

  /** Remove the pending resume only when it is still the one the caller saw. */
  deletePendingResume(sessionId: string, id?: string): boolean {
    const result = id
      ? this.sqlite
          .query('DELETE FROM session_pending_resumes WHERE session_id = ? AND id = ?')
          .run(sessionId, id)
      : this.sqlite
          .query('DELETE FROM session_pending_resumes WHERE session_id = ?')
          .run(sessionId);
    return result.changes === 1;
  }
}
