import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  createIdleSessionRun,
  reduceSessionRun,
  type KoryAskUserPayload,
  type SessionRunCommand,
  type SessionRunSnapshot,
  type SessionRunStatePayload,
  type SessionRunTransition,
  type SessionRunWaitingPhase,
} from '@koryphaios/shared';
import { getDb } from '../db';
import { serverLog } from '../logger';

interface SessionRunRow {
  session_id: string;
  run_id: string | null;
  revision: number;
  phase: SessionRunSnapshot['phase'];
  status: SessionRunSnapshot['status'];
  waiting_reason: string;
  continuation_id: string | null;
  active_agent_ids: string;
  started_at: number | null;
  updated_at: number;
  finished_at: number | null;
  terminal_reason: string | null;
}

interface OutboxRow {
  event_id: string;
  payload: string;
}

interface SessionTurnCommandRow {
  command_key: string;
  session_id: string;
  source: SessionTurnCommandSource;
  source_command_id: string;
  input_hash: string;
  user_message_id: string;
  response_message_id: string;
  run_id: string;
  status: SessionTurnCommandStatus;
  terminal_reason: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ContinuationRow {
  id: string;
  session_id: string;
  run_id: string;
  wait_revision: number;
  kind: SessionRunContinuation['kind'];
  state: SessionRunContinuation['state'];
  payload: string;
  created_at: number;
  updated_at: number;
}

interface RestartHandoffRow {
  id: string;
  session_id: string;
  kind: SessionRunRestartHandoff['kind'];
  source_run_id: string;
  source_run_revision: number;
  question_id: string;
  question_payload: string;
  answer: string;
  state: SessionRunRestartHandoff['state'];
  claim_token: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_expires_at: number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  consumed_at: number | null;
}

interface UserInputRow {
  id: string;
  input_data: string;
  status: string | null;
}

interface ProcessWaitRow {
  id: string;
  session_id: string;
  status: string;
  provenance: string;
  supervision: string;
  is_background: number;
  terminal_reason: string | null;
}

interface DurableQuestionRecord {
  kind: 'question';
  status: 'pending' | 'answered' | 'cancelled';
  payload: KoryAskUserPayload;
  answer?: string;
  answeredAt?: number;
}

export interface RestartHandoffConversationBoundary {
  activeMessageId: string | null;
  providerConversationRevision: number;
}

interface RestartHandoffQuestionEnvelope {
  version: 1;
  question: KoryAskUserPayload;
  expectedBoundary: RestartHandoffConversationBoundary;
}

type TransitionEffect = (
  sqlite: Database,
  current: SessionRunSnapshot,
  next: SessionRunSnapshot,
) => void;

export interface StoredRunTransition {
  payload: SessionRunStatePayload;
  publishRequired: boolean;
}

export type SessionTurnCommandSource = 'goal' | 'collaboration' | 'internal';
export type SessionTurnCommandStatus = 'active' | 'completed' | 'failed' | 'cancelled' | 'waiting';
export type SessionTurnCommandTerminalStatus = Extract<
  SessionTurnCommandStatus,
  'completed' | 'failed' | 'cancelled'
>;

export interface SessionTurnCommandSourceIdentity {
  sessionId: string;
  source: SessionTurnCommandSource;
  sourceCommandId: string;
}

export interface SessionTurnCommandIdentity extends SessionTurnCommandSourceIdentity {
  commandKey: string;
  userMessageId: string;
  responseMessageId: string;
}

export interface SessionTurnCommandRecord extends SessionTurnCommandIdentity {
  inputHash: string;
  runId: string;
  status: SessionTurnCommandStatus;
  terminalReason: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface BeginSessionTurnCommandInput extends SessionTurnCommandSourceIdentity {
  /** SHA-256 of every input field that can affect execution. */
  inputHash: string;
  reason?: string;
  activeAgentIds?: string[];
}

export interface BeginSessionTurnCommandResult {
  disposition: 'started' | 'existing';
  command: SessionTurnCommandRecord;
  /** Present only when this call atomically created the run and its outbox event. */
  runTransition: StoredRunTransition | null;
}

export interface FinishSessionTurnCommandInput {
  commandKey: string;
  expectedRunId: string;
  expectedRevision: number;
  status: SessionTurnCommandTerminalStatus;
  terminalReason: string;
}

export interface FinishSessionTurnCommandResult {
  disposition: 'finished' | 'existing';
  command: SessionTurnCommandRecord;
  /** Null for an idempotent repeat of the already-recorded terminal receipt. */
  runTransition: StoredRunTransition | null;
}

export class SessionTurnCommandConflictError extends Error {
  constructor(
    message: string,
    readonly code:
      'IDENTITY_CONFLICT' | 'INPUT_HASH_MISMATCH' | 'RUN_MISMATCH' | 'TERMINAL_MISMATCH',
  ) {
    super(message);
    this.name = 'SessionTurnCommandConflictError';
  }
}

export interface SessionRunContinuation {
  id: string;
  sessionId: string;
  runId: string;
  waitRevision: number;
  kind: 'user_question' | 'process_set';
  state: 'pending' | 'ready' | 'claimed' | 'consumed' | 'cancelled';
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface StoredQuestionWait extends StoredRunTransition {
  question: KoryAskUserPayload;
}

export interface StoredQuestionAnswer extends StoredRunTransition {
  question: KoryAskUserPayload;
  handoff: SessionRunRestartHandoff | null;
}

export interface StoredProcessWait extends StoredRunTransition {
  processIds: string[];
  continuationId: string;
  expectedBoundary: RestartHandoffConversationBoundary | null;
}

export interface DurableProcessWait {
  snapshot: SessionRunSnapshot;
  continuation: SessionRunContinuation;
  processIds: string[];
}

export interface DurableClaimedProcessWake extends DurableProcessWait {
  expectedBoundary: RestartHandoffConversationBoundary | null;
}

export interface SessionRunRestartHandoff {
  id: string;
  sessionId: string;
  kind: 'resume_answered_question';
  /** Generation that owned the durable wait; this is provenance, not a live lease. */
  sourceRunId: string;
  sourceRunRevision: number;
  questionId: string;
  question: KoryAskUserPayload;
  /** Exact conversation generation the answer belongs to. A null value is a
   * legacy, unbound command and must fail closed rather than silently rebase. */
  expectedBoundary: RestartHandoffConversationBoundary | null;
  answer: string;
  state: 'pending' | 'claimed' | 'consumed';
  claimToken: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  consumedAt: number | null;
}

export type ClaimedSessionRunRestartHandoff = Omit<
  SessionRunRestartHandoff,
  'state' | 'claimToken' | 'claimedBy' | 'claimedAt' | 'leaseExpiresAt'
> & {
  state: 'claimed';
  claimToken: string;
  claimedBy: string;
  claimedAt: number;
  leaseExpiresAt: number;
};

const TERMINAL_PROCESS_STATUSES = new Set([
  'exited',
  'killed',
  'crashed',
  'spawn_failed',
  'orphaned',
]);

const VALID_PROCESS_STATUSES = new Set(['starting', 'running', ...TERMINAL_PROCESS_STATUSES]);

class PendingQuestionNotFoundError extends Error {}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Session turn command input cannot contain a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`Session turn command input cannot contain ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new Error('Session turn command input cannot contain a cycle');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => (item === undefined ? 'null' : canonicalJson(item, ancestors)))
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Session turn command input must contain only plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON SHA-256 used to bind a producer identity to its full payload. */
export function canonicalSessionTurnInputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function safeCommandIdentity(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    normalized !== value ||
    /[\0-\x1f\x7f]/.test(normalized)
  ) {
    throw new Error(`${label} must be a non-empty canonical identifier`);
  }
  return normalized;
}

/** Derive the only legal durable message ids for one producer command. */
export function deriveSessionTurnCommandIdentity(
  input: SessionTurnCommandSourceIdentity,
): SessionTurnCommandIdentity {
  const sessionId = safeCommandIdentity(input.sessionId, 'Session id', 512);
  const sourceCommandId = safeCommandIdentity(
    input.sourceCommandId,
    'Session turn source command id',
    512,
  );
  if (!['goal', 'collaboration', 'internal'].includes(input.source)) {
    throw new Error(`Unsupported session turn command source: ${String(input.source)}`);
  }
  const commandKey = createHash('sha256')
    .update(`${sessionId}\0${input.source}\0${sourceCommandId}`)
    .digest('hex')
    .slice(0, 40);
  return {
    commandKey,
    sessionId,
    source: input.source,
    sourceCommandId,
    userMessageId: `command-user-${commandKey}`,
    responseMessageId: `command-response-${commandKey}`,
  };
}

function validateInputHash(inputHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(inputHash)) {
    throw new Error('Session turn command input hash must be a lowercase SHA-256 digest');
  }
  return inputHash;
}

function validateCommandTime(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Session turn command time must be a non-negative safe integer');
  }
  return now;
}

function validateTerminalReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 2_048 || /\0/.test(normalized)) {
    throw new Error('Session turn command terminal reason must contain 1 to 2048 characters');
  }
  return normalized;
}

function decodeAgents(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseQuestion(value: string): DurableQuestionRecord | null {
  try {
    const parsed = parseObject(value) as unknown as DurableQuestionRecord;
    return parsed.kind === 'question' ? parsed : null;
  } catch {
    return null;
  }
}

function validateQuestionPayload(
  parsed: Partial<KoryAskUserPayload>,
  questionId: string,
): KoryAskUserPayload {
  if (
    parsed.questionId !== questionId ||
    typeof parsed.question !== 'string' ||
    !Array.isArray(parsed.options) ||
    !parsed.options.every((option) => typeof option === 'string') ||
    typeof parsed.allowOther !== 'boolean' ||
    (parsed.allowKeepChatting !== undefined && typeof parsed.allowKeepChatting !== 'boolean')
  ) {
    throw new Error(`Restart handoff question ${questionId} is malformed`);
  }
  return parsed as KoryAskUserPayload;
}

function parseHandoffQuestionPayload(
  value: string,
  questionId: string,
): {
  question: KoryAskUserPayload;
  expectedBoundary: RestartHandoffConversationBoundary | null;
} {
  const parsed = parseObject(value);
  if (parsed.version === 1 && parsed.question && typeof parsed.question === 'object') {
    const boundary = parsed.expectedBoundary as
      Partial<RestartHandoffConversationBoundary> | undefined;
    if (
      !boundary ||
      (boundary.activeMessageId !== null && typeof boundary.activeMessageId !== 'string') ||
      !Number.isSafeInteger(boundary.providerConversationRevision) ||
      Number(boundary.providerConversationRevision) < 0
    ) {
      throw new Error(`Restart handoff question ${questionId} has a malformed boundary`);
    }
    return {
      question: validateQuestionPayload(parsed.question as Partial<KoryAskUserPayload>, questionId),
      expectedBoundary: {
        activeMessageId: boundary.activeMessageId ?? null,
        providerConversationRevision: Number(boundary.providerConversationRevision),
      },
    };
  }
  // Rows created by an older binary carry no branch authority. Keep them
  // readable for observability, but the consumer must terminalize them as
  // unbound rather than attaching their answer to an arbitrary newer head.
  return {
    question: validateQuestionPayload(parsed as Partial<KoryAskUserPayload>, questionId),
    expectedBoundary: null,
  };
}

function processExpectedBoundary(
  continuation: SessionRunContinuation,
): RestartHandoffConversationBoundary | null {
  const raw = continuation.payload.expectedBoundary;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const boundary = raw as Partial<RestartHandoffConversationBoundary>;
  if (
    (boundary.activeMessageId !== null && typeof boundary.activeMessageId !== 'string') ||
    !Number.isSafeInteger(boundary.providerConversationRevision) ||
    Number(boundary.providerConversationRevision) < 0
  ) {
    return null;
  }
  return {
    activeMessageId: boundary.activeMessageId ?? null,
    providerConversationRevision: Number(boundary.providerConversationRevision),
  };
}

function restartHandoffFromRow(row: RestartHandoffRow): SessionRunRestartHandoff {
  const payload = parseHandoffQuestionPayload(row.question_payload, row.question_id);
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    sourceRunId: row.source_run_id,
    sourceRunRevision: row.source_run_revision,
    questionId: row.question_id,
    question: payload.question,
    expectedBoundary: payload.expectedBoundary,
    answer: row.answer,
    state: row.state,
    claimToken: row.claim_token,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
  };
}

function asClaimedRestartHandoff(
  handoff: SessionRunRestartHandoff,
): ClaimedSessionRunRestartHandoff {
  if (
    handoff.state !== 'claimed' ||
    !handoff.claimToken ||
    !handoff.claimedBy ||
    handoff.claimedAt === null ||
    handoff.leaseExpiresAt === null
  ) {
    throw new Error(`Restart handoff ${handoff.id} is not a valid claimed lease`);
  }
  return handoff as ClaimedSessionRunRestartHandoff;
}

function handoffLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Restart handoff list limit must be an integer between 1 and 1000');
  }
  return limit;
}

function handoffClaimant(claimedBy: string): string {
  const value = claimedBy.trim();
  if (!value || value.length > 512 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('Restart handoff claimant must be a non-empty safe identifier');
  }
  return value;
}

function handoffTimestamp(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Restart handoff time must be a non-negative safe integer');
  }
  return now;
}

function handoffLeaseExpiry(now: number, leaseDurationMs: number): number {
  handoffTimestamp(now);
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error('Restart handoff lease duration must be a positive safe integer');
  }
  const expiresAt = now + leaseDurationMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Restart handoff lease expiry exceeds the safe timestamp range');
  }
  return expiresAt;
}

function fromRow(row: SessionRunRow): SessionRunSnapshot {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    revision: row.revision,
    phase: row.phase,
    status: row.status,
    waitingReason: row.waiting_reason,
    continuationId: row.continuation_id,
    activeAgentIds: decodeAgents(row.active_agent_ids),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    terminalReason: row.terminal_reason,
  };
}

function sessionTurnCommandFromRow(row: SessionTurnCommandRow): SessionTurnCommandRecord {
  return {
    commandKey: row.command_key,
    sessionId: row.session_id,
    source: row.source,
    sourceCommandId: row.source_command_id,
    inputHash: row.input_hash,
    userMessageId: row.user_message_id,
    responseMessageId: row.response_message_id,
    runId: row.run_id,
    status: row.status,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function continuationFromRow(row: ContinuationRow): SessionRunContinuation {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    waitRevision: row.wait_revision,
    kind: row.kind,
    state: row.state,
    payload: parseObject(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameProjection(a: SessionRunSnapshot, b: SessionRunSnapshot): boolean {
  return (
    a.runId === b.runId &&
    a.phase === b.phase &&
    a.status === b.status &&
    a.waitingReason === b.waitingReason &&
    a.continuationId === b.continuationId &&
    a.terminalReason === b.terminalReason &&
    JSON.stringify(a.activeAgentIds) === JSON.stringify(b.activeAgentIds)
  );
}

function isRunStatePayload(value: unknown, eventId: string): value is SessionRunStatePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<SessionRunStatePayload>;
  return (
    !!payload.snapshot &&
    typeof payload.snapshot.sessionId === 'string' &&
    typeof payload.snapshot.revision === 'number' &&
    !!payload.transition &&
    payload.transition.eventId === eventId &&
    payload.transition.revision === payload.snapshot.revision
  );
}

/** SQLite repository, continuation unit of work, and transactional outbox. */
export class SessionRunStore {
  constructor(private readonly sqlite: Database = getDb()) {}

  get(sessionId: string): SessionRunSnapshot | null {
    const row = this.sqlite
      .query<SessionRunRow, [string]>('SELECT * FROM session_runs WHERE session_id = ?')
      .get(sessionId);
    return row ? fromRow(row) : null;
  }

  getOrIdle(sessionId: string, now = Date.now()): SessionRunSnapshot {
    return this.get(sessionId) ?? createIdleSessionRun(sessionId, now);
  }

  getSessionTurnCommand(commandKey: string): SessionTurnCommandRecord | null {
    const row = this.sqlite
      .query<SessionTurnCommandRow, [string]>(
        'SELECT * FROM session_turn_commands WHERE command_key = ?',
      )
      .get(commandKey);
    return row ? sessionTurnCommandFromRow(row) : null;
  }

  /**
   * Atomically reserve a producer command, its stable message ids, and the
   * SessionRun generation that owns execution. An existing receipt is returned
   * without ever starting another run; callers must decide from its status.
   */
  beginSessionTurnCommand(
    input: BeginSessionTurnCommandInput,
    now = Date.now(),
  ): BeginSessionTurnCommandResult {
    validateCommandTime(now);
    const identity = deriveSessionTurnCommandIdentity(input);
    const inputHash = validateInputHash(input.inputHash);
    const transact = this.sqlite.transaction((): BeginSessionTurnCommandResult => {
      const byKey = this.getSessionTurnCommand(identity.commandKey);
      const sourceRow = this.sqlite
        .query<SessionTurnCommandRow, [string, SessionTurnCommandSource, string]>(
          `SELECT * FROM session_turn_commands
           WHERE session_id = ? AND source = ? AND source_command_id = ?`,
        )
        .get(identity.sessionId, identity.source, identity.sourceCommandId);
      const bySource = sourceRow ? sessionTurnCommandFromRow(sourceRow) : null;
      if (byKey && bySource && byKey.commandKey !== bySource.commandKey) {
        throw new SessionTurnCommandConflictError(
          'The producer command identity resolves to conflicting durable receipts',
          'IDENTITY_CONFLICT',
        );
      }

      const existing = byKey ?? bySource;
      if (existing) {
        if (
          existing.commandKey !== identity.commandKey ||
          existing.sessionId !== identity.sessionId ||
          existing.source !== identity.source ||
          existing.sourceCommandId !== identity.sourceCommandId ||
          existing.userMessageId !== identity.userMessageId ||
          existing.responseMessageId !== identity.responseMessageId
        ) {
          throw new SessionTurnCommandConflictError(
            'The producer command identity is already bound to a different durable receipt',
            'IDENTITY_CONFLICT',
          );
        }
        if (existing.inputHash !== inputHash) {
          throw new SessionTurnCommandConflictError(
            'The producer command id is already bound to a different canonical input hash',
            'INPUT_HASH_MISMATCH',
          );
        }
        return { disposition: 'existing', command: existing, runTransition: null };
      }

      const runId = crypto.randomUUID();
      const runTransition = this.transitionAtomic(
        identity.sessionId,
        {
          kind: 'start',
          runId,
          reason: input.reason ?? `${identity.source}_turn`,
          activeAgentIds: input.activeAgentIds ?? ['kory-manager'],
        },
        now,
        (sqlite) => {
          sqlite
            .query(
              `INSERT INTO session_turn_commands (
                 command_key, session_id, source, source_command_id, input_hash,
                 user_message_id, response_message_id, run_id, status,
                 terminal_reason, created_at, updated_at, finished_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`,
            )
            .run(
              identity.commandKey,
              identity.sessionId,
              identity.source,
              identity.sourceCommandId,
              inputHash,
              identity.userMessageId,
              identity.responseMessageId,
              runId,
              now,
              now,
            );
        },
        false,
        false,
        true,
      );
      const command = this.getSessionTurnCommand(identity.commandKey);
      if (!command) throw new Error(`Session turn command ${identity.commandKey} disappeared`);
      return { disposition: 'started', command, runTransition };
    });
    return transact.immediate();
  }

  /** Terminalize the owned SessionRun and command receipt under the same CAS. */
  finishSessionTurnCommand(
    input: FinishSessionTurnCommandInput,
    now = Date.now(),
  ): FinishSessionTurnCommandResult {
    validateCommandTime(now);
    if (!/^[a-f0-9]{40}$/.test(input.commandKey)) {
      throw new Error('Session turn command key must be a lowercase 40-character digest');
    }
    const expectedRunId = safeCommandIdentity(input.expectedRunId, 'Expected run id', 128);
    const terminalReason = validateTerminalReason(input.terminalReason);
    const transact = this.sqlite.transaction((): FinishSessionTurnCommandResult => {
      const command = this.getSessionTurnCommand(input.commandKey);
      if (!command) throw new Error(`Session turn command ${input.commandKey} was not found`);
      if (command.runId !== expectedRunId) {
        throw new SessionTurnCommandConflictError(
          `Session turn command ${input.commandKey} belongs to run ${command.runId}`,
          'RUN_MISMATCH',
        );
      }
      if (
        command.status === 'completed' ||
        command.status === 'failed' ||
        command.status === 'cancelled'
      ) {
        if (command.status !== input.status || command.terminalReason !== terminalReason) {
          throw new SessionTurnCommandConflictError(
            `Session turn command ${input.commandKey} already has terminal outcome ${command.status}`,
            'TERMINAL_MISMATCH',
          );
        }
        return { disposition: 'existing', command, runTransition: null };
      }

      const current = this.get(command.sessionId);
      if (!current || current.runId !== command.runId) {
        throw new SessionTurnCommandConflictError(
          `Session turn command ${input.commandKey} no longer owns the current session run`,
          'RUN_MISMATCH',
        );
      }
      const runTransition = this.transitionAtomic(
        command.sessionId,
        input.status === 'completed'
          ? {
              kind: 'complete',
              expectedRunId,
              expectedRevision: input.expectedRevision,
              reason: terminalReason,
            }
          : input.status === 'failed'
            ? {
                kind: 'fail',
                expectedRunId,
                expectedRevision: input.expectedRevision,
                reason: terminalReason,
              }
            : {
                kind: 'cancel',
                expectedRunId,
                expectedRevision: input.expectedRevision,
                reason: terminalReason,
              },
        now,
        undefined,
        false,
        false,
        true,
      );
      const finished = this.getSessionTurnCommand(input.commandKey);
      if (!finished) throw new Error(`Session turn command ${input.commandKey} disappeared`);
      if (finished.status !== input.status || finished.terminalReason !== terminalReason) {
        throw new Error(
          `Session turn command ${input.commandKey} did not reach its terminal state`,
        );
      }
      return { disposition: 'finished', command: finished, runTransition };
    });
    return transact.immediate();
  }

  getContinuation(id: string): SessionRunContinuation | null {
    const row = this.sqlite
      .query<ContinuationRow, [string]>('SELECT * FROM session_run_continuations WHERE id = ?')
      .get(id);
    return row ? continuationFromRow(row) : null;
  }

  getRestartHandoff(id: string): SessionRunRestartHandoff | null {
    const row = this.sqlite
      .query<RestartHandoffRow, [string]>('SELECT * FROM session_run_handoffs WHERE id = ?')
      .get(id);
    return row ? restartHandoffFromRow(row) : null;
  }

  /** List every unfinished command, including currently leased work for observability. */
  listRestartHandoffs(limit = 100): SessionRunRestartHandoff[] {
    return this.sqlite
      .query<RestartHandoffRow, [number]>(
        `SELECT * FROM session_run_handoffs
         WHERE state <> 'consumed'
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(handoffLimit(limit))
      .map(restartHandoffFromRow);
  }

  listPendingRestartHandoffs(limit = 100): SessionRunRestartHandoff[] {
    return this.sqlite
      .query<RestartHandoffRow, [number]>(
        `SELECT * FROM session_run_handoffs
         WHERE state = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(handoffLimit(limit))
      .map(restartHandoffFromRow);
  }

  claimRestartHandoff(
    id: string,
    claimedBy: string,
    leaseDurationMs: number,
    now = Date.now(),
  ): ClaimedSessionRunRestartHandoff | null {
    const owner = handoffClaimant(claimedBy);
    const leaseExpiresAt = handoffLeaseExpiry(now, leaseDurationMs);
    const claimToken = crypto.randomUUID();
    const transact = this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `UPDATE session_run_handoffs
           SET state = 'claimed', claim_token = ?, claimed_by = ?, claimed_at = ?,
               lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(claimToken, owner, now, leaseExpiresAt, now, id);
      if (result.changes !== 1) return null;
      const handoff = this.getRestartHandoff(id);
      if (!handoff) throw new Error(`Claimed restart handoff ${id} disappeared`);
      return asClaimedRestartHandoff(handoff);
    });
    return transact.immediate();
  }

  /** Extend an unexpired lease. Once expired, only recovery may make it claimable again. */
  renewRestartHandoff(
    id: string,
    claimToken: string,
    leaseDurationMs: number,
    now = Date.now(),
  ): ClaimedSessionRunRestartHandoff | null {
    const leaseExpiresAt = handoffLeaseExpiry(now, leaseDurationMs);
    const transact = this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `UPDATE session_run_handoffs
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(leaseExpiresAt, now, id, claimToken, now);
      if (result.changes !== 1) return null;
      const handoff = this.getRestartHandoff(id);
      if (!handoff) throw new Error(`Renewed restart handoff ${id} disappeared`);
      return asClaimedRestartHandoff(handoff);
    });
    return transact.immediate();
  }

  /** Release an unexpired lease. A stale token is deliberately a no-op. */
  requeueRestartHandoff(
    id: string,
    claimToken: string,
    reason = 'claim released for retry',
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    handoffTimestamp(now);
    const error = reason.trim().slice(0, 1_000) || 'claim released for retry';
    const transact = this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `UPDATE session_run_handoffs
           SET state = 'pending', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
               lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(error, now, id, claimToken, now);
      return result.changes === 1 ? this.getRestartHandoff(id) : null;
    });
    return transact.immediate();
  }

  /** Startup/worker recovery for owners that crashed and let their lease expire. */
  requeueExpiredRestartHandoffs(now = Date.now(), limit = 100): number {
    handoffTimestamp(now);
    const batchSize = handoffLimit(limit);
    const transact = this.sqlite.transaction(
      () =>
        this.sqlite
          .query(
            `UPDATE session_run_handoffs
           SET state = 'pending', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
               lease_expires_at = NULL, last_error = 'claim lease expired', updated_at = ?
           WHERE id IN (
             SELECT id FROM session_run_handoffs
             WHERE state = 'claimed' AND lease_expires_at <= ?
             ORDER BY lease_expires_at ASC, created_at ASC, id ASC LIMIT ?
           )`,
          )
          .run(now, now, batchSize).changes,
    );
    return transact.immediate();
  }

  /**
   * Acknowledge completed handling or a separate restart-safe admission. An
   * in-memory provider call is not sufficient. This does not claim provider
   * side effects happened exactly once; it only consumes this command lease.
   */
  consumeRestartHandoff(
    id: string,
    claimToken: string,
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    handoffTimestamp(now);
    const transact = this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `UPDATE session_run_handoffs
           SET state = 'consumed', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
               lease_expires_at = NULL, consumed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(now, now, id, claimToken, now);
      return result.changes === 1 ? this.getRestartHandoff(id) : null;
    });
    return transact.immediate();
  }

  /** Terminalize a command that must not be retried (cancelled, stale branch,
   * or already-started work recovered without a durable completion). */
  abandonRestartHandoff(
    id: string,
    claimToken: string,
    reason: string,
    now = Date.now(),
  ): SessionRunRestartHandoff | null {
    handoffTimestamp(now);
    const error = reason.trim().slice(0, 1_000) || 'restart handoff abandoned';
    const transact = this.sqlite.transaction(() => {
      const result = this.sqlite
        .query(
          `UPDATE session_run_handoffs
           SET state = 'consumed', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
               lease_expires_at = NULL, last_error = ?, consumed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claim_token = ? AND lease_expires_at > ?`,
        )
        .run(error, now, now, id, claimToken, now);
      return result.changes === 1 ? this.getRestartHandoff(id) : null;
    });
    return transact.immediate();
  }

  /** Explicit session cancellation has authority to revoke every unfinished
   * command, including a currently leased one. Claim tokens are deliberately
   * bypassed here; the local consumer is separately aborted by KoryManager. */
  cancelRestartHandoffsForSession(
    sessionId: string,
    reason = 'session cancelled by user',
    now = Date.now(),
  ): number {
    handoffTimestamp(now);
    const error = reason.trim().slice(0, 1_000) || 'session cancelled by user';
    const transact = this.sqlite.transaction(
      () =>
        this.sqlite
          .query(
            `UPDATE session_run_handoffs
             SET state = 'consumed', claim_token = NULL, claimed_by = NULL, claimed_at = NULL,
                 lease_expires_at = NULL, last_error = ?, consumed_at = ?, updated_at = ?
             WHERE session_id = ? AND state IN ('pending', 'claimed')`,
          )
          .run(error, now, now, sessionId).changes,
    );
    return transact.immediate();
  }

  transition(sessionId: string, command: SessionRunCommand, now = Date.now()): StoredRunTransition {
    return this.transitionAtomic(sessionId, command, now);
  }

  parkForQuestion(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    reason: string,
    input: Omit<KoryAskUserPayload, 'questionId'>,
    now = Date.now(),
  ): StoredQuestionWait {
    const questionId = crypto.randomUUID();
    const question: KoryAskUserPayload = { ...input, questionId };
    const stored = this.transitionAtomic(
      sessionId,
      {
        kind: 'wait',
        expectedRunId: runId,
        expectedRevision,
        phase: 'waiting_user',
        reason,
        continuationId: questionId,
      },
      now,
      (sqlite, _current, next) => {
        this.cancelOlderPendingQuestions(sqlite, sessionId, now);
        sqlite
          .query(
            `INSERT INTO session_run_continuations
               (id, session_id, run_id, wait_revision, kind, state, payload, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'user_question', 'pending', ?, ?, ?)`,
          )
          .run(
            questionId,
            sessionId,
            runId,
            next.revision,
            JSON.stringify({ questionId }),
            now,
            now,
          );
        const record: DurableQuestionRecord = {
          kind: 'question',
          status: 'pending',
          payload: question,
        };
        sqlite
          .query(
            `INSERT INTO user_inputs
               (id, session_id, input_data, run_id, run_revision, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(questionId, sessionId, JSON.stringify(record), runId, next.revision, now);
      },
    );
    return { ...stored, question };
  }

  answerQuestion(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    questionId: string | undefined,
    answer: string,
    resumeLiveWaiter: boolean,
    now = Date.now(),
  ): StoredQuestionAnswer | null {
    let question: KoryAskUserPayload | null = null;
    const handoffId = resumeLiveWaiter ? null : crypto.randomUUID();
    try {
      const stored = this.transitionAtomic(
        sessionId,
        resumeLiveWaiter
          ? {
              kind: 'resume',
              expectedRunId: runId,
              expectedRevision,
              expectedWaitingPhase: 'waiting_user',
              phase: 'analyzing',
              reason: 'user_input_received',
            }
          : {
              kind: 'complete',
              expectedRunId: runId,
              expectedRevision,
              reason: 'user_input_handoff_after_restart',
            },
        now,
        (sqlite, current) => {
          const continuation = this.requireContinuation(sqlite, current, 'user_question');
          const ownedQuestionId = String(continuation.payload.questionId ?? '');
          if (!ownedQuestionId || (questionId && questionId !== ownedQuestionId)) {
            throw new PendingQuestionNotFoundError();
          }
          const row = sqlite
            .query<UserInputRow, [string, string]>(
              `SELECT id, input_data, status FROM user_inputs
               WHERE id = ? AND session_id = ?`,
            )
            .get(ownedQuestionId, sessionId);
          const record = row ? parseQuestion(row.input_data) : null;
          if (!row || !record || (row.status ?? record.status) !== 'pending') {
            throw new PendingQuestionNotFoundError();
          }
          question = record.payload;
          const answered: DurableQuestionRecord = {
            ...record,
            status: 'answered',
            answer,
            answeredAt: now,
          };
          const updated = sqlite
            .query(
              `UPDATE user_inputs SET input_data = ?, status = 'answered'
               WHERE id = ? AND session_id = ? AND (status = 'pending' OR status IS NULL)`,
            )
            .run(JSON.stringify(answered), ownedQuestionId, sessionId);
          if (updated.changes !== 1) throw new PendingQuestionNotFoundError();

          if (handoffId) {
            if (!current.runId) throw new Error('Restart handoff source run is missing its id');
            const boundary = sqlite
              .query<
                { active_message_id: string | null; provider_conversation_revision: number | null },
                [string]
              >(
                `SELECT active_message_id, provider_conversation_revision
                 FROM sessions WHERE id = ?`,
              )
              .get(sessionId);
            if (!boundary) throw new Error('Restart handoff session boundary is missing');
            const envelope: RestartHandoffQuestionEnvelope = {
              version: 1,
              question: record.payload,
              expectedBoundary: {
                activeMessageId: boundary.active_message_id,
                providerConversationRevision: boundary.provider_conversation_revision ?? 0,
              },
            };
            sqlite
              .query(
                `INSERT INTO session_run_handoffs (
                   id, session_id, kind, source_run_id, source_run_revision,
                   question_id, question_payload, answer, state, attempt_count,
                   created_at, updated_at
                 ) VALUES (
                   ?, ?, 'resume_answered_question', ?, ?, ?, ?, ?, 'pending', 0, ?, ?
                 )`,
              )
              .run(
                handoffId,
                sessionId,
                current.runId,
                current.revision,
                ownedQuestionId,
                JSON.stringify(envelope),
                answer,
                now,
                now,
              );
          }
        },
        false,
        !resumeLiveWaiter,
      );
      if (!question) return null;
      const handoff = handoffId ? this.getRestartHandoff(handoffId) : null;
      if (handoffId && !handoff) {
        throw new Error(`Committed restart handoff ${handoffId} is missing`);
      }
      return { ...stored, question, handoff };
    } catch (error) {
      if (error instanceof PendingQuestionNotFoundError) return null;
      throw error;
    }
  }

  parkForProcesses(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    processIds: readonly string[],
    reason: string,
    now = Date.now(),
  ): StoredProcessWait {
    const uniqueIds = [...new Set(processIds)].filter(Boolean).sort();
    if (uniqueIds.length === 0) throw new Error('A process wait requires at least one process id');
    const continuationId = crypto.randomUUID();
    let expectedBoundary: RestartHandoffConversationBoundary | null = null;
    const stored = this.transitionAtomic(
      sessionId,
      {
        kind: 'wait',
        expectedRunId: runId,
        expectedRevision,
        phase: 'waiting_terminal',
        reason,
        continuationId,
      },
      now,
      (sqlite, _current, next) => {
        const processes = this.loadOwnedAgentProcesses(sqlite, sessionId, uniqueIds);
        if (processes.some((process) => !VALID_PROCESS_STATUSES.has(process.status))) {
          throw new Error('Process continuation references invalid process state');
        }
        const boundary = sqlite
          .query<
            { active_message_id: string | null; provider_conversation_revision: number | null },
            [string]
          >(
            `SELECT active_message_id, provider_conversation_revision
             FROM sessions WHERE id = ?`,
          )
          .get(sessionId);
        if (!boundary) throw new Error('Process continuation session boundary is missing');
        expectedBoundary = {
          activeMessageId: boundary.active_message_id,
          providerConversationRevision: boundary.provider_conversation_revision ?? 0,
        };
        sqlite
          .query(
            `INSERT INTO session_run_continuations
               (id, session_id, run_id, wait_revision, kind, state, payload, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'process_set', 'pending', ?, ?, ?)`,
          )
          .run(
            continuationId,
            sessionId,
            runId,
            next.revision,
            JSON.stringify({ processIds: uniqueIds, expectedBoundary }),
            now,
            now,
          );
        const insertReference = sqlite.query(
          `INSERT INTO session_run_continuation_processes (continuation_id, process_id)
           VALUES (?, ?)`,
        );
        for (const processId of uniqueIds) insertReference.run(continuationId, processId);
      },
    );
    return { ...stored, processIds: uniqueIds, continuationId, expectedBoundary };
  }

  resumeProcessWait(
    sessionId: string,
    runId: string,
    expectedRevision: number,
    now = Date.now(),
  ): StoredProcessWait {
    let processIds: string[] = [];
    let continuationId = '';
    let expectedBoundary: RestartHandoffConversationBoundary | null = null;
    const stored = this.transitionAtomic(
      sessionId,
      {
        kind: 'resume',
        expectedRunId: runId,
        expectedRevision,
        expectedWaitingPhase: 'waiting_terminal',
        phase: 'analyzing',
        reason: 'background_process_completed',
      },
      now,
      (sqlite, current) => {
        const continuation = this.requireContinuation(sqlite, current, 'process_set');
        continuationId = continuation.id;
        expectedBoundary = processExpectedBoundary(continuation);
        processIds = this.processIdsForContinuation(sqlite, continuation.id);
        if (processIds.length === 0) throw new Error('Process continuation has no process ids');
        const rows = this.loadOwnedAgentProcesses(sqlite, current.sessionId, processIds);
        if (
          rows.some(
            (row) =>
              row.terminal_reason === 'session-cancelled' ||
              row.terminal_reason === 'killed-for-restart',
          )
        ) {
          throw new Error('Process continuation ended through cancellation or restart');
        }
        if (rows.some((row) => !TERMINAL_PROCESS_STATUSES.has(row.status))) {
          throw new Error('Process continuation is not ready');
        }
      },
    );
    if (!continuationId) throw new Error('Resumed process continuation identity is missing');
    return { ...stored, processIds, continuationId, expectedBoundary };
  }

  listUnpublished(limit = 256): SessionRunStatePayload[] {
    const payloads: SessionRunStatePayload[] = [];
    const rows = this.sqlite
      .query<OutboxRow, [number]>(
        `SELECT event_id, payload FROM session_run_events
         WHERE published_at IS NULL AND dead_letter_reason IS NULL
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit);
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (!isRunStatePayload(parsed, row.event_id)) throw new Error('invalid run-state payload');
        payloads.push(parsed);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.sqlite
          .query(
            `UPDATE session_run_events SET dead_letter_reason = ?
             WHERE event_id = ? AND published_at IS NULL`,
          )
          .run(reason.slice(0, 500), row.event_id);
        serverLog.error(
          { eventId: row.event_id, error: reason },
          'Quarantined malformed session-run outbox row',
        );
      }
    }
    return payloads;
  }

  markPublished(eventId: string, publishedAt = Date.now()): void {
    this.sqlite
      .query('UPDATE session_run_events SET published_at = ? WHERE event_id = ?')
      .run(publishedAt, eventId);
  }

  prunePublished(before: number, limit = 1_000): number {
    const result = this.sqlite
      .query(
        `DELETE FROM session_run_events WHERE event_id IN (
           SELECT event_id FROM session_run_events
           WHERE published_at IS NOT NULL AND published_at < ?
           ORDER BY published_at ASC LIMIT ?
         )`,
      )
      .run(before, limit);
    return result.changes;
  }

  listActive(): SessionRunSnapshot[] {
    return this.listByStatus('active');
  }

  listWaiting(phase?: SessionRunWaitingPhase): SessionRunSnapshot[] {
    if (!phase) return this.listByStatus('waiting');
    return this.sqlite
      .query<SessionRunRow, [SessionRunWaitingPhase]>(
        "SELECT * FROM session_runs WHERE status = 'waiting' AND phase = ?",
      )
      .all(phase)
      .map(fromRow);
  }

  listProcessWaits(): DurableProcessWait[] {
    const waits: DurableProcessWait[] = [];
    for (const snapshot of this.listWaiting('waiting_terminal')) {
      if (!snapshot.continuationId) continue;
      const continuation = this.getContinuation(snapshot.continuationId);
      if (
        !continuation ||
        continuation.kind !== 'process_set' ||
        continuation.state !== 'pending' ||
        continuation.sessionId !== snapshot.sessionId ||
        continuation.runId !== snapshot.runId ||
        continuation.waitRevision !== snapshot.revision
      ) {
        continue;
      }
      const processIds = this.processIdsForContinuation(this.sqlite, continuation.id);
      if (processIds.length === 0) continue;
      waits.push({ snapshot, continuation, processIds });
    }
    return waits;
  }

  /** Claimed wakes remain discoverable while their provider continuation is
   * active. They are intentionally not replayed after a crash because tool
   * side effects may already have happened; startup fails the owning run and
   * closes the claim visibly. */
  listClaimedProcessWakes(): DurableClaimedProcessWake[] {
    const rows = this.sqlite
      .query<ContinuationRow, []>(
        `SELECT * FROM session_run_continuations
         WHERE kind = 'process_set' AND state = 'claimed'
         ORDER BY created_at ASC, id ASC`,
      )
      .all();
    return rows.flatMap((row) => {
      const continuation = continuationFromRow(row);
      const snapshot = this.get(continuation.sessionId);
      if (!snapshot || snapshot.runId !== continuation.runId || snapshot.status !== 'active') {
        return [];
      }
      const processIds = this.processIdsForContinuation(this.sqlite, continuation.id);
      if (processIds.length === 0) return [];
      return [
        {
          snapshot,
          continuation,
          processIds,
          expectedBoundary: processExpectedBoundary(continuation),
        },
      ];
    });
  }

  isWaitingContinuationValid(snapshot: SessionRunSnapshot): boolean {
    if (snapshot.status !== 'waiting' || !snapshot.runId || !snapshot.continuationId) return false;
    const continuation = this.getContinuation(snapshot.continuationId);
    if (
      !continuation ||
      continuation.sessionId !== snapshot.sessionId ||
      continuation.runId !== snapshot.runId ||
      continuation.waitRevision !== snapshot.revision ||
      continuation.state !== 'pending'
    ) {
      return false;
    }
    if (snapshot.phase === 'waiting_user') {
      if (continuation.kind !== 'user_question') return false;
      const questionId = String(continuation.payload.questionId ?? '');
      const row = this.sqlite
        .query<UserInputRow, [string, string]>(
          'SELECT id, input_data, status FROM user_inputs WHERE id = ? AND session_id = ?',
        )
        .get(questionId, snapshot.sessionId);
      const record = row ? parseQuestion(row.input_data) : null;
      return !!row && !!record && (row.status ?? record.status) === 'pending';
    }
    if (continuation.kind !== 'process_set') return false;
    const processIds = this.processIdsForContinuation(this.sqlite, continuation.id);
    if (processIds.length === 0) return false;
    try {
      return this.loadOwnedAgentProcesses(this.sqlite, snapshot.sessionId, processIds).every(
        (row) => VALID_PROCESS_STATUSES.has(row.status),
      );
    } catch {
      return false;
    }
  }

  terminalizeOrphanedWait(
    snapshot: SessionRunSnapshot,
    reason: string,
    now = Date.now(),
  ): StoredRunTransition {
    if (!snapshot.runId || snapshot.status !== 'waiting') {
      throw new Error(`Session ${snapshot.sessionId} is not an orphanable wait`);
    }
    return this.transitionAtomic(
      snapshot.sessionId,
      {
        kind: 'fail',
        expectedRunId: snapshot.runId,
        expectedRevision: snapshot.revision,
        reason,
      },
      now,
      undefined,
      true,
    );
  }

  private transitionAtomic(
    sessionId: string,
    command: SessionRunCommand,
    now: number,
    effect?: TransitionEffect,
    allowOrphanedContinuation = false,
    allowWaitingComplete = false,
    withinTransaction = false,
  ): StoredRunTransition {
    const apply = (): StoredRunTransition => {
      const current = this.getOrIdle(sessionId, now);
      if (current.status === 'waiting' && command.kind === 'complete' && !allowWaitingComplete) {
        throw new Error('A waiting run may complete only through its owned continuation');
      }
      const next = reduceSessionRun(current, command, now);

      if (command.kind !== 'start' && sameProjection(current, next)) {
        return { payload: { snapshot: current, transition: null }, publishRequired: false };
      }

      effect?.(this.sqlite, current, next);
      if (command.kind === 'wait') {
        const continuation = this.getContinuation(command.continuationId);
        if (
          !continuation ||
          continuation.sessionId !== sessionId ||
          continuation.runId !== next.runId ||
          continuation.waitRevision !== next.revision ||
          continuation.state !== 'pending'
        ) {
          throw new Error('Wait transition requires a matching pending continuation');
        }
      } else if (current.continuationId) {
        if (allowOrphanedContinuation) {
          this.sqlite
            .query(
              `UPDATE session_run_continuations SET state = 'cancelled', updated_at = ?
               WHERE id = ? AND state = 'pending'`,
            )
            .run(now, current.continuationId);
          this.sqlite
            .query(`DELETE FROM session_run_continuation_processes WHERE continuation_id = ?`)
            .run(current.continuationId);
        } else if (command.kind === 'resume') {
          const continuation = this.getContinuation(current.continuationId);
          if (continuation?.kind === 'process_set') {
            const claimed = this.sqlite
              .query(
                `UPDATE session_run_continuations SET state = 'claimed', updated_at = ?
                 WHERE id = ? AND state = 'pending'`,
              )
              .run(now, continuation.id);
            if (claimed.changes !== 1) {
              throw new Error(`Process continuation ${continuation.id} could not be claimed`);
            }
          } else {
            this.closeContinuation(this.sqlite, current, command.kind, now);
          }
        } else {
          this.closeContinuation(this.sqlite, current, command.kind, now);
        }
      }
      if (
        !current.continuationId &&
        (command.kind === 'wait' ||
          command.kind === 'complete' ||
          command.kind === 'fail' ||
          command.kind === 'cancel')
      ) {
        this.closeClaimedProcessWake(this.sqlite, current, command.kind, now);
      }

      const eventId = crypto.randomUUID();
      const reason = 'reason' in command ? (command.reason ?? null) : null;
      const transition: SessionRunTransition = {
        eventId,
        sessionId,
        runId: next.runId,
        revision: next.revision,
        command: command.kind,
        previousPhase: current.phase,
        phase: next.phase,
        reason,
        occurredAt: now,
      };
      const payload: SessionRunStatePayload = { snapshot: next, transition };

      this.sqlite
        .query(
          `INSERT INTO session_runs (
             session_id, run_id, revision, phase, status, waiting_reason,
             continuation_id, active_agent_ids, started_at, updated_at,
             finished_at, terminal_reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             run_id = excluded.run_id,
             revision = excluded.revision,
             phase = excluded.phase,
             status = excluded.status,
             waiting_reason = excluded.waiting_reason,
             continuation_id = excluded.continuation_id,
             active_agent_ids = excluded.active_agent_ids,
             started_at = excluded.started_at,
             updated_at = excluded.updated_at,
             finished_at = excluded.finished_at,
             terminal_reason = excluded.terminal_reason`,
        )
        .run(
          next.sessionId,
          next.runId,
          next.revision,
          next.phase,
          next.status,
          next.waitingReason,
          next.continuationId,
          JSON.stringify(next.activeAgentIds),
          next.startedAt,
          next.updatedAt,
          next.finishedAt,
          next.terminalReason,
        );

      this.synchronizeSessionTurnCommand(this.sqlite, next);

      this.sqlite
        .query(
          `INSERT INTO session_run_events
             (event_id, session_id, run_id, revision, payload, created_at, published_at, dead_letter_reason)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(eventId, sessionId, next.runId, next.revision, JSON.stringify(payload), now);

      return { payload, publishRequired: true };
    };

    if (withinTransaction) {
      if (!this.sqlite.inTransaction) {
        throw new Error('Session run transition expected an open SQLite transaction');
      }
      return apply();
    }
    return this.sqlite.transaction(apply).immediate();
  }

  /** Keep the command receipt and run aggregate on the same commit boundary. */
  private synchronizeSessionTurnCommand(sqlite: Database, snapshot: SessionRunSnapshot): void {
    if (!snapshot.runId) return;
    const existing = sqlite
      .query<{ command_key: string }, [string, string]>(
        `SELECT command_key FROM session_turn_commands WHERE session_id = ? AND run_id = ?`,
      )
      .get(snapshot.sessionId, snapshot.runId);
    if (!existing) return;

    const status: SessionTurnCommandStatus =
      snapshot.status === 'waiting'
        ? 'waiting'
        : snapshot.phase === 'done'
          ? 'completed'
          : snapshot.phase === 'error'
            ? 'failed'
            : snapshot.phase === 'cancelled'
              ? 'cancelled'
              : 'active';
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    const terminalReason = terminal
      ? (snapshot.terminalReason ??
        (status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'))
      : null;
    const finishedAt = terminal ? (snapshot.finishedAt ?? snapshot.updatedAt) : null;
    const updated = sqlite
      .query(
        `UPDATE session_turn_commands
         SET status = ?, terminal_reason = ?, updated_at = ?, finished_at = ?
         WHERE command_key = ? AND session_id = ? AND run_id = ?`,
      )
      .run(
        status,
        terminalReason,
        snapshot.updatedAt,
        finishedAt,
        existing.command_key,
        snapshot.sessionId,
        snapshot.runId,
      );
    if (updated.changes !== 1) {
      throw new Error(`Session turn command ${existing.command_key} lost its run ownership`);
    }
  }

  private listByStatus(status: SessionRunSnapshot['status']): SessionRunSnapshot[] {
    return this.sqlite
      .query<SessionRunRow, [SessionRunSnapshot['status']]>(
        'SELECT * FROM session_runs WHERE status = ?',
      )
      .all(status)
      .map(fromRow);
  }

  private requireContinuation(
    sqlite: Database,
    current: SessionRunSnapshot,
    kind: SessionRunContinuation['kind'],
  ): SessionRunContinuation {
    if (!current.continuationId) throw new Error(`Run ${current.runId} has no continuation`);
    const row = sqlite
      .query<ContinuationRow, [string]>('SELECT * FROM session_run_continuations WHERE id = ?')
      .get(current.continuationId);
    if (!row) throw new Error(`Continuation ${current.continuationId} is missing`);
    const continuation = continuationFromRow(row);
    if (
      continuation.kind !== kind ||
      continuation.state !== 'pending' ||
      continuation.sessionId !== current.sessionId ||
      continuation.runId !== current.runId ||
      continuation.waitRevision !== current.revision
    ) {
      throw new Error(`Continuation ${current.continuationId} does not own the current wait`);
    }
    return continuation;
  }

  private closeContinuation(
    sqlite: Database,
    current: SessionRunSnapshot,
    command: SessionRunCommand['kind'],
    now: number,
  ): void {
    if (!current.continuationId) return;
    const row = sqlite
      .query<ContinuationRow, [string]>('SELECT * FROM session_run_continuations WHERE id = ?')
      .get(current.continuationId);
    if (!row) throw new Error(`Continuation ${current.continuationId} is missing`);
    const continuation = continuationFromRow(row);
    if (
      continuation.sessionId !== current.sessionId ||
      continuation.runId !== current.runId ||
      continuation.waitRevision !== current.revision ||
      continuation.state !== 'pending'
    ) {
      throw new Error(`Continuation ${current.continuationId} cannot be consumed`);
    }
    const state = command === 'resume' || command === 'complete' ? 'consumed' : 'cancelled';
    sqlite
      .query(
        `UPDATE session_run_continuations SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(state, now, continuation.id);

    if (continuation.kind === 'process_set') {
      sqlite
        .query(`DELETE FROM session_run_continuation_processes WHERE continuation_id = ?`)
        .run(continuation.id);
    }

    if (continuation.kind === 'user_question' && state === 'cancelled') {
      const questionId = String(continuation.payload.questionId ?? '');
      const questionRow = sqlite
        .query<UserInputRow, [string, string]>(
          'SELECT id, input_data, status FROM user_inputs WHERE id = ? AND session_id = ?',
        )
        .get(questionId, current.sessionId);
      const record = questionRow ? parseQuestion(questionRow.input_data) : null;
      if (questionRow && record && (questionRow.status ?? record.status) === 'pending') {
        const cancelled: DurableQuestionRecord = {
          ...record,
          status: 'cancelled',
          answer: '__cancelled__',
          answeredAt: now,
        };
        sqlite
          .query(
            `UPDATE user_inputs SET input_data = ?, status = 'cancelled'
             WHERE id = ? AND session_id = ?`,
          )
          .run(JSON.stringify(cancelled), questionId, current.sessionId);
      }
    }
  }

  private closeClaimedProcessWake(
    sqlite: Database,
    current: SessionRunSnapshot,
    command: 'wait' | 'complete' | 'fail' | 'cancel',
    now: number,
  ): void {
    if (!current.runId) return;
    const rows = sqlite
      .query<ContinuationRow, [string, string]>(
        `SELECT * FROM session_run_continuations
         WHERE session_id = ? AND run_id = ? AND kind = 'process_set' AND state = 'claimed'`,
      )
      .all(current.sessionId, current.runId);
    if (rows.length > 1) {
      throw new Error(`Run ${current.runId} owns multiple claimed process continuations`);
    }
    const row = rows[0];
    if (!row) return;
    const state = command === 'wait' || command === 'complete' ? 'consumed' : 'cancelled';
    const updated = sqlite
      .query(
        `UPDATE session_run_continuations SET state = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed'`,
      )
      .run(state, now, row.id);
    if (updated.changes !== 1) {
      throw new Error(`Claimed process continuation ${row.id} could not be closed`);
    }
    sqlite
      .query(`DELETE FROM session_run_continuation_processes WHERE continuation_id = ?`)
      .run(row.id);
  }

  private cancelOlderPendingQuestions(sqlite: Database, sessionId: string, now: number): void {
    const rows = sqlite
      .query<UserInputRow, [string]>(
        `SELECT id, input_data, status FROM user_inputs
         WHERE session_id = ? AND (status = 'pending' OR status IS NULL)
         ORDER BY created_at DESC LIMIT 50`,
      )
      .all(sessionId);
    for (const row of rows) {
      const record = parseQuestion(row.input_data);
      if (!record || (row.status ?? record.status) !== 'pending') continue;
      const cancelled: DurableQuestionRecord = {
        ...record,
        status: 'cancelled',
        answer: '__cancelled__',
        answeredAt: now,
      };
      sqlite
        .query(`UPDATE user_inputs SET input_data = ?, status = 'cancelled' WHERE id = ?`)
        .run(JSON.stringify(cancelled), row.id);
    }
  }

  private processIdsForContinuation(sqlite: Database, continuationId: string): string[] {
    return sqlite
      .query<{ process_id: string }, [string]>(
        `SELECT process_id FROM session_run_continuation_processes
         WHERE continuation_id = ? ORDER BY process_id`,
      )
      .all(continuationId)
      .map((row) => row.process_id);
  }

  private loadOwnedAgentProcesses(
    sqlite: Database,
    sessionId: string,
    processIds: readonly string[],
  ): ProcessWaitRow[] {
    const placeholders = processIds.map(() => '?').join(', ');
    const rows = sqlite
      .query<ProcessWaitRow, string[]>(
        `SELECT id, session_id, status, provenance, supervision, is_background, terminal_reason
         FROM supervised_processes WHERE id IN (${placeholders})`,
      )
      .all(...processIds);
    if (rows.length !== processIds.length) {
      throw new Error('Process continuation references missing process state');
    }
    const actualIds = new Set(rows.map((row) => row.id));
    if (processIds.some((id) => !actualIds.has(id))) {
      throw new Error('Process continuation process identity mismatch');
    }
    if (
      rows.some(
        (row) =>
          row.provenance !== 'agent-tool' ||
          row.supervision !== 'owned-child' ||
          row.is_background !== 1 ||
          row.session_id !== sessionId,
      )
    ) {
      throw new Error('Process continuation references a process outside agent ownership');
    }
    return rows;
  }
}
