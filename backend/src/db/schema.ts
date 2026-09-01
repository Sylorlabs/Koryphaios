/**
 * Database Schema
 * SQLite-only schema for Koryphaios desktop mode
 */

import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  unique,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql, relations } from 'drizzle-orm';

// ============================================================================
// Core Tables
// ============================================================================

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  /** Null while visible in the normal chat list. A timestamp means the chat is
   * archived but still fully recoverable; deletion remains a separate path. */
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  parentId: text('parent_id'),
  messageCount: integer('message_count').default(0),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  totalCost: real('total_cost').default(0),
  workflowState: text('workflow_state').default('idle'),
  /** Active compaction revision used to assemble the model context. */
  conversationRevision: integer('conversation_revision').default(0),
  /** Durable head of the active message lineage. Null means an empty conversation. */
  activeMessageId: text('active_message_id'),
  /** Provider-owned transcript generation. Kept separate from context compaction. */
  providerConversationRevision: integer('provider_conversation_revision').default(0),
  workingDirectory: text('working_directory'), // project folder this chat is scoped to
  metadata: text('metadata'), // JSON string
  tags: text('tags'), // JSON string
  version: integer('version').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Durable, authoritative lifecycle projection for one session.
 *
 * `sessions.workflow_state` remains a compatibility projection while callers
 * migrate. It is not allowed to decide whether a run is alive.
 */
export const sessionRuns = sqliteTable('session_runs', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  revision: integer('revision').notNull().default(0),
  phase: text('phase').notNull().default('idle'),
  status: text('status').notNull().default('idle'),
  waitingReason: text('waiting_reason').notNull().default(''),
  continuationId: text('continuation_id'),
  activeAgentIds: text('active_agent_ids').notNull().default('[]'),
  startedAt: integer('started_at'),
  updatedAt: integer('updated_at').notNull(),
  finishedAt: integer('finished_at'),
  terminalReason: text('terminal_reason'),
});

/**
 * Idempotency and recovery authority for source-owned manager turns. Message
 * rows are payload, not command receipts: this ledger survives partial writes
 * and binds one producer command to one immutable input and run generation.
 */
export const sessionTurnCommands = sqliteTable(
  'session_turn_commands',
  {
    commandKey: text('command_key').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['goal', 'collaboration', 'internal'] }).notNull(),
    sourceCommandId: text('source_command_id').notNull(),
    inputHash: text('input_hash').notNull(),
    userMessageId: text('user_message_id').notNull(),
    responseMessageId: text('response_message_id').notNull(),
    runId: text('run_id').notNull(),
    status: text('status', {
      enum: ['active', 'completed', 'failed', 'cancelled', 'waiting'],
    }).notNull(),
    terminalReason: text('terminal_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (table) => [
    unique('uq_session_turn_commands_source').on(
      table.sessionId,
      table.source,
      table.sourceCommandId,
    ),
    unique('uq_session_turn_commands_user_message').on(table.userMessageId),
    unique('uq_session_turn_commands_response_message').on(table.responseMessageId),
    unique('uq_session_turn_commands_run').on(table.runId),
    index('idx_session_turn_commands_session_status').on(
      table.sessionId,
      table.status,
      table.updatedAt,
    ),
    check(
      'ck_session_turn_commands_source',
      sql`${table.source} IN ('goal', 'collaboration', 'internal')`,
    ),
    check(
      'ck_session_turn_commands_status',
      sql`${table.status} IN ('active', 'completed', 'failed', 'cancelled', 'waiting')`,
    ),
    check(
      'ck_session_turn_commands_key',
      sql`length(${table.commandKey}) = 40 AND ${table.commandKey} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'ck_session_turn_commands_source_id',
      sql`length(${table.sourceCommandId}) BETWEEN 1 AND 512`,
    ),
    check(
      'ck_session_turn_commands_input_hash',
      sql`length(${table.inputHash}) = 64 AND ${table.inputHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      'ck_session_turn_commands_user_message',
      sql`${table.userMessageId} = 'command-user-' || ${table.commandKey}`,
    ),
    check(
      'ck_session_turn_commands_response_message',
      sql`${table.responseMessageId} = 'command-response-' || ${table.commandKey}`,
    ),
    check('ck_session_turn_commands_run_id', sql`length(${table.runId}) BETWEEN 1 AND 128`),
    check(
      'ck_session_turn_commands_timestamps',
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND (${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.createdAt})`,
    ),
    check(
      'ck_session_turn_commands_terminal',
      sql`((${table.status} IN ('active', 'waiting') AND ${table.terminalReason} IS NULL AND ${table.finishedAt} IS NULL) OR (${table.status} IN ('completed', 'failed', 'cancelled') AND ${table.terminalReason} IS NOT NULL AND length(trim(${table.terminalReason})) BETWEEN 1 AND 2048 AND ${table.finishedAt} IS NOT NULL))`,
    ),
  ],
);

/** Transactional outbox for session-run transitions. */
export const sessionRunEvents = sqliteTable(
  'session_run_events',
  {
    eventId: text('event_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    revision: integer('revision').notNull(),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
    publishedAt: integer('published_at'),
    deadLetterReason: text('dead_letter_reason'),
  },
  (table) => [unique('uq_session_run_event_revision').on(table.sessionId, table.revision)],
);

/** Durable ownership record for the external fact that may resume a wait. */
export const sessionRunContinuations = sqliteTable(
  'session_run_continuations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    waitRevision: integer('wait_revision').notNull(),
    kind: text('kind', { enum: ['user_question', 'process_set'] }).notNull(),
    state: text('state', {
      enum: ['pending', 'ready', 'claimed', 'consumed', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    unique('uq_session_run_continuation_wait').on(table.sessionId, table.runId, table.waitRevision),
  ],
);

/**
 * Durable command emitted when an answered question cannot resume its original
 * in-memory provider stack. Delivery is leased independently from SessionRun:
 * claiming this row does not imply that a replacement turn has started.
 */
export const sessionRunHandoffs = sqliteTable(
  'session_run_handoffs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['resume_answered_question'] }).notNull(),
    sourceRunId: text('source_run_id').notNull(),
    sourceRunRevision: integer('source_run_revision').notNull(),
    questionId: text('question_id').notNull(),
    questionPayload: text('question_payload').notNull(),
    answer: text('answer').notNull(),
    state: text('state', { enum: ['pending', 'claimed', 'consumed'] })
      .notNull()
      .default('pending'),
    claimToken: text('claim_token'),
    claimedBy: text('claimed_by'),
    claimedAt: integer('claimed_at'),
    leaseExpiresAt: integer('lease_expires_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    consumedAt: integer('consumed_at'),
  },
  (table) => [
    unique('uq_session_run_handoff_question').on(table.questionId),
    index('idx_session_run_handoffs_claimable').on(
      table.state,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    index('idx_session_run_handoffs_session').on(table.sessionId, table.createdAt),
  ],
);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(), // JSON string of ContentBlock[]
  model: text('model'),
  provider: text('provider'),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  cost: real('cost').default(0),
  variantGroupId: text('variant_group_id'),
  variantIndex: integer('variant_index').default(0),
  contextRevision: integer('context_revision').notNull().default(0),
  /** Previous message in this retained conversation branch. */
  parentMessageId: text('parent_message_id'),
  // Feed reconciliation may compare a persisted final answer with live
  // reasoning events from the same second. Preserve the actual write instant;
  // causal event anchors remain authoritative, but second precision cannot be
  // allowed to manufacture an inverted fallback order.
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Client-originated errors that were deliberately placed in a chat transcript.
 * This is intentionally narrower than telemetry or toast storage: only the
 * explicit `addClientError()` feed action is written here.
 */
export const sessionFeedEntries = sqliteTable(
  'session_feed_entries',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['client_error'] }).notNull(),
    text: text('text').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('idx_session_feed_entries_session').on(table.sessionId, table.timestamp)],
);

/**
 * A view-only tombstone is separate from the source transcript. Ordered
 * events cannot be deleted from the immutable event log, so the target key
 * names the exact replay identity (for example `event:3:18:24`). Messages
 * still use their normal destructive route; these rows cover Hide-from-me and
 * non-message feed evidence.
 */
export const sessionFeedTombstones = sqliteTable(
  'session_feed_tombstones',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    targetKey: text('target_key').notNull(),
    visibility: text('visibility', { enum: ['hidden', 'deleted'] }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.targetKey] }),
    index('idx_session_feed_tombstones_session').on(table.sessionId, table.updatedAt),
  ],
);

export const sessionCompactions = sqliteTable('session_compactions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  sourceRevision: integer('source_revision').notNull(),
  targetRevision: integer('target_revision').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  automatic: integer('automatic', { mode: 'boolean' }).notNull().default(false),
  sourceMessageCount: integer('source_message_count').notNull(),
  sourceTokens: integer('source_tokens').notNull().default(0),
  checkpointTokens: integer('checkpoint_tokens').notNull().default(0),
  summaryHash: text('summary_hash').notNull(),
  summary: text('summary').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  domain: text('domain'),
  status: text('status', { enum: ['pending', 'active', 'done', 'failed'] }).default('pending'),
  plan: text('plan'),
  assignedModel: text('assigned_model'),
  assignedProvider: text('assigned_provider'),
  allowedPaths: text('allowed_paths'), // JSON string of string[]
  result: text('result'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  objective: text('objective').notNull(),
  scope: text('scope').notNull(),
  projectPath: text('project_path'),
  sessionId: text('session_id'),
  priority: integer('priority').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status').notNull().default('queued'),
  checklist: text('checklist').notNull().default('[]'),
  linkedSessionIds: text('linked_session_ids').notNull().default('[]'),
  activity: text('activity').notNull().default('[]'),
  blocker: text('blocker'),
  execution: text('execution'),
  activeDurationMs: integer('active_duration_ms').notNull().default(0),
  activeStartedAt: integer('active_started_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// Auth & Security Tables
// ============================================================================

export const refreshTokens = sqliteTable('refresh_tokens', {
  token: text('token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revoked: integer('revoked').default(0),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hashedKey: text('hashed_key').notNull(),
  scopes: text('scopes').notNull(), // Comma-separated or JSON string
  rateLimitTier: text('rate_limit_tier').default('free'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  usageCount: integer('usage_count').default(0),
  isActive: integer('is_active').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  metadata: text('metadata'), // JSON string
});

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  success: integer('success').notNull(),
  reason: text('reason'),
  metadata: text('metadata'), // JSON string
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
});

export const auditLogArchive = sqliteTable('audit_log_archive', {
  id: integer('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  success: integer('success').notNull(),
  reason: text('reason'),
  metadata: text('metadata'),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
});

export const userCredentials = sqliteTable('user_credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  encryptedCredential: text('encrypted_credential').notNull(),
  type: text('type', { enum: ['apiKey', 'authToken', 'baseUrl'] }).notNull(),
  isActive: integer('is_active').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  metadata: text('metadata'),
});

export const credentialAuditLog = sqliteTable('credential_audit_log', {
  id: text('id').primaryKey(),
  credentialId: text('credential_id').notNull(),
  userId: text('user_id').notNull(),
  action: text('action', {
    enum: ['created', 'accessed', 'rotated', 'revoked', 'deleted'],
  }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  success: integer('success').notNull(),
  error: text('error'),
});

export const providerCredentials = sqliteTable(
  'provider_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    providerName: text('provider_name').notNull(),
    credentialType: text('credential_type').notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    encryptionVersion: text('encryption_version').default('v1').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    isValid: integer('is_valid').default(1),
    lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp' }),
  },
  (t) => ({
    unq: unique().on(t.userId, t.providerName, t.credentialType),
  }),
);

export const authSessions = sqliteTable('sessions_auth', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  userName: text('user_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
});

// ============================================================================
// Worker & State Tables
// ============================================================================

export const activeWorkers = sqliteTable('active_workers', {
  taskId: text('task_id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  taskData: text('task_data').notNull(), // JSON string
  startTime: integer('start_time', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull().default('running'),
});

export const abortControllers = sqliteTable('abort_controllers', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  reason: text('reason'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const userInputs = sqliteTable('user_inputs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  inputData: text('input_data').notNull(), // JSON string
  runId: text('run_id'),
  runRevision: integer('run_revision'),
  status: text('status', { enum: ['pending', 'answered', 'cancelled'] }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const sessionChanges = sqliteTable('session_changes', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  changeType: text('change_type').notNull(),
  changeData: text('change_data').notNull(), // JSON string
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const sessionTags = sqliteTable(
  'session_tags',
  {
    sessionId: text('session_id').notNull(),
    tag: text('tag').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.tag] }),
  }),
);

// ============================================================================
// Collaboration Tables
// ============================================================================

export const collaborationSessions = sqliteTable('collaboration_sessions', {
  id: text('id').primaryKey(),
  baseSessionId: text('base_session_id').notNull(),
  ownerId: text('owner_id').notNull(),
  status: text('status', { enum: ['active', 'paused', 'ended'] }).default('active'),
  joinCode: text('join_code').notNull().unique(),
  tunnelUrl: text('tunnel_url'),
  aiState: text('ai_state'), // JSON string
  contextSnapshot: text('context_snapshot'), // JSON string
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
});

export const sessionParticipants = sqliteTable('session_participants', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['viewer', 'contributor', 'owner'] }).default('viewer'),
  cursorFile: text('cursor_file'),
  cursorLine: integer('cursor_line'),
  lastActive: integer('last_active', { mode: 'timestamp' }).notNull(),
});

export const persistentSessions = sqliteTable('persistent_sessions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastActivity: integer('last_activity', { mode: 'timestamp' }).notNull(),
  context: text('context').notNull(), // JSON string
  history: text('history').notNull(), // JSON string
  ghostCommits: text('ghost_commits').notNull(), // JSON string
  metadata: text('metadata').notNull(), // JSON string
});

export const sessionUsage = sqliteTable('session_usage', {
  sessionId: text('session_id').primaryKey(),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  totalCostCents: integer('total_cost_cents').default(0),
  commandCount: integer('command_count').default(0),
  startTime: integer('start_time', { mode: 'timestamp' }).notNull(),
  lastActivity: integer('last_activity', { mode: 'timestamp' }).notNull(),
});

export const spendCapPauses = sqliteTable('spend_cap_pauses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  pausedAt: integer('paused_at', { mode: 'timestamp' }).notNull(),
  resumedAt: integer('resumed_at', { mode: 'timestamp' }),
  reason: text('reason').notNull(),
  capType: text('cap_type').notNull(),
  currentSpendCents: integer('current_spend_cents').notNull(),
  limitCents: integer('limit_cents').notNull(),
  manuallyResumed: integer('manually_resumed').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch() * 1000)`),
});

export const spendCapConfig = sqliteTable('spend_cap_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch() * 1000)`),
});

// ============================================================================
// Replay Events
// ============================================================================

export const replayEvents = sqliteTable(
  'replay_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(), // JSON string
    parentEventId: text('parent_event_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    unq: unique().on(t.sessionId, t.sequence),
  }),
);

// ============================================================================
// Process Supervisor Tables
// ============================================================================

export const supervisedProcesses = sqliteTable('supervised_processes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  command: text('command').notNull(),
  commandReplayable: integer('command_replayable').notNull().default(0),
  cwd: text('cwd').notNull(),
  pid: integer('pid').notNull(),
  sessionId: text('session_id').notNull(),
  status: text('status').notNull().default('starting'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  restartCount: integer('restart_count').default(0),
  lastRestartAt: integer('last_restart_at', { mode: 'timestamp' }),
  maxRestarts: integer('max_restarts').default(3),
  restartPolicy: text('restart_policy').default('on-failure'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  provenance: text('provenance').notNull().default('legacy-unknown'),
  supervision: text('supervision').notNull().default('legacy-unknown'),
  isBackground: integer('is_background').notNull().default(0),
  terminalReason: text('terminal_reason'),
  terminalError: text('terminal_error'),
  stdoutSnapshot: text('stdout_snapshot'),
  stderrSnapshot: text('stderr_snapshot'),
  metadata: text('metadata'), // JSON string
});

/**
 * Relational ownership for process-backed continuations. The JSON payload on
 * the continuation remains a compatibility projection; these rows are the
 * authoritative identities protected from process-history cleanup.
 */
export const sessionRunContinuationProcesses = sqliteTable(
  'session_run_continuation_processes',
  {
    continuationId: text('continuation_id')
      .notNull()
      .references(() => sessionRunContinuations.id, { onDelete: 'cascade' }),
    processId: text('process_id')
      .notNull()
      .references(() => supervisedProcesses.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.continuationId, table.processId] }),
    index('idx_session_run_continuation_processes_process').on(
      table.processId,
      table.continuationId,
    ),
  ],
);

export const processEvents = sqliteTable('process_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  processId: text('process_id').notNull(),
  eventType: text('event_type').notNull(),
  eventData: text('event_data'), // JSON string
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
});

export const processHealthChecks = sqliteTable('process_health_checks', {
  processId: text('process_id').primaryKey(),
  lastHeartbeat: integer('last_heartbeat', { mode: 'timestamp' }),
  checkCount: integer('check_count').default(0),
  failureCount: integer('failure_count').default(0),
  consecutiveFailures: integer('consecutive_failures').default(0),
  isHealthy: integer('is_healthy').default(1),
  lastError: text('last_error'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/**
 * Desktop navigation is durable backend state, not a browser cache.  The
 * selected paths are revalidated against the filesystem whenever they are
 * read; workspace children are never persisted here.
 */
export const workspaceNavigation = sqliteTable('workspace_navigation', {
  id: text('id').primaryKey(),
  workspaceRoot: text('workspace_root'),
  selectedProject: text('selected_project'),
  unavailableWorkspace: text('unavailable_workspace'),
  unavailableProject: text('unavailable_project'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const modelSettings = sqliteTable(
  'model_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    modelId: text('model_id').notNull(),
    provider: text('provider').notNull(),
    isChecked: integer('is_checked').default(1),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => ({
    unq: unique().on(t.userId, t.modelId),
  }),
);

export const routingAuditLog = sqliteTable('routing_audit_log', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  sessionId: text('session_id'),
  intent: text('intent').notNull(),
  selectedModelId: text('selected_model_id'),
  checkedModelsJson: text('checked_models_json'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

export const activeJwtTokens = sqliteTable('active_jwt_tokens', {
  jti: text('jti').primaryKey(),
  userId: text('user_id').notNull(),
  issuedAt: integer('issued_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  revoked: integer('revoked').default(0),
});

export const providerKeyInvalid = sqliteTable('provider_key_invalid', {
  provider: text('provider').primaryKey(),
  invalidSince: integer('invalid_since', { mode: 'timestamp' }).notNull(),
  lastError: text('last_error'),
});

export const providerEndpointOverride = sqliteTable('provider_endpoint_override', {
  provider: text('provider').primaryKey(),
  baseUrl: text('base_url').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// ============================================================================
// Notes — Obsidian-style note network
// ============================================================================

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  folderPath: text('folder_path').notNull().default('/'),
  tags: text('tags').notNull().default('[]'), // JSON string array
  pinned: integer('pinned').notNull().default(0), // boolean 0/1
  includeInContext: integer('include_in_context').notNull().default(0), // auto-inject into agent context
  format: text('format').notNull().default('markdown'), // 'markdown' | 'html' — html renders in the sandboxed preview
  projectRoot: text('project_root'), // null means a legacy note owned by the launch project
  revision: integer('revision').notNull().default(1),
  /** Soft-deleted notes stay recoverable with their links and attachments. */
  trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
  trashReason: text('trash_reason', { enum: ['user', 'source_removed'] }),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

/** Immutable full-state snapshots. The current row remains the fast read model;
 * this table is the recovery/history source of truth. */
export const noteRevisions = sqliteTable(
  'note_revisions',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    projectRoot: text('project_root').notNull(),
    operation: text('operation').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    contentBytes: integer('content_bytes').notNull(),
    folderPath: text('folder_path').notNull(),
    tags: text('tags').notNull(),
    pinned: integer('pinned').notNull(),
    includeInContext: integer('include_in_context').notNull(),
    format: text('format').notNull(),
    sourcePath: text('source_path'),
    trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
    trashReason: text('trash_reason'),
    noteCreatedAt: integer('note_created_at', { mode: 'timestamp' }).notNull(),
    noteUpdatedAt: integer('note_updated_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.revision] })],
);

// Wiki-link graph edges
export const noteLinks = sqliteTable(
  'note_links',
  {
    fromNoteId: text('from_note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    toNoteId: text('to_note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromNoteId, t.toNoteId] }),
  }),
);

// File attachments for notes
export const noteAttachments = sqliteTable('note_attachments', {
  id: text('id').primaryKey(),
  noteId: text('note_id')
    .notNull()
    .references(() => notes.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storagePath: text('storage_path').notNull(), // absolute path on disk
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/** Stable installation-scoped identity for private Notes recovery data. The
 * bearer token is intentionally not used: local auth sessions rotate across
 * backend restarts, while the owner-only SQLite file is durable. */
export const noteDraftPrincipals = sqliteTable('note_draft_principals', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['local'] })
    .notNull()
    .unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Non-authoritative, crash-durable editor branches. A draft deliberately has
 * no FK to notes: deletion or a path-derived project-note rename must never
 * cascade away the last unsaved copy. */
export const noteDrafts = sqliteTable(
  'note_drafts',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => noteDraftPrincipals.id, { onDelete: 'restrict' }),
    projectRoot: text('project_root').notNull(),
    noteId: text('note_id').notNull(),
    baseRevision: integer('base_revision').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    baseTitle: text('base_title').notNull(),
    sourcePathAtBase: text('source_path_at_base'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    contentBytes: integer('content_bytes').notNull(),
    folderPath: text('folder_path').notNull(),
    tags: text('tags').notNull(),
    pinned: integer('pinned').notNull(),
    includeInContext: integer('include_in_context').notNull(),
    format: text('format', { enum: ['markdown', 'html'] }).notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_note_drafts_scope_updated').on(
      table.principalId,
      table.projectRoot,
      table.updatedAt,
    ),
    index('idx_note_drafts_scope_note').on(
      table.principalId,
      table.projectRoot,
      table.noteId,
      table.updatedAt,
    ),
  ],
);

/** One projection-health row per note. Base queries compare projectedRevision
 * with notes.revision and repair or fail closed rather than silently omitting
 * stale property values. */
export const notePropertyDocuments = sqliteTable(
  'note_property_documents',
  {
    noteId: text('note_id')
      .primaryKey()
      .references(() => notes.id, { onDelete: 'cascade' }),
    projectRoot: text('project_root').notNull(),
    projectedRevision: integer('projected_revision').notNull(),
    frontmatterHash: text('frontmatter_hash').notNull(),
    status: text('status', { enum: ['valid', 'invalid', 'unsupported'] }).notNull(),
    issuesJson: text('issues_json').notNull().default('[]'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('idx_note_property_documents_scope_revision').on(
      table.projectRoot,
      table.projectedRevision,
    ),
  ],
);

/** Query projection of supported frontmatter properties. Source Markdown is
 * authoritative; this table is rebuilt from note content and exists only so
 * Bases can stay complete and indexed for large vaults. */
export const noteProperties = sqliteTable(
  'note_properties',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    projectRoot: text('project_root').notNull(),
    key: text('key').notNull(),
    normalizedKey: text('normalized_key').notNull(),
    type: text('type', {
      enum: ['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags'],
    }).notNull(),
    valueJson: text('value_json').notNull(),
    valueText: text('value_text'),
    valueNumber: real('value_number'),
    valueBoolean: integer('value_boolean'),
    noteRevision: integer('note_revision').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.normalizedKey] }),
    index('idx_note_properties_scope_key_text').on(
      table.projectRoot,
      table.normalizedKey,
      table.valueText,
    ),
    index('idx_note_properties_scope_key_number').on(
      table.projectRoot,
      table.normalizedKey,
      table.valueNumber,
    ),
    index('idx_note_properties_scope_key_boolean').on(
      table.projectRoot,
      table.normalizedKey,
      table.valueBoolean,
    ),
  ],
);

/** Individually indexed list values for contains predicates. */
export const notePropertyItems = sqliteTable(
  'note_property_items',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    normalizedKey: text('normalized_key').notNull(),
    ordinal: integer('ordinal').notNull(),
    projectRoot: text('project_root').notNull(),
    valueText: text('value_text').notNull(),
    normalizedText: text('normalized_text').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.noteId, table.normalizedKey, table.ordinal] }),
    index('idx_note_property_items_scope_key_value').on(
      table.projectRoot,
      table.normalizedKey,
      table.normalizedText,
    ),
  ],
);

/** Project-wide typed property registry inferred from indexed Markdown. */
export const notePropertySchemas = sqliteTable(
  'note_property_schemas',
  {
    projectRoot: text('project_root').notNull(),
    normalizedKey: text('normalized_key').notNull(),
    displayName: text('display_name').notNull(),
    kind: text('kind', {
      enum: ['text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags'],
    }).notNull(),
    revision: integer('revision').notNull().default(1),
    usageCount: integer('usage_count').notNull().default(0),
    invalidCount: integer('invalid_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectRoot, table.normalizedKey] })],
);

/** Persistent project-scoped typed query definitions. */
export const noteBases = sqliteTable(
  'note_bases',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => noteDraftPrincipals.id, { onDelete: 'restrict' }),
    projectRoot: text('project_root').notNull(),
    name: text('name').notNull(),
    definition: text('definition').notNull(),
    revision: integer('revision').notNull().default(1),
    trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    unique('uq_note_bases_scope_name').on(table.principalId, table.projectRoot, table.name),
    index('idx_note_bases_scope_updated').on(table.principalId, table.projectRoot, table.updatedAt),
  ],
);

export const noteBaseRevisions = sqliteTable(
  'note_base_revisions',
  {
    baseId: text('base_id')
      .notNull()
      .references(() => noteBases.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    projectRoot: text('project_root').notNull(),
    operation: text('operation', { enum: ['create', 'update', 'trash', 'restore'] }).notNull(),
    name: text('name').notNull(),
    definition: text('definition').notNull(),
    trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
    baseCreatedAt: integer('base_created_at', { mode: 'timestamp_ms' }).notNull(),
    baseUpdatedAt: integer('base_updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.baseId, table.revision] }),
    index('idx_note_base_revisions_scope').on(table.projectRoot, table.baseId, table.revision),
  ],
);

/** Durable commit witness for whole-vault restores. Project-local recovery
 * journals use this row to distinguish a SQLite commit from files left behind
 * by a process crash while the transaction was still open. */
export const noteVaultRestoreCommits = sqliteTable(
  'note_vault_restore_commits',
  {
    archiveSha256: text('archive_sha256').notNull(),
    projectRoot: text('project_root').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    planToken: text('plan_token').notNull(),
    committedAt: integer('committed_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.archiveSha256, table.projectRoot] }),
    index('idx_note_vault_restore_commits_project').on(table.projectRoot, table.committedAt),
  ],
);

// ============================================================================
// Type Exports
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type NewProviderCredential = typeof providerCredentials.$inferInsert;

export type CollaborationSession = typeof collaborationSessions.$inferSelect;
export type NewCollaborationSession = typeof collaborationSessions.$inferInsert;

export type SessionParticipant = typeof sessionParticipants.$inferSelect;
export type NewSessionParticipant = typeof sessionParticipants.$inferInsert;

export type ReplayEvent = typeof replayEvents.$inferSelect;
export type NewReplayEvent = typeof replayEvents.$inferInsert;
export type StoredNoteRevision = typeof noteRevisions.$inferSelect;
export type NewStoredNoteRevision = typeof noteRevisions.$inferInsert;
