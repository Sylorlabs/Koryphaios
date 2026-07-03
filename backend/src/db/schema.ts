/**
 * Database Schema
 * SQLite-only schema for Koryphaios desktop mode
 */

import { sqliteTable, text, integer, real, primaryKey, unique } from 'drizzle-orm/sqlite-core';
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
  parentId: text('parent_id'),
  messageCount: integer('message_count').default(0),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  totalCost: real('total_cost').default(0),
  workflowState: text('workflow_state').default('idle'),
  workingDirectory: text('working_directory'), // project folder this chat is scoped to
  metadata: text('metadata'), // JSON string
  tags: text('tags'), // JSON string
  version: integer('version').default(1),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(), // JSON string of ContentBlock[]
  model: text('model'),
  provider: text('provider'),
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  cost: real('cost').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
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

// ============================================================================
// Auth & Security Tables
// ============================================================================

export const refreshTokens = sqliteTable('refresh_tokens', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  revoked: integer('revoked').default(0),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
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
  metadata: text('metadata'), // JSON string
});

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
  tags: text('tags').notNull().default('[]'),           // JSON string array
  pinned: integer('pinned').notNull().default(0),       // boolean 0/1
  includeInContext: integer('include_in_context').notNull().default(0), // auto-inject into agent context
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Wiki-link graph edges
export const noteLinks = sqliteTable('note_links', {
  fromNoteId: text('from_note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  toNoteId: text('to_note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.fromNoteId, t.toNoteId] }),
}));

// File attachments for notes
export const noteAttachments = sqliteTable('note_attachments', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storagePath: text('storage_path').notNull(),          // absolute path on disk
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

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
