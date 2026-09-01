// Database Migrations — versioned schema changes with rollback support
// Prevents data loss on schema changes and tracks migration history

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { serverLog } from '../logger';

export interface Migration {
  /** Unique version number (e.g., 20240101_001) */
  version: string;
  /** Human-readable description */
  description: string;
  /** SQL to apply the migration */
  up: string;
  /** SQL to rollback the migration (optional) */
  down?: string;
}

export interface MigrationRecord {
  version: string;
  description: string;
  appliedAt: number;
  checksum: string;
}

// ─── Migration Registry ──────────────────────────────────────────────────────

/**
 * All database migrations in order.
 * Each migration has a unique version number and must be idempotent where possible.
 */
export const MIGRATIONS: Migration[] = [
  // ─── Version 001: Initial Schema ───────────────────────────────────────────
  {
    version: '20240101_001',
    description: 'Initial schema with users, sessions, messages, tasks',
    up: `
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        parent_id TEXT,
        message_count INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        workflow_state TEXT DEFAULT 'idle',
        created_at INTEGER,
        updated_at INTEGER
      );

      -- Messages table
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost REAL,
        created_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        description TEXT NOT NULL,
        domain TEXT,
        status TEXT DEFAULT 'pending',
        plan TEXT,
        assigned_model TEXT,
        allowed_paths TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_updated;
      DROP INDEX IF EXISTS idx_messages_session;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS users;
    `,
  },

  // ─── Version 002: Worker Persistence ───────────────────────────────────────
  {
    version: '20240115_001',
    description: 'Add worker persistence tables',
    up: `
      -- Active workers table for persistence
      CREATE TABLE IF NOT EXISTS active_workers (
        session_id TEXT NOT NULL,
        task_id TEXT PRIMARY KEY,
        task_data TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Abort controllers table for persistence
      CREATE TABLE IF NOT EXISTS abort_controllers (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- User inputs table for persistence
      CREATE TABLE IF NOT EXISTS user_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        input_data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      -- Session changes log for tracking modifications
      CREATE TABLE IF NOT EXISTS session_changes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        change_type TEXT NOT NULL,
        change_data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_active_workers_session ON active_workers(session_id);
      CREATE INDEX IF NOT EXISTS idx_abort_controllers_session ON abort_controllers(session_id);
      CREATE INDEX IF NOT EXISTS idx_user_inputs_session ON user_inputs(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_changes_session ON session_changes(session_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_changes_session;
      DROP INDEX IF EXISTS idx_user_inputs_session;
      DROP INDEX IF EXISTS idx_abort_controllers_session;
      DROP INDEX IF EXISTS idx_active_workers_session;
      DROP TABLE IF EXISTS session_changes;
      DROP TABLE IF EXISTS user_inputs;
      DROP TABLE IF EXISTS abort_controllers;
      DROP TABLE IF EXISTS active_workers;
    `,
  },

  // ─── Version 003: Auth Tables ──────────────────────────────────────────────
  {
    version: '20240201_001',
    description: 'Add authentication and API key tables',
    up: `
      -- Refresh tokens table (for JWT refresh token persistence)
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked INTEGER DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- API keys table (for programmatic access)
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        hashed_key TEXT NOT NULL,
        scopes TEXT NOT NULL,
        rate_limit_tier TEXT DEFAULT 'free',
        expires_at INTEGER,
        last_used_at INTEGER,
        usage_count INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Audit logs table
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER,
        reason TEXT,
        metadata TEXT,
        timestamp INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    `,
    down: `
      DROP INDEX IF EXISTS idx_audit_action;
      DROP INDEX IF EXISTS idx_audit_user;
      DROP INDEX IF EXISTS idx_api_keys_user;
      DROP INDEX IF EXISTS idx_api_keys_prefix;
      DROP INDEX IF EXISTS idx_refresh_tokens_user;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS api_keys;
      DROP TABLE IF EXISTS refresh_tokens;
    `,
  },

  // ─── Version 004: Add user_id to sessions ───────────────────────────────────
  {
    version: '20240215_001',
    description: 'Add user_id column to sessions table for multi-user support',
    up: `
      -- Add user_id column if it doesn't exist
      -- SQLite doesn't support IF NOT EXISTS for columns, so we handle it by checking if it already exists
      -- Use a temporary table approach or just rely on the application handling the error if we want simplicity
      -- But for robustness, we use this:
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      
      -- Create a temp table that DEFINITELY has user_id
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        parent_id TEXT,
        message_count INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        workflow_state TEXT DEFAULT 'idle',
        metadata TEXT,
        tags TEXT,
        version INTEGER DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER
      );

      -- Copy data from old to new, mapping columns correctly
      -- If user_id exists in old sessions, it will be copied.
      -- If not, it will be NULL in sessions_new.
      INSERT INTO sessions_new (id, user_id, title, parent_id, message_count, tokens_in, tokens_out, total_cost, workflow_state, created_at, updated_at)
      SELECT id, 
             CASE WHEN (SELECT count(*) FROM pragma_table_info('sessions') WHERE name='user_id') > 0 
                  THEN user_id ELSE NULL END,
             title, parent_id, message_count, tokens_in, tokens_out, total_cost, workflow_state, created_at, updated_at
      FROM sessions;

      -- Drop old table and rename new one
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      COMMIT;
      PRAGMA foreign_keys=ON;
    `,
    down: `
      -- SQLite doesn't support DROP COLUMN, so we recreate the table
      -- This is a no-op for safety
    `,
  },

  // ─── Version 005: Provider credentials ──────────────────────────────────────
  {
    version: '20240301_001',
    description: 'Add provider credentials storage table',
    up: `
      -- Provider credentials table (encrypted API keys)
      CREATE TABLE IF NOT EXISTS provider_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        encryption_version TEXT NOT NULL DEFAULT 'v1',
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        expires_at INTEGER,
        is_valid INTEGER DEFAULT 1,
        last_verified_at INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, provider_name, credential_type)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_credentials_user ON provider_credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider ON provider_credentials(provider_name);
    `,
    down: `
      DROP INDEX IF EXISTS idx_provider_credentials_provider;
      DROP INDEX IF EXISTS idx_provider_credentials_user;
      DROP TABLE IF EXISTS provider_credentials;
    `,
  },

  // ─── Version 006: Session metadata ──────────────────────────────────────────
  {
    version: '20240315_001',
    description: 'Add metadata and tags to sessions',
    up: `
      -- Add metadata column to sessions if it doesn't exist
      -- Use a safe check for column existence
      PRAGMA foreign_keys=OFF;
      
      -- Check for metadata column
      -- Note: SQLite ALTER TABLE ADD COLUMN will fail if it already exists
      -- We can use this trick: check if column count increases or handle gracefully
      -- Since we already potentially added it in the previous migration's table recreate,
      -- we should only add if it's REALLY missing.
      
      -- Helper: Only add if missing
      -- Actually, easier is to use the same recreate approach if we want to be 100% sure
      -- But let's try a simpler approach if we can, or just keep it robust.
      
      -- For Koryphaios, we'll use a safer approach for this migration too:
      BEGIN TRANSACTION;
      CREATE TABLE IF NOT EXISTS sessions_meta_check (id TEXT);
      
      -- This script is getting complex for a migration. 
      -- Simpler: check if column exists, if not, ALTER. 
      -- Since SQLite doesn't have IF in SQL, we'll just use a similar recreate or 
      -- skip if already present.
      
      -- Let's use the recreate approach to be consistent and safe.
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT NOT NULL,
        parent_id TEXT,
        message_count INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        workflow_state TEXT DEFAULT 'idle',
        metadata TEXT,
        tags TEXT,
        version INTEGER DEFAULT 1,
        created_at INTEGER,
        updated_at INTEGER
      );

      INSERT INTO sessions_new (id, user_id, title, parent_id, message_count, tokens_in, tokens_out, total_cost, workflow_state, metadata, tags, version, created_at, updated_at)
      SELECT id, user_id, title, parent_id, message_count, tokens_in, tokens_out, total_cost, workflow_state,
             CASE WHEN (SELECT count(*) FROM pragma_table_info('sessions') WHERE name='metadata') > 0 THEN metadata ELSE NULL END,
             CASE WHEN (SELECT count(*) FROM pragma_table_info('sessions') WHERE name='tags') > 0 THEN tags ELSE NULL END,
             CASE WHEN (SELECT count(*) FROM pragma_table_info('sessions') WHERE name='version') > 0 THEN version ELSE 1 END,
             created_at, updated_at
      FROM sessions;

      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

      -- Session tags table for querying
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, tag),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      COMMIT;
      PRAGMA foreign_keys=ON;

      CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_tags_tag;
      DROP TABLE IF EXISTS session_tags;
    `,
  },

  // ─── Version 007: Message Replay Buffer ────────────────────────────────────
  {
    version: '20240328_001',
    description: 'Add replay events table for message replay buffer',
    up: `
      -- Events table for replay buffer
      CREATE TABLE IF NOT EXISTS replay_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        parent_event_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, sequence)
      );

      -- Index for fast session queries
      CREATE INDEX IF NOT EXISTS idx_replay_events_session ON replay_events(session_id, sequence);

      -- Index for event type queries
      CREATE INDEX IF NOT EXISTS idx_replay_events_type ON replay_events(type);

      -- Index for parent event lookups (for forks)
      CREATE INDEX IF NOT EXISTS idx_replay_events_parent ON replay_events(parent_event_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_replay_events_parent;
      DROP INDEX IF EXISTS idx_replay_events_type;
      DROP INDEX IF EXISTS idx_replay_events_session;
      DROP TABLE IF EXISTS replay_events;
    `,
  },

  // ─── Version 008: Enable Foreign Key Enforcement ───────────────────────────
  {
    version: '20240401_001',
    description: 'Enable SQLite foreign key enforcement and add missing FK constraints',
    up: `
      -- Enable foreign key enforcement (must be done per-connection in SQLite)
      PRAGMA foreign_keys = ON;

      -- Recreate replay_events with FK to sessions
      CREATE TABLE IF NOT EXISTS replay_events_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        parent_event_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, sequence),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO replay_events_new
        SELECT * FROM replay_events;

      DROP TABLE IF EXISTS replay_events;
      ALTER TABLE replay_events_new RENAME TO replay_events;

      CREATE INDEX IF NOT EXISTS idx_replay_events_session ON replay_events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_replay_events_type ON replay_events(type);
      CREATE INDEX IF NOT EXISTS idx_replay_events_parent ON replay_events(parent_event_id);
    `,
    down: `
      PRAGMA foreign_keys = OFF;
    `,
  },
  {
    version: '0009',
    description: 'Add collaboration_sessions and session_participants tables',
    up: `
      CREATE TABLE IF NOT EXISTS collaboration_sessions (
        id TEXT PRIMARY KEY,
        base_session_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        join_code TEXT NOT NULL UNIQUE,
        tunnel_url TEXT,
        ai_state TEXT,
        context_snapshot TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_collab_base_session ON collaboration_sessions(base_session_id);
      CREATE INDEX IF NOT EXISTS idx_collab_join_code ON collaboration_sessions(join_code);
      CREATE INDEX IF NOT EXISTS idx_collab_status ON collaboration_sessions(status);

      CREATE TABLE IF NOT EXISTS session_participants (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer',
        cursor_file TEXT,
        cursor_line INTEGER,
        last_active INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES collaboration_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_participants_session ON session_participants(session_id);
    `,
    down: `
      DROP TABLE IF EXISTS session_participants;
      DROP TABLE IF EXISTS collaboration_sessions;
    `,
  },

  // ─── Version 010: Notes network (Obsidian-style graph) ─────────────────────
  {
    version: '0010',
    description: 'Add notes, note_links, and note_attachments tables',
    up: `
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        folder_path TEXT NOT NULL DEFAULT '/',
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        include_in_context INTEGER NOT NULL DEFAULT 0,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS note_links (
        from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        PRIMARY KEY (from_note_id, to_note_id)
      );

      CREATE TABLE IF NOT EXISTS note_attachments (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
      CREATE INDEX IF NOT EXISTS idx_notes_folder_path ON notes(folder_path);
      CREATE INDEX IF NOT EXISTS idx_note_links_from ON note_links(from_note_id);
      CREATE INDEX IF NOT EXISTS idx_note_links_to ON note_links(to_note_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_note_links_to;
      DROP INDEX IF EXISTS idx_note_links_from;
      DROP INDEX IF EXISTS idx_notes_folder_path;
      DROP INDEX IF EXISTS idx_notes_user_id;
      DROP TABLE IF EXISTS note_attachments;
      DROP TABLE IF EXISTS note_links;
      DROP TABLE IF EXISTS notes;
    `,
  },

  // ─── Version 0011: Project-scoped sessions ──────────────────────────────────
  {
    version: '0011',
    description: 'Add working_directory to sessions (project-scoped chats)',
    up: `
      ALTER TABLE sessions ADD COLUMN working_directory TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_working_directory ON sessions(working_directory);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_working_directory;
    `,
  },

  // ─── Version 0012: HTML notes ───────────────────────────────────────────────
  {
    version: '0012',
    description: "Add format column to notes ('markdown' | 'html')",
    up: `
      ALTER TABLE notes ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown';
    `,
    down: ``,
  },
  {
    version: '0013',
    description: 'Persist regenerated response variants',
    up: `
      ALTER TABLE messages ADD COLUMN variant_group_id TEXT;
      ALTER TABLE messages ADD COLUMN variant_index INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_messages_variant_group ON messages(variant_group_id, variant_index);
    `,
    down: `DROP INDEX IF EXISTS idx_messages_variant_group;`,
  },

  // ─── Version 0014: Notes scale — FTS5 search + title index ───────────────────
  // Replaces the O(n) leading-wildcard LIKE search with an indexed, ranked
  // full-text index, kept in sync by triggers. Also indexes note titles so
  // wikilink resolution and rename propagation stop doing table scans.
  {
    version: '0014',
    description: 'Notes FTS5 full-text index + title index',
    up: `
      CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        content,
        tags,
        tokenize = 'porter unicode61'
      );

      -- Backfill existing rows.
      INSERT INTO notes_fts(note_id, title, content, tags)
        SELECT id, title, content, tags FROM notes;

      -- Keep the index in sync with the notes table.
      CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(note_id, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
        DELETE FROM notes_fts WHERE note_id = old.id;
        INSERT INTO notes_fts(note_id, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
      END;
    `,
    down: `
      DROP TRIGGER IF EXISTS notes_fts_au;
      DROP TRIGGER IF EXISTS notes_fts_ad;
      DROP TRIGGER IF EXISTS notes_fts_ai;
      DROP TABLE IF EXISTS notes_fts;
      DROP INDEX IF EXISTS idx_notes_title;
    `,
  },
  {
    version: '0015',
    description: 'Persist the assigned provider for worker tasks',
    up: `
      ALTER TABLE tasks ADD COLUMN assigned_provider TEXT;
    `,
    down: ``,
  },
  {
    version: '0016',
    description: 'Persist Goal Mode goals and verified checklists',
    up: `
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, user_id TEXT, objective TEXT NOT NULL, scope TEXT NOT NULL,
        project_path TEXT, session_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
        checklist TEXT NOT NULL DEFAULT '[]', linked_session_ids TEXT NOT NULL DEFAULT '[]',
        activity TEXT NOT NULL DEFAULT '[]', blocker TEXT, active_duration_ms INTEGER NOT NULL DEFAULT 0,
        active_started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_scope_status ON goals(scope, status, priority DESC, sort_order ASC);
    `,
    down: `DROP INDEX IF EXISTS idx_goals_scope_status; DROP TABLE IF EXISTS goals;`,
  },
  {
    version: '0021',
    description: 'Persist durable Goal Mode execution routing',
    up: `ALTER TABLE goals ADD COLUMN execution TEXT;`,
    down: ``,
  },
  {
    version: '0020',
    description: 'Ordered session event log with per-session cursors and causality tracking',
    up: `
      CREATE TABLE IF NOT EXISTS session_event_cursors (
        session_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL DEFAULT 1,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ordered_session_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        parent_sequence INTEGER,
        payload TEXT NOT NULL,
        dispatched INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, epoch, sequence)
      );

      CREATE TABLE IF NOT EXISTS session_event_causes (
        session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        cause_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        PRIMARY KEY(session_id, epoch, cause_key)
      );

      CREATE INDEX IF NOT EXISTS idx_ordered_events_session ON ordered_session_events(session_id, epoch, sequence);
      CREATE INDEX IF NOT EXISTS idx_ordered_events_dispatched ON ordered_session_events(dispatched);
    `,
    down: `
      DROP INDEX IF EXISTS idx_ordered_events_dispatched;
      DROP INDEX IF EXISTS idx_ordered_events_session;
      DROP TABLE IF EXISTS session_event_causes;
      DROP TABLE IF EXISTS ordered_session_events;
      DROP TABLE IF EXISTS session_event_cursors;
    `,
  },
  {
    version: '0022',
    description: 'Add conversation_revision counter to sessions for CLI session state',
    up: `ALTER TABLE sessions ADD COLUMN conversation_revision INTEGER DEFAULT 0;`,
    down: ``,
  },
  {
    version: '0023',
    description: 'Persist revisioned session compaction checkpoints',
    up: `
      ALTER TABLE messages ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS session_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_revision INTEGER NOT NULL,
        target_revision INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        automatic INTEGER NOT NULL DEFAULT 0,
        source_message_count INTEGER NOT NULL,
        source_tokens INTEGER NOT NULL DEFAULT 0,
        checkpoint_tokens INTEGER NOT NULL DEFAULT 0,
        summary_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_revision ON messages(session_id, context_revision, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_compactions_session ON session_compactions(session_id, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_compactions_session;
      DROP INDEX IF EXISTS idx_messages_session_revision;
      DROP TABLE IF EXISTS session_compactions;
    `,
  },
  {
    version: '0024',
    description: 'Backfill session message_count, tokens, and total_cost from messages',
    up: `
      UPDATE sessions SET
        message_count = (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id),
        tokens_in = COALESCE((SELECT SUM(tokens_in) FROM messages WHERE messages.session_id = sessions.id), 0),
        tokens_out = COALESCE((SELECT SUM(tokens_out) FROM messages WHERE messages.session_id = sessions.id), 0),
        total_cost = COALESCE((SELECT SUM(cost) FROM messages WHERE messages.session_id = sessions.id), 0)
      WHERE EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id);
    `,
    down: ``,
  },
  {
    version: '0025',
    description: 'Repair ordered event parent sequence on early durability databases',
    up: `ALTER TABLE ordered_session_events ADD COLUMN parent_sequence INTEGER;`,
    down: ``,
  },
  {
    version: '0026',
    description: 'Retain conversation lineage and separate provider transcript revisions',
    up: `
      ALTER TABLE sessions ADD COLUMN active_message_id TEXT;
      ALTER TABLE sessions ADD COLUMN provider_conversation_revision INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN parent_message_id TEXT;

      UPDATE sessions
      SET provider_conversation_revision = COALESCE(conversation_revision, 0);

      WITH ordered_messages AS (
        SELECT
          id,
          LAG(id) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS parent_id
        FROM messages
      )
      UPDATE messages
      SET parent_message_id = (
        SELECT parent_id FROM ordered_messages WHERE ordered_messages.id = messages.id
      );

      UPDATE sessions
      SET active_message_id = (
        SELECT id
        FROM messages
        WHERE messages.session_id = sessions.id
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      )
      WHERE EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id);

      CREATE INDEX IF NOT EXISTS idx_messages_session_parent
        ON messages(session_id, parent_message_id);
    `,
    down: `DROP INDEX IF EXISTS idx_messages_session_parent;`,
  },
  {
    version: '0027',
    description: 'Scope notes to projects and add optimistic revisions',
    up: `
      ALTER TABLE notes ADD COLUMN project_root TEXT;
      ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_notes_project_root ON notes(project_root);
    `,
    down: `DROP INDEX IF EXISTS idx_notes_project_root;`,
  },
  {
    version: '0028',
    description: 'Persist authoritative desktop workspace navigation',
    up: `
      CREATE TABLE IF NOT EXISTS workspace_navigation (
        id TEXT PRIMARY KEY,
        workspace_root TEXT,
        selected_project TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `DROP TABLE IF EXISTS workspace_navigation;`,
  },
  {
    version: '0029',
    description: 'Retain unavailable workspace recovery state across restarts',
    up: `
      ALTER TABLE workspace_navigation ADD COLUMN unavailable_workspace TEXT;
      ALTER TABLE workspace_navigation ADD COLUMN unavailable_project TEXT;
    `,
    down: `SELECT 1;`,
  },
  {
    version: '0030',
    description: 'Persist API usage ledger and image history in SQLite',
    up: `
      CREATE TABLE IF NOT EXISTS api_usage (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'tts', 'stt')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        estimated_cost_usd REAL,
        unit_measure TEXT CHECK (unit_measure IN ('images', 'characters', 'minutes')),
        unit_amount REAL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_ts ON api_usage (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_api_usage_kind_ts ON api_usage (kind, ts DESC);

      CREATE TABLE IF NOT EXISTS image_history (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        revised_prompt TEXT,
        effect TEXT,
        size TEXT,
        quality TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('generate', 'edit')),
        file TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_image_history_ts ON image_history (ts DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_image_history_ts;
      DROP TABLE IF EXISTS image_history;
      DROP INDEX IF EXISTS idx_api_usage_kind_ts;
      DROP INDEX IF EXISTS idx_api_usage_ts;
      DROP TABLE IF EXISTS api_usage;
    `,
  },
  {
    version: '0031',
    description: 'Store message timestamps with millisecond precision',
    // Drizzle's SQLite timestamp mode historically wrote whole Unix seconds.
    // The integer column stays unchanged; convert only plausible second-based
    // epochs. The bound makes this lossless and safely repeatable if a process
    // crashes after SQL execution but before the migration ledger is updated.
    up: `
      UPDATE messages
      SET created_at = created_at * 1000
      WHERE created_at > 0
        AND created_at < 100000000000;
    `,
    // A down conversion would irreversibly discard the millisecond component.
    // Keep existing timestamps intact rather than claiming a reversible loss.
    down: `SELECT 1;`,
  },
  {
    version: '0032',
    description: 'Add authoritative session runs and transactional lifecycle outbox',
    up: `
      CREATE TABLE IF NOT EXISTS session_runs (
        session_id TEXT PRIMARY KEY,
        run_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'idle',
        status TEXT NOT NULL DEFAULT 'idle',
        waiting_reason TEXT NOT NULL DEFAULT '',
        active_agent_ids TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        terminal_reason TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        CHECK (status IN ('idle', 'active', 'waiting', 'terminal')),
        CHECK (phase IN (
          'idle', 'analyzing', 'thinking', 'streaming', 'tool_calling',
          'waiting_terminal', 'waiting_user', 'compacting',
          'done', 'error', 'cancelled'
        ))
      );

      CREATE TABLE IF NOT EXISTS session_run_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_events_pending
        ON session_run_events(published_at, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_run_events_pending;
      DROP TABLE IF EXISTS session_run_events;
      DROP TABLE IF EXISTS session_runs;
    `,
  },
  {
    version: '0033',
    description: 'Bind resumable waits to durable continuations and seed every session run',
    up: `
      ALTER TABLE session_runs ADD COLUMN continuation_id TEXT;
      ALTER TABLE user_inputs ADD COLUMN run_id TEXT;
      ALTER TABLE user_inputs ADD COLUMN run_revision INTEGER;
      ALTER TABLE user_inputs ADD COLUMN status TEXT;
      ALTER TABLE session_run_events ADD COLUMN dead_letter_reason TEXT;

      CREATE TABLE IF NOT EXISTS session_run_continuations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        wait_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, run_id, wait_revision),
        CHECK (kind IN ('user_question', 'process_set')),
        CHECK (state IN ('pending', 'ready', 'claimed', 'consumed', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_continuations_state
        ON session_run_continuations(state, updated_at);

      INSERT OR IGNORE INTO session_runs (
        session_id, run_id, revision, phase, status, waiting_reason,
        continuation_id, active_agent_ids, started_at, updated_at,
        finished_at, terminal_reason
      )
      SELECT
        id, NULL, 0, 'idle', 'idle', '', NULL, '[]', NULL,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL
      FROM sessions;

      CREATE TRIGGER IF NOT EXISTS trg_sessions_seed_session_run
      AFTER INSERT ON sessions
      BEGIN
        INSERT OR IGNORE INTO session_runs (
          session_id, run_id, revision, phase, status, waiting_reason,
          continuation_id, active_agent_ids, started_at, updated_at,
          finished_at, terminal_reason
        ) VALUES (
          NEW.id, NULL, 0, 'idle', 'idle', '', NULL, '[]', NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL
        );
      END;
    `,
    down: `
      DROP TRIGGER IF EXISTS trg_sessions_seed_session_run;
      DROP INDEX IF EXISTS idx_session_run_continuations_state;
      DROP TABLE IF EXISTS session_run_continuations;
      SELECT 1;
    `,
  },
  {
    version: '0034',
    description: 'Add recoverable Notes trash and immutable revision history',
    up: `
      ALTER TABLE notes ADD COLUMN trashed_at INTEGER;
      ALTER TABLE notes ADD COLUMN trash_reason TEXT;

      CREATE TABLE IF NOT EXISTS note_revisions (
        note_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        project_root TEXT NOT NULL,
        operation TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_bytes INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        tags TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        include_in_context INTEGER NOT NULL,
        format TEXT NOT NULL,
        source_path TEXT,
        trashed_at INTEGER,
        trash_reason TEXT,
        note_created_at INTEGER NOT NULL,
        note_updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (note_id, revision),
        FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_notes_project_trash
        ON notes(project_root, trashed_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_note_revisions_project_note
        ON note_revisions(project_root, note_id, revision DESC);

      -- Give every pre-existing note a recoverable baseline without rewriting
      -- the current row. Project-document source paths are derivable from the
      -- stable note ID and are filled by the service when this legacy NULL is read.
      INSERT OR IGNORE INTO note_revisions (
        note_id, revision, project_root, operation, title, content, content_bytes,
        folder_path, tags, pinned, include_in_context, format, source_path,
        trashed_at, trash_reason, note_created_at, note_updated_at, created_at
      )
      SELECT
        id, revision, COALESCE(project_root, ''), 'update', title, content,
        length(CAST(content AS BLOB)), folder_path, tags, pinned,
        include_in_context, format, NULL, NULL, NULL, created_at, updated_at,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM notes;
    `,
    // SQLite cannot drop columns without rebuilding the authoritative notes
    // table, and dropping note_revisions would destroy recovery history. A
    // rollback only removes accelerators; reapplying recreates them and keeps
    // every snapshot intact.
    down: `
      DROP INDEX IF EXISTS idx_note_revisions_project_note;
      DROP INDEX IF EXISTS idx_notes_project_trash;
    `,
  },
  // 0035 was emitted by an earlier pre-release archive iteration. Never reuse
  // a ledgered identifier with different SQL; 0036 repairs that current-schema
  // state idempotently while preserving strong checksum enforcement.
  {
    version: '0036',
    description: 'Add recoverable chat archives with active and archived indexes',
    up: `
      ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_sessions_active_updated
        ON sessions(updated_at DESC) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_archived_at
        ON sessions(archived_at DESC) WHERE archived_at IS NOT NULL;
    `,
    // SQLite cannot drop a column without rebuilding the authoritative session
    // table. Retain the nullable marker on rollback rather than risk chat data.
    down: `
      DROP INDEX IF EXISTS idx_sessions_archived_at;
      DROP INDEX IF EXISTS idx_sessions_active_updated;
    `,
  },
  {
    version: '0037',
    description: 'Normalize durable process ownership for session-run continuations',
    up: `
      CREATE TABLE IF NOT EXISTS session_run_continuation_processes (
        continuation_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        PRIMARY KEY (continuation_id, process_id),
        FOREIGN KEY(continuation_id)
          REFERENCES session_run_continuations(id) ON DELETE CASCADE,
        FOREIGN KEY(process_id)
          REFERENCES supervised_processes(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_continuation_processes_process
        ON session_run_continuation_processes(process_id, continuation_id);

      INSERT OR IGNORE INTO session_run_continuation_processes (continuation_id, process_id)
      SELECT continuation.id, CAST(process.value AS TEXT)
      FROM session_run_continuations AS continuation
      JOIN json_each(
        CASE WHEN json_valid(continuation.payload)
          THEN continuation.payload ELSE '{"processIds":[]}' END,
        '$.processIds'
      ) AS process
      JOIN supervised_processes AS supervised
        ON supervised.id = CAST(process.value AS TEXT)
       AND supervised.session_id = continuation.session_id
      WHERE continuation.kind = 'process_set'
        AND continuation.state IN ('pending', 'ready', 'claimed')
        AND process.type = 'text'
        AND length(CAST(process.value AS TEXT)) > 0;
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_run_continuation_processes_process;
      DROP TABLE IF EXISTS session_run_continuation_processes;
    `,
  },
  {
    version: '0038',
    description: 'Add leased restart handoffs for answered durable questions',
    up: `
      CREATE TABLE IF NOT EXISTS session_run_handoffs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_run_revision INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        question_payload TEXT NOT NULL,
        answer TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        claim_token TEXT,
        claimed_by TEXT,
        claimed_at INTEGER,
        lease_expires_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        consumed_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(question_id),
        CHECK (kind IN ('resume_answered_question')),
        CHECK (state IN ('pending', 'claimed', 'consumed')),
        CHECK (source_run_revision >= 0),
        CHECK (attempt_count >= 0),
        CHECK (
          (state = 'pending' AND claim_token IS NULL AND claimed_by IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL AND consumed_at IS NULL)
          OR
          (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
            AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND consumed_at IS NULL)
          OR
          (state = 'consumed' AND claim_token IS NULL AND claimed_by IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL AND consumed_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_handoffs_claimable
        ON session_run_handoffs(state, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_run_handoffs_session
        ON session_run_handoffs(session_id, created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_run_handoffs_session;
      DROP INDEX IF EXISTS idx_session_run_handoffs_claimable;
      DROP TABLE IF EXISTS session_run_handoffs;
    `,
  },
  {
    version: '0039',
    description: 'Add durable Notes drafts, typed property projection, and saved Bases',
    up: `
      CREATE TABLE IF NOT EXISTS note_draft_principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        CHECK (kind IN ('local'))
      );

      INSERT OR IGNORE INTO note_draft_principals (id, kind, created_at)
      VALUES (
        'local-' || lower(hex(randomblob(16))),
        'local',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      );

      CREATE TABLE IF NOT EXISTS note_drafts (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        note_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        draft_revision INTEGER NOT NULL DEFAULT 1,
        base_title TEXT NOT NULL,
        source_path_at_base TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_bytes INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        tags TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        include_in_context INTEGER NOT NULL,
        format TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(principal_id) REFERENCES note_draft_principals(id) ON DELETE RESTRICT,
        CHECK (base_revision >= 1),
        CHECK (draft_revision >= 1),
        CHECK (content_bytes >= 0),
        CHECK (pinned IN (0, 1)),
        CHECK (include_in_context IN (0, 1)),
        CHECK (format IN ('markdown', 'html'))
      );
      CREATE INDEX IF NOT EXISTS idx_note_drafts_scope_updated
        ON note_drafts(principal_id, project_root, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_note_drafts_scope_note
        ON note_drafts(principal_id, project_root, note_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS note_property_documents (
        note_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        projected_revision INTEGER NOT NULL,
        frontmatter_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        issues_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
        CHECK (projected_revision >= 1),
        CHECK (status IN ('valid', 'invalid', 'unsupported'))
      );
      CREATE INDEX IF NOT EXISTS idx_note_property_documents_scope_revision
        ON note_property_documents(project_root, projected_revision);

      CREATE TABLE IF NOT EXISTS note_properties (
        note_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        key TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        type TEXT NOT NULL,
        value_json TEXT NOT NULL,
        value_text TEXT,
        value_number REAL,
        value_boolean INTEGER,
        note_revision INTEGER NOT NULL,
        PRIMARY KEY(note_id, normalized_key),
        FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
        CHECK (type IN ('text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags')),
        CHECK (value_boolean IS NULL OR value_boolean IN (0, 1)),
        CHECK (note_revision >= 1)
      );
      CREATE INDEX IF NOT EXISTS idx_note_properties_scope_key_text
        ON note_properties(project_root, normalized_key, value_text);
      CREATE INDEX IF NOT EXISTS idx_note_properties_scope_key_number
        ON note_properties(project_root, normalized_key, value_number);
      CREATE INDEX IF NOT EXISTS idx_note_properties_scope_key_boolean
        ON note_properties(project_root, normalized_key, value_boolean);

      CREATE TABLE IF NOT EXISTS note_property_items (
        note_id TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        project_root TEXT NOT NULL,
        value_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        PRIMARY KEY(note_id, normalized_key, ordinal),
        FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
        CHECK (ordinal >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_note_property_items_scope_key_value
        ON note_property_items(project_root, normalized_key, normalized_text);

      CREATE TABLE IF NOT EXISTS note_property_schemas (
        project_root TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        usage_count INTEGER NOT NULL DEFAULT 0,
        invalid_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_root, normalized_key),
        CHECK (kind IN ('text', 'number', 'checkbox', 'date', 'datetime', 'list', 'tags')),
        CHECK (revision >= 1),
        CHECK (usage_count >= 0),
        CHECK (invalid_count >= 0)
      );

      CREATE TABLE IF NOT EXISTS note_bases (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        name TEXT NOT NULL,
        definition TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        trashed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(principal_id) REFERENCES note_draft_principals(id) ON DELETE RESTRICT,
        CHECK (revision >= 1),
        CHECK (length(definition) <= 65536)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_note_bases_scope_name
        ON note_bases(principal_id, project_root, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_note_bases_scope_updated
        ON note_bases(principal_id, project_root, updated_at DESC);

      CREATE TABLE IF NOT EXISTS note_base_revisions (
        base_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        project_root TEXT NOT NULL,
        operation TEXT NOT NULL,
        name TEXT NOT NULL,
        definition TEXT NOT NULL,
        trashed_at INTEGER,
        base_created_at INTEGER NOT NULL,
        base_updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(base_id, revision),
        FOREIGN KEY(base_id) REFERENCES note_bases(id) ON DELETE CASCADE,
        CHECK (revision >= 1),
        CHECK (operation IN ('create', 'update', 'trash', 'restore')),
        CHECK (length(definition) <= 65536)
      );
      CREATE INDEX IF NOT EXISTS idx_note_base_revisions_scope
        ON note_base_revisions(project_root, base_id, revision);
    `,
    // These tables contain user recovery data. A rollback removes only the
    // accelerators and deliberately leaves durable drafts/Bases readable for a
    // later re-application instead of destroying them.
    down: `
      DROP INDEX IF EXISTS idx_note_base_revisions_scope;
      DROP INDEX IF EXISTS idx_note_bases_scope_updated;
      DROP INDEX IF EXISTS uq_note_bases_scope_name;
      DROP INDEX IF EXISTS idx_note_property_items_scope_key_value;
      DROP INDEX IF EXISTS idx_note_properties_scope_key_boolean;
      DROP INDEX IF EXISTS idx_note_properties_scope_key_number;
      DROP INDEX IF EXISTS idx_note_properties_scope_key_text;
      DROP INDEX IF EXISTS idx_note_property_documents_scope_revision;
      DROP INDEX IF EXISTS idx_note_drafts_scope_note;
      DROP INDEX IF EXISTS idx_note_drafts_scope_updated;
    `,
  },
  {
    version: '0040',
    description: 'Move process-supervisor schema under core migration ownership',
    up: `
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
    `,
    // Process evidence and continuation parents are user-visible recovery
    // state. A rollback may remove accelerators but must never drop the rows.
    down: `
      DROP INDEX IF EXISTS idx_process_events_process;
      DROP INDEX IF EXISTS idx_supervised_processes_status;
      DROP INDEX IF EXISTS idx_supervised_processes_session;
    `,
  },
  {
    version: '0041',
    description: 'Add durable commit witnesses for crash-safe Notes vault restore',
    up: `
      CREATE TABLE IF NOT EXISTS note_vault_restore_commits (
        archive_sha256 TEXT NOT NULL,
        project_root TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        plan_token TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY(archive_sha256, project_root),
        CHECK (length(archive_sha256) = 64),
        CHECK (length(manifest_sha256) = 64),
        CHECK (length(plan_token) = 64)
      );
      CREATE INDEX IF NOT EXISTS idx_note_vault_restore_commits_project
        ON note_vault_restore_commits(project_root, committed_at DESC);
    `,
    // Commit witnesses are recovery evidence. A rollback may remove the
    // accelerator but must not erase proof of a completed vault restore.
    down: `
      DROP INDEX IF EXISTS idx_note_vault_restore_commits_project;
    `,
  },
  {
    version: '0042',
    description: 'Persist feed visibility tombstones and explicit client error evidence',
    up: `
      CREATE TABLE IF NOT EXISTS session_feed_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        CHECK (kind IN ('client_error')),
        CHECK (length(text) BETWEEN 1 AND 16384)
      );
      CREATE INDEX IF NOT EXISTS idx_session_feed_entries_session
        ON session_feed_entries(session_id, timestamp);

      CREATE TABLE IF NOT EXISTS session_feed_tombstones (
        session_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        visibility TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, target_key),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        CHECK (visibility IN ('hidden', 'deleted')),
        CHECK (length(target_key) BETWEEN 1 AND 512)
      );
      CREATE INDEX IF NOT EXISTS idx_session_feed_tombstones_session
        ON session_feed_tombstones(session_id, updated_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_feed_tombstones_session;
      DROP TABLE IF EXISTS session_feed_tombstones;
      DROP INDEX IF EXISTS idx_session_feed_entries_session;
      DROP TABLE IF EXISTS session_feed_entries;
    `,
  },
  {
    version: '0043',
    description: 'Add the authoritative session-turn command ledger',
    up: `
      CREATE TABLE IF NOT EXISTS session_turn_commands (
        command_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_command_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        response_message_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        CHECK (source IN ('goal', 'collaboration', 'internal')),
        CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'waiting')),
        CHECK (length(command_key) = 40 AND command_key NOT GLOB '*[^0-9a-f]*'),
        CHECK (length(source_command_id) BETWEEN 1 AND 512),
        CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (user_message_id = 'command-user-' || command_key),
        CHECK (response_message_id = 'command-response-' || command_key),
        CHECK (length(run_id) BETWEEN 1 AND 128),
        CHECK (created_at >= 0 AND updated_at >= created_at),
        CHECK (finished_at IS NULL OR finished_at >= created_at),
        CHECK (
          (status IN ('active', 'waiting') AND terminal_reason IS NULL AND finished_at IS NULL)
          OR
          (status IN ('completed', 'failed', 'cancelled')
            AND terminal_reason IS NOT NULL
            AND length(trim(terminal_reason)) BETWEEN 1 AND 2048
            AND finished_at IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_turn_commands_source
        ON session_turn_commands(session_id, source, source_command_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_turn_commands_user_message
        ON session_turn_commands(user_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_turn_commands_response_message
        ON session_turn_commands(response_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_turn_commands_run
        ON session_turn_commands(run_id);
      CREATE INDEX IF NOT EXISTS idx_session_turn_commands_session_status
        ON session_turn_commands(session_id, status, updated_at);
    `,
    // Command receipts are provider-side-effect recovery evidence. Rolling
    // back an accelerator must never erase whether a command already ran.
    down: `
      DROP INDEX IF EXISTS idx_session_turn_commands_session_status;
    `,
  },
];

// ─── Migration Runner ────────────────────────────────────────────────────────

interface SqliteTableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteIndex {
  name: string;
  unique: number;
}

interface SqliteIndexColumn {
  seqno: number;
  name: string;
}

interface SqliteForeignKey {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const STRONG_CHECKSUM_PREFIX = 'sha256:';

export class MigrationRunner {
  private db: Database;
  private migrationsTable = '_migrations';

  constructor(db: Database) {
    this.db = db;
    const busyTimeout = this.db
      .query<{ timeout: number }, []>('PRAGMA busy_timeout')
      .get()?.timeout;
    if ((busyTimeout ?? 0) < 5_000) this.db.exec('PRAGMA busy_timeout = 5000;');
    this.ensureMigrationsTable();
  }

  /**
   * Create the migrations tracking table if it doesn't exist
   */
  private ensureMigrationsTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ${this.migrationsTable} (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      )
    `);
  }

  /**
   * Get all applied migrations
   */
  getAppliedMigrations(): MigrationRecord[] {
    const records = this.db
      .query<MigrationRecord, []>(
        `SELECT version, description, applied_at AS appliedAt, checksum
         FROM ${this.migrationsTable} ORDER BY version`,
      )
      .all();
    for (const record of records) {
      const migration = MIGRATIONS.find((candidate) => candidate.version === record.version);
      if (migration) this.assertStoredChecksum(record, migration);
    }
    return records;
  }

  /**
   * Get pending migrations
   */
  getPendingMigrations(): Migration[] {
    const applied = new Set(this.getAppliedMigrations().map((m) => m.version));
    return MIGRATIONS.filter((m) => !applied.has(m.version));
  }

  /**
   * Calculate checksum for a migration
   */
  private calculateChecksum(migration: Migration): string {
    return `${STRONG_CHECKSUM_PREFIX}${createHash('sha256').update(migration.up).digest('hex')}`;
  }

  /**
   * Older releases stored an unversioned, non-cryptographic checksum. Those
   * rows remain readable; every row written by this runner is strong and is
   * enforced on all later startups.
   */
  private assertStoredChecksum(record: MigrationRecord, migration: Migration): void {
    if (!record.checksum.startsWith(STRONG_CHECKSUM_PREFIX)) return;
    if (record.checksum !== this.calculateChecksum(migration)) {
      throw new Error(
        `Migration ${migration.version} checksum mismatch: the registered migration changed after it was applied`,
      );
    }
  }

  private quoteIdentifier(identifier: string): string {
    if (!/^[a-z0-9_]+$/i.test(identifier)) {
      throw new Error(`Unsafe SQLite identifier: ${identifier}`);
    }
    return `"${identifier}"`;
  }

  private getColumns(table: string): SqliteTableColumn[] {
    return this.db
      .query(`PRAGMA table_info(${this.quoteIdentifier(table)})`)
      .all() as SqliteTableColumn[];
  }

  private getSchemaSql(type: 'table' | 'trigger' | 'index', name: string): string | null {
    const row = this.db
      .query<{ sql: string | null }, [string, string]>(
        'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?',
      )
      .get(type, name);
    return row?.sql ?? null;
  }

  private requireColumns(
    table: string,
    requirements: Record<
      string,
      { type?: string; notNull?: boolean; primaryKey?: boolean; defaultValue?: string }
    >,
  ): void {
    if (!this.getSchemaSql('table', table)) {
      throw new Error(`Migration postcondition failed: table ${table} is missing`);
    }
    const columns = new Map(this.getColumns(table).map((column) => [column.name, column]));
    for (const [name, requirement] of Object.entries(requirements)) {
      const column = columns.get(name);
      if (!column) {
        throw new Error(`Migration postcondition failed: ${table}.${name} is missing`);
      }
      if (requirement.type && column.type.toUpperCase() !== requirement.type.toUpperCase()) {
        throw new Error(
          `Migration postcondition failed: ${table}.${name} must be ${requirement.type}`,
        );
      }
      if (requirement.notNull !== undefined && Boolean(column.notnull) !== requirement.notNull) {
        throw new Error(
          `Migration postcondition failed: ${table}.${name} has the wrong nullability`,
        );
      }
      const primaryKeyMatches = requirement.primaryKey
        ? column.pk === 1 &&
          [...columns.values()].filter((candidate) => candidate.pk > 0).length === 1
        : column.pk === 0;
      if (requirement.primaryKey !== undefined && !primaryKeyMatches) {
        throw new Error(
          `Migration postcondition failed: ${table}.${name} has the wrong primary-key shape`,
        );
      }
      if (requirement.defaultValue !== undefined) {
        const actual = (column.dflt_value ?? '').replace(/[()'"\s]/g, '').toLowerCase();
        const expected = requirement.defaultValue.replace(/[()'"\s]/g, '').toLowerCase();
        if (actual !== expected) {
          throw new Error(`Migration postcondition failed: ${table}.${name} has the wrong default`);
        }
      }
    }
  }

  private hasIndex(table: string, columns: string[], unique?: boolean): boolean {
    const indexes = this.db
      .query(`PRAGMA index_list(${this.quoteIdentifier(table)})`)
      .all() as SqliteIndex[];
    return indexes.some((index) => {
      if (unique !== undefined && Boolean(index.unique) !== unique) return false;
      const actual = (
        this.db
          .query(`PRAGMA index_info(${this.quoteIdentifier(index.name)})`)
          .all() as SqliteIndexColumn[]
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name);
      return (
        actual.length === columns.length && actual.every((name, offset) => name === columns[offset])
      );
    });
  }

  private requireIndex(table: string, columns: string[], unique?: boolean): void {
    if (!this.hasIndex(table, columns, unique)) {
      const kind = unique ? 'unique index' : 'index';
      throw new Error(
        `Migration postcondition failed: ${table} needs ${kind} (${columns.join(', ')})`,
      );
    }
  }

  private requireCompositePrimaryKey(table: string, columns: string[]): void {
    const actual = this.getColumns(table)
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (
      actual.length !== columns.length ||
      !actual.every((column, offset) => column === columns[offset])
    ) {
      throw new Error(
        `Migration postcondition failed: ${table} needs primary key (${columns.join(', ')})`,
      );
    }
  }

  private requireForeignKey(
    table: string,
    from: string,
    referencedTable: string,
    to: string,
    onDelete: 'CASCADE' | 'RESTRICT',
  ): void {
    const foreignKeys = this.db
      .query(`PRAGMA foreign_key_list(${this.quoteIdentifier(table)})`)
      .all() as SqliteForeignKey[];
    if (
      !foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === referencedTable &&
          foreignKey.from === from &&
          foreignKey.to === to &&
          foreignKey.on_delete.toUpperCase() === onDelete,
      )
    ) {
      throw new Error(
        `Migration postcondition failed: ${table}.${from} must reference ${referencedTable}.${to} ON DELETE ${onDelete}`,
      );
    }
  }

  private requireCascadeForeignKey(table: string, from: string): void {
    const foreignKeys = this.db
      .query(`PRAGMA foreign_key_list(${this.quoteIdentifier(table)})`)
      .all() as SqliteForeignKey[];
    if (
      !foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === 'sessions' &&
          foreignKey.from === from &&
          foreignKey.to === 'id' &&
          foreignKey.on_delete.toUpperCase() === 'CASCADE',
      )
    ) {
      throw new Error(
        `Migration postcondition failed: ${table}.${from} must cascade to sessions.id`,
      );
    }
  }

  private requireCheck(table: string, expression: string): void {
    const sql = this.getSchemaSql('table', table);
    const normalized = (sql ?? '').toLowerCase().replace(/['"`\s]/g, '');
    const expected = expression.toLowerCase().replace(/['"`\s]/g, '');
    if (!normalized.includes(expected)) {
      throw new Error(`Migration postcondition failed: ${table} is missing ${expression}`);
    }
  }

  private validateSessionRunSchema(): void {
    this.requireColumns('session_runs', {
      session_id: { type: 'TEXT', primaryKey: true },
      run_id: { type: 'TEXT', notNull: false },
      revision: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      phase: { type: 'TEXT', notNull: true, defaultValue: 'idle' },
      status: { type: 'TEXT', notNull: true, defaultValue: 'idle' },
      waiting_reason: { type: 'TEXT', notNull: true, defaultValue: '' },
      active_agent_ids: { type: 'TEXT', notNull: true, defaultValue: '[]' },
      started_at: { type: 'INTEGER', notNull: false },
      updated_at: { type: 'INTEGER', notNull: true },
      finished_at: { type: 'INTEGER', notNull: false },
      terminal_reason: { type: 'TEXT', notNull: false },
    });
    this.requireCascadeForeignKey('session_runs', 'session_id');
    this.requireCheck(
      'session_runs',
      "CHECK (status IN ('idle', 'active', 'waiting', 'terminal'))",
    );
    this.requireCheck(
      'session_runs',
      "CHECK (phase IN ('idle', 'analyzing', 'thinking', 'streaming', 'tool_calling', 'waiting_terminal', 'waiting_user', 'compacting', 'done', 'error', 'cancelled'))",
    );

    this.requireColumns('session_run_events', {
      event_id: { type: 'TEXT', primaryKey: true },
      session_id: { type: 'TEXT', notNull: true },
      run_id: { type: 'TEXT', notNull: false },
      revision: { type: 'INTEGER', notNull: true },
      payload: { type: 'TEXT', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
      published_at: { type: 'INTEGER', notNull: false },
    });
    this.requireCascadeForeignKey('session_run_events', 'session_id');
    this.requireIndex('session_run_events', ['session_id', 'revision'], true);
    this.requireIndex('session_run_events', ['published_at', 'created_at'], false);
  }

  private validateContinuationSchema(): void {
    this.validateSessionRunSchema();
    this.requireColumns('session_runs', {
      continuation_id: { type: 'TEXT', notNull: false },
    });
    this.requireColumns('session_run_events', {
      dead_letter_reason: { type: 'TEXT', notNull: false },
    });
    this.requireColumns('user_inputs', {
      run_id: { type: 'TEXT', notNull: false },
      run_revision: { type: 'INTEGER', notNull: false },
      status: { type: 'TEXT', notNull: false },
    });
    this.requireColumns('session_run_continuations', {
      id: { type: 'TEXT', primaryKey: true },
      session_id: { type: 'TEXT', notNull: true },
      run_id: { type: 'TEXT', notNull: true },
      wait_revision: { type: 'INTEGER', notNull: true },
      kind: { type: 'TEXT', notNull: true },
      state: { type: 'TEXT', notNull: true, defaultValue: 'pending' },
      payload: { type: 'TEXT', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCascadeForeignKey('session_run_continuations', 'session_id');
    this.requireIndex('session_run_continuations', ['session_id', 'run_id', 'wait_revision'], true);
    this.requireIndex('session_run_continuations', ['state', 'updated_at'], false);
    this.requireCheck(
      'session_run_continuations',
      "CHECK (kind IN ('user_question', 'process_set'))",
    );
    this.requireCheck(
      'session_run_continuations',
      "CHECK (state IN ('pending', 'ready', 'claimed', 'consumed', 'cancelled'))",
    );

    const triggerSql = this.getSchemaSql('trigger', 'trg_sessions_seed_session_run');
    const normalizedTrigger = (triggerSql ?? '').toLowerCase().replace(/['"`\s]/g, '');
    if (
      !normalizedTrigger.includes('afterinsertonsessions') ||
      !normalizedTrigger.includes('insertorignoreintosession_runs')
    ) {
      throw new Error(
        'Migration postcondition failed: session run seed trigger is missing or incompatible',
      );
    }

    const missing = this.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN session_runs ON session_runs.session_id = sessions.id
         WHERE session_runs.session_id IS NULL`,
      )
      .get()?.count;
    if ((missing ?? 0) !== 0) {
      throw new Error('Migration postcondition failed: not every session has a session run');
    }
  }

  private validateContinuationProcessSchema(): void {
    const table = 'session_run_continuation_processes';
    this.requireColumns(table, {
      continuation_id: { type: 'TEXT', notNull: true },
      process_id: { type: 'TEXT', notNull: true },
    });
    this.requireCompositePrimaryKey(table, ['continuation_id', 'process_id']);
    this.requireIndex(table, ['process_id', 'continuation_id'], false);
    this.requireForeignKey(table, 'continuation_id', 'session_run_continuations', 'id', 'CASCADE');
    this.requireForeignKey(table, 'process_id', 'supervised_processes', 'id', 'RESTRICT');

    const liveContinuations =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM session_run_continuations
           WHERE kind = 'process_set' AND state IN ('pending', 'ready', 'claimed')`,
        )
        .get()?.count ?? 0;
    const referenceCount =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_continuation_processes`,
        )
        .get()?.count ?? 0;
    const processTablePresent = Boolean(this.getSchemaSql('table', 'supervised_processes'));
    if (!processTablePresent) {
      if (liveContinuations !== 0 || referenceCount !== 0) {
        throw new Error(
          'Migration postcondition failed: live process continuations require supervised_processes',
        );
      }
      return;
    }

    const foreignKeyViolations = this.db
      .query(`PRAGMA foreign_key_check(${this.quoteIdentifier(table)})`)
      .all();
    if (foreignKeyViolations.length !== 0) {
      throw new Error(
        'Migration postcondition failed: continuation process ownership has foreign-key violations',
      );
    }

    const invalidPayloads =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM session_run_continuations AS continuation
           WHERE continuation.kind = 'process_set'
             AND continuation.state IN ('pending', 'ready', 'claimed')
             AND (
               json_type(
                 CASE WHEN json_valid(continuation.payload)
                   THEN continuation.payload ELSE '{}' END,
                 '$.processIds'
               ) IS NOT 'array'
               OR NOT EXISTS (
                 SELECT 1
                 FROM json_each(
                   CASE WHEN json_valid(continuation.payload)
                     THEN continuation.payload ELSE '{"processIds":[]}' END,
                   '$.processIds'
                 ) AS item
                 WHERE item.type = 'text' AND length(CAST(item.value AS TEXT)) > 0
               )
             )`,
        )
        .get()?.count ?? 0;
    if (invalidPayloads !== 0) {
      throw new Error(
        'Migration postcondition failed: a live process continuation has no valid process set',
      );
    }

    const expectedProjection = `
      SELECT continuation.id AS continuation_id, CAST(item.value AS TEXT) AS process_id
      FROM session_run_continuations AS continuation
      JOIN json_each(
        CASE WHEN json_valid(continuation.payload)
          THEN continuation.payload ELSE '{"processIds":[]}' END,
        '$.processIds'
      ) AS item
      WHERE continuation.kind = 'process_set'
        AND continuation.state IN ('pending', 'ready', 'claimed')
        AND item.type = 'text'
        AND length(CAST(item.value AS TEXT)) > 0
      GROUP BY continuation.id, CAST(item.value AS TEXT)`;
    const missingReferences =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM (
             ${expectedProjection}
             EXCEPT
             SELECT continuation_id, process_id
             FROM session_run_continuation_processes
           )`,
        )
        .get()?.count ?? 0;
    const extraReferences =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM (
             SELECT reference.continuation_id, reference.process_id
             FROM session_run_continuation_processes AS reference
             JOIN session_run_continuations AS continuation
               ON continuation.id = reference.continuation_id
             WHERE continuation.kind = 'process_set'
               AND continuation.state IN ('pending', 'ready', 'claimed')
             EXCEPT
             ${expectedProjection}
           )`,
        )
        .get()?.count ?? 0;
    const nonLiveReferences =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM session_run_continuation_processes AS reference
           LEFT JOIN session_run_continuations AS continuation
             ON continuation.id = reference.continuation_id
           WHERE continuation.id IS NULL
              OR continuation.kind <> 'process_set'
              OR continuation.state NOT IN ('pending', 'ready', 'claimed')`,
        )
        .get()?.count ?? 0;
    const crossSessionReferences =
      this.db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM session_run_continuation_processes AS reference
           JOIN session_run_continuations AS continuation
             ON continuation.id = reference.continuation_id
           JOIN supervised_processes AS process ON process.id = reference.process_id
           WHERE process.session_id <> continuation.session_id`,
        )
        .get()?.count ?? 0;
    if (
      missingReferences !== 0 ||
      extraReferences !== 0 ||
      nonLiveReferences !== 0 ||
      crossSessionReferences !== 0
    ) {
      throw new Error(
        'Migration postcondition failed: continuation process ownership does not match live waits',
      );
    }
  }

  private validateProcessSupervisorSchema(): void {
    this.requireColumns('supervised_processes', {
      id: { type: 'TEXT', primaryKey: true },
      name: { type: 'TEXT', notNull: true },
      command: { type: 'TEXT', notNull: true },
      command_replayable: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      cwd: { type: 'TEXT', notNull: true },
      pid: { type: 'INTEGER', notNull: true },
      session_id: { type: 'TEXT', notNull: true },
      status: { type: 'TEXT', notNull: true, defaultValue: 'starting' },
      provenance: { type: 'TEXT', notNull: true, defaultValue: 'legacy-unknown' },
      supervision: { type: 'TEXT', notNull: true, defaultValue: 'legacy-unknown' },
      is_background: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      terminal_reason: { type: 'TEXT', notNull: false },
      terminal_error: { type: 'TEXT', notNull: false },
    });
    this.requireIndex('supervised_processes', ['session_id', 'created_at'], false);
    this.requireIndex('supervised_processes', ['status', 'created_at'], false);

    this.requireColumns('process_events', {
      id: { type: 'INTEGER', primaryKey: true },
      process_id: { type: 'TEXT', notNull: true },
      event_type: { type: 'TEXT', notNull: true },
      timestamp: { type: 'INTEGER', notNull: true },
    });
    this.requireIndex('process_events', ['process_id', 'timestamp'], false);

    this.requireColumns('process_health_checks', {
      process_id: { type: 'TEXT', primaryKey: true },
      check_count: { type: 'INTEGER', notNull: false, defaultValue: '0' },
      failure_count: { type: 'INTEGER', notNull: false, defaultValue: '0' },
      consecutive_failures: { type: 'INTEGER', notNull: false, defaultValue: '0' },
      is_healthy: { type: 'INTEGER', notNull: false, defaultValue: '1' },
      updated_at: { type: 'INTEGER', notNull: true },
    });

    // The continuation table was allowed to precede its process parent on a
    // fresh database. Once 0040 is ledgered that split ownership is over.
    this.validateContinuationProcessSchema();
  }

  private validateRestartHandoffSchema(): void {
    this.requireColumns('session_run_handoffs', {
      id: { type: 'TEXT', primaryKey: true },
      session_id: { type: 'TEXT', notNull: true },
      kind: { type: 'TEXT', notNull: true },
      source_run_id: { type: 'TEXT', notNull: true },
      source_run_revision: { type: 'INTEGER', notNull: true },
      question_id: { type: 'TEXT', notNull: true },
      question_payload: { type: 'TEXT', notNull: true },
      answer: { type: 'TEXT', notNull: true },
      state: { type: 'TEXT', notNull: true, defaultValue: 'pending' },
      claim_token: { type: 'TEXT', notNull: false },
      claimed_by: { type: 'TEXT', notNull: false },
      claimed_at: { type: 'INTEGER', notNull: false },
      lease_expires_at: { type: 'INTEGER', notNull: false },
      attempt_count: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      last_error: { type: 'TEXT', notNull: false },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
      consumed_at: { type: 'INTEGER', notNull: false },
    });
    this.requireCascadeForeignKey('session_run_handoffs', 'session_id');
    this.requireIndex('session_run_handoffs', ['question_id'], true);
    this.requireIndex('session_run_handoffs', ['state', 'lease_expires_at', 'created_at'], false);
    this.requireIndex('session_run_handoffs', ['session_id', 'created_at'], false);
    this.requireCheck('session_run_handoffs', "CHECK (kind IN ('resume_answered_question'))");
    this.requireCheck(
      'session_run_handoffs',
      "CHECK (state IN ('pending', 'claimed', 'consumed'))",
    );
    this.requireCheck('session_run_handoffs', 'CHECK (source_run_revision >= 0)');
    this.requireCheck('session_run_handoffs', 'CHECK (attempt_count >= 0)');
    this.requireCheck(
      'session_run_handoffs',
      `CHECK (
          (state = 'pending' AND claim_token IS NULL AND claimed_by IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL AND consumed_at IS NULL)
          OR
          (state = 'claimed' AND claim_token IS NOT NULL AND claimed_by IS NOT NULL
            AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND consumed_at IS NULL)
          OR
          (state = 'consumed' AND claim_token IS NULL AND claimed_by IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL AND consumed_at IS NOT NULL)
        )`,
    );
  }

  private validateNotesWorkspaceSchema(): void {
    this.requireColumns('note_draft_principals', {
      id: { type: 'TEXT', primaryKey: true },
      kind: { type: 'TEXT', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
    });
    this.requireIndex('note_draft_principals', ['kind'], true);
    this.requireCheck('note_draft_principals', "CHECK (kind IN ('local'))");

    this.requireColumns('note_drafts', {
      id: { type: 'TEXT', primaryKey: true },
      principal_id: { type: 'TEXT', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      note_id: { type: 'TEXT', notNull: true },
      base_revision: { type: 'INTEGER', notNull: true },
      draft_revision: { type: 'INTEGER', notNull: true, defaultValue: '1' },
      base_title: { type: 'TEXT', notNull: true },
      source_path_at_base: { type: 'TEXT', notNull: false },
      title: { type: 'TEXT', notNull: true },
      content: { type: 'TEXT', notNull: true },
      content_bytes: { type: 'INTEGER', notNull: true },
      folder_path: { type: 'TEXT', notNull: true },
      tags: { type: 'TEXT', notNull: true },
      pinned: { type: 'INTEGER', notNull: true },
      include_in_context: { type: 'INTEGER', notNull: true },
      format: { type: 'TEXT', notNull: true },
      payload_hash: { type: 'TEXT', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireForeignKey(
      'note_drafts',
      'principal_id',
      'note_draft_principals',
      'id',
      'RESTRICT',
    );
    this.requireIndex('note_drafts', ['principal_id', 'project_root', 'updated_at'], false);
    this.requireIndex(
      'note_drafts',
      ['principal_id', 'project_root', 'note_id', 'updated_at'],
      false,
    );
    this.requireCheck('note_drafts', 'CHECK (base_revision >= 1)');
    this.requireCheck('note_drafts', 'CHECK (draft_revision >= 1)');
    this.requireCheck('note_drafts', 'CHECK (content_bytes >= 0)');
    this.requireCheck('note_drafts', 'CHECK (pinned IN (0, 1))');
    this.requireCheck('note_drafts', 'CHECK (include_in_context IN (0, 1))');
    this.requireCheck('note_drafts', "CHECK (format IN ('markdown', 'html'))");

    this.requireColumns('note_property_documents', {
      note_id: { type: 'TEXT', primaryKey: true },
      project_root: { type: 'TEXT', notNull: true },
      projected_revision: { type: 'INTEGER', notNull: true },
      frontmatter_hash: { type: 'TEXT', notNull: true },
      status: { type: 'TEXT', notNull: true },
      issues_json: { type: 'TEXT', notNull: true, defaultValue: '[]' },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireForeignKey('note_property_documents', 'note_id', 'notes', 'id', 'CASCADE');
    this.requireIndex('note_property_documents', ['project_root', 'projected_revision'], false);
    this.requireCheck('note_property_documents', 'CHECK (projected_revision >= 1)');
    this.requireCheck(
      'note_property_documents',
      "CHECK (status IN ('valid', 'invalid', 'unsupported'))",
    );

    this.requireColumns('note_properties', {
      note_id: { type: 'TEXT', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      key: { type: 'TEXT', notNull: true },
      normalized_key: { type: 'TEXT', notNull: true },
      type: { type: 'TEXT', notNull: true },
      value_json: { type: 'TEXT', notNull: true },
      value_text: { type: 'TEXT', notNull: false },
      value_number: { type: 'REAL', notNull: false },
      value_boolean: { type: 'INTEGER', notNull: false },
      note_revision: { type: 'INTEGER', notNull: true },
    });
    this.requireCompositePrimaryKey('note_properties', ['note_id', 'normalized_key']);
    this.requireForeignKey('note_properties', 'note_id', 'notes', 'id', 'CASCADE');
    this.requireIndex('note_properties', ['project_root', 'normalized_key', 'value_text'], false);
    this.requireIndex('note_properties', ['project_root', 'normalized_key', 'value_number'], false);
    this.requireIndex(
      'note_properties',
      ['project_root', 'normalized_key', 'value_boolean'],
      false,
    );

    this.requireColumns('note_property_items', {
      note_id: { type: 'TEXT', notNull: true },
      normalized_key: { type: 'TEXT', notNull: true },
      ordinal: { type: 'INTEGER', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      value_text: { type: 'TEXT', notNull: true },
      normalized_text: { type: 'TEXT', notNull: true },
    });
    this.requireCompositePrimaryKey('note_property_items', [
      'note_id',
      'normalized_key',
      'ordinal',
    ]);
    this.requireForeignKey('note_property_items', 'note_id', 'notes', 'id', 'CASCADE');
    this.requireIndex(
      'note_property_items',
      ['project_root', 'normalized_key', 'normalized_text'],
      false,
    );

    this.requireColumns('note_property_schemas', {
      project_root: { type: 'TEXT', notNull: true },
      normalized_key: { type: 'TEXT', notNull: true },
      display_name: { type: 'TEXT', notNull: true },
      kind: { type: 'TEXT', notNull: true },
      revision: { type: 'INTEGER', notNull: true, defaultValue: '1' },
      usage_count: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      invalid_count: { type: 'INTEGER', notNull: true, defaultValue: '0' },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCompositePrimaryKey('note_property_schemas', ['project_root', 'normalized_key']);

    this.requireColumns('note_bases', {
      id: { type: 'TEXT', primaryKey: true },
      principal_id: { type: 'TEXT', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      name: { type: 'TEXT', notNull: true },
      definition: { type: 'TEXT', notNull: true },
      revision: { type: 'INTEGER', notNull: true, defaultValue: '1' },
      trashed_at: { type: 'INTEGER', notNull: false },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireForeignKey('note_bases', 'principal_id', 'note_draft_principals', 'id', 'RESTRICT');
    this.requireIndex('note_bases', ['principal_id', 'project_root', 'name'], true);
    this.requireIndex('note_bases', ['principal_id', 'project_root', 'updated_at'], false);

    this.requireColumns('note_base_revisions', {
      base_id: { type: 'TEXT', notNull: true },
      revision: { type: 'INTEGER', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      operation: { type: 'TEXT', notNull: true },
      name: { type: 'TEXT', notNull: true },
      definition: { type: 'TEXT', notNull: true },
      trashed_at: { type: 'INTEGER', notNull: false },
      base_created_at: { type: 'INTEGER', notNull: true },
      base_updated_at: { type: 'INTEGER', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCompositePrimaryKey('note_base_revisions', ['base_id', 'revision']);
    this.requireForeignKey('note_base_revisions', 'base_id', 'note_bases', 'id', 'CASCADE');
    this.requireIndex('note_base_revisions', ['project_root', 'base_id', 'revision'], false);

    const principalCount = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM note_draft_principals WHERE kind = 'local'",
      )
      .get()?.count;
    if (principalCount !== 1) {
      throw new Error(
        'Migration postcondition failed: note_draft_principals needs one stable local owner',
      );
    }
  }

  private validateVaultRestoreCommitSchema(): void {
    this.requireColumns('note_vault_restore_commits', {
      archive_sha256: { type: 'TEXT', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      manifest_sha256: { type: 'TEXT', notNull: true },
      plan_token: { type: 'TEXT', notNull: true },
      committed_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCompositePrimaryKey('note_vault_restore_commits', [
      'archive_sha256',
      'project_root',
    ]);
    this.requireIndex('note_vault_restore_commits', ['project_root', 'committed_at'], false);
    this.requireCheck('note_vault_restore_commits', 'CHECK (length(archive_sha256) = 64)');
    this.requireCheck('note_vault_restore_commits', 'CHECK (length(manifest_sha256) = 64)');
    this.requireCheck('note_vault_restore_commits', 'CHECK (length(plan_token) = 64)');
  }

  private validateFeedPersistenceSchema(): void {
    this.requireColumns('session_feed_entries', {
      id: { type: 'TEXT', primaryKey: true },
      session_id: { type: 'TEXT', notNull: true },
      kind: { type: 'TEXT', notNull: true },
      text: { type: 'TEXT', notNull: true },
      timestamp: { type: 'INTEGER', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCascadeForeignKey('session_feed_entries', 'session_id');
    this.requireIndex('session_feed_entries', ['session_id', 'timestamp'], false);
    this.requireCheck('session_feed_entries', "CHECK (kind IN ('client_error'))");
    this.requireCheck('session_feed_entries', 'CHECK (length(text) BETWEEN 1 AND 16384)');

    this.requireColumns('session_feed_tombstones', {
      session_id: { type: 'TEXT', notNull: true },
      target_key: { type: 'TEXT', notNull: true },
      visibility: { type: 'TEXT', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
    });
    this.requireCompositePrimaryKey('session_feed_tombstones', ['session_id', 'target_key']);
    this.requireCascadeForeignKey('session_feed_tombstones', 'session_id');
    this.requireIndex('session_feed_tombstones', ['session_id', 'updated_at'], false);
    this.requireCheck('session_feed_tombstones', "CHECK (visibility IN ('hidden', 'deleted'))");
    this.requireCheck('session_feed_tombstones', 'CHECK (length(target_key) BETWEEN 1 AND 512)');
  }

  private validateSessionTurnCommandSchema(): void {
    this.requireColumns('session_turn_commands', {
      command_key: { type: 'TEXT', primaryKey: true },
      session_id: { type: 'TEXT', notNull: true },
      source: { type: 'TEXT', notNull: true },
      source_command_id: { type: 'TEXT', notNull: true },
      input_hash: { type: 'TEXT', notNull: true },
      user_message_id: { type: 'TEXT', notNull: true },
      response_message_id: { type: 'TEXT', notNull: true },
      run_id: { type: 'TEXT', notNull: true },
      status: { type: 'TEXT', notNull: true },
      terminal_reason: { type: 'TEXT', notNull: false },
      created_at: { type: 'INTEGER', notNull: true },
      updated_at: { type: 'INTEGER', notNull: true },
      finished_at: { type: 'INTEGER', notNull: false },
    });
    this.requireCascadeForeignKey('session_turn_commands', 'session_id');
    this.requireIndex('session_turn_commands', ['session_id', 'source', 'source_command_id'], true);
    this.requireIndex('session_turn_commands', ['user_message_id'], true);
    this.requireIndex('session_turn_commands', ['response_message_id'], true);
    this.requireIndex('session_turn_commands', ['run_id'], true);
    this.requireIndex('session_turn_commands', ['session_id', 'status', 'updated_at'], false);
    this.requireCheck(
      'session_turn_commands',
      "CHECK (source IN ('goal', 'collaboration', 'internal'))",
    );
    this.requireCheck(
      'session_turn_commands',
      "CHECK (status IN ('active', 'completed', 'failed', 'cancelled', 'waiting'))",
    );
    this.requireCheck(
      'session_turn_commands',
      "CHECK (length(command_key) = 40 AND command_key NOT GLOB '*[^0-9a-f]*')",
    );
    this.requireCheck(
      'session_turn_commands',
      'CHECK (length(source_command_id) BETWEEN 1 AND 512)',
    );
    this.requireCheck(
      'session_turn_commands',
      "CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*')",
    );
    this.requireCheck(
      'session_turn_commands',
      "CHECK (user_message_id = 'command-user-' || command_key)",
    );
    this.requireCheck(
      'session_turn_commands',
      "CHECK (response_message_id = 'command-response-' || command_key)",
    );
    this.requireCheck('session_turn_commands', 'CHECK (length(run_id) BETWEEN 1 AND 128)');
    this.requireCheck(
      'session_turn_commands',
      'CHECK (created_at >= 0 AND updated_at >= created_at)',
    );
    this.requireCheck(
      'session_turn_commands',
      'CHECK (finished_at IS NULL OR finished_at >= created_at)',
    );
    this.requireCheck(
      'session_turn_commands',
      "status IN ('active', 'waiting') AND terminal_reason IS NULL AND finished_at IS NULL",
    );
    this.requireCheck(
      'session_turn_commands',
      "status IN ('completed', 'failed', 'cancelled') AND terminal_reason IS NOT NULL",
    );
    this.requireCheck('session_turn_commands', 'length(trim(terminal_reason)) BETWEEN 1 AND 2048');
    this.requireCheck('session_turn_commands', 'AND finished_at IS NOT NULL');
  }

  private validateSessionArchiveSchema(): void {
    this.requireColumns('sessions', { archived_at: { type: 'INTEGER' } });
    const requirePartialIndex = (name: string, expected: string) => {
      const sql = this.getSchemaSql('index', name);
      const normalized = (sql ?? '').toLowerCase().replace(/["`\s]/g, '');
      if (!normalized.includes(expected.toLowerCase().replace(/["`\s]/g, ''))) {
        throw new Error(`Migration postcondition failed: index ${name} has the wrong shape`);
      }
    };
    requirePartialIndex(
      'idx_sessions_active_updated',
      'ON sessions(updated_at DESC) WHERE archived_at IS NULL',
    );
    requirePartialIndex(
      'idx_sessions_archived_at',
      'ON sessions(archived_at DESC) WHERE archived_at IS NOT NULL',
    );
  }

  private validateNotesDataTrustSchema(): void {
    this.requireColumns('notes', {
      trashed_at: { type: 'INTEGER', notNull: false },
      trash_reason: { type: 'TEXT', notNull: false },
    });
    this.requireColumns('note_revisions', {
      note_id: { type: 'TEXT', notNull: true },
      revision: { type: 'INTEGER', notNull: true },
      project_root: { type: 'TEXT', notNull: true },
      operation: { type: 'TEXT', notNull: true },
      title: { type: 'TEXT', notNull: true },
      content: { type: 'TEXT', notNull: true },
      content_bytes: { type: 'INTEGER', notNull: true },
      folder_path: { type: 'TEXT', notNull: true },
      tags: { type: 'TEXT', notNull: true },
      pinned: { type: 'INTEGER', notNull: true },
      include_in_context: { type: 'INTEGER', notNull: true },
      format: { type: 'TEXT', notNull: true },
      source_path: { type: 'TEXT', notNull: false },
      trashed_at: { type: 'INTEGER', notNull: false },
      trash_reason: { type: 'TEXT', notNull: false },
      note_created_at: { type: 'INTEGER', notNull: true },
      note_updated_at: { type: 'INTEGER', notNull: true },
      created_at: { type: 'INTEGER', notNull: true },
    });
    this.requireIndex('notes', ['project_root', 'trashed_at', 'updated_at'], false);
    this.requireIndex('note_revisions', ['note_id', 'revision'], true);
    this.requireIndex('note_revisions', ['project_root', 'note_id', 'revision'], false);
    const revisionForeignKeys = this.db
      .query(`PRAGMA foreign_key_list(${this.quoteIdentifier('note_revisions')})`)
      .all() as SqliteForeignKey[];
    if (
      !revisionForeignKeys.some(
        (foreignKey) =>
          foreignKey.table === 'notes' &&
          foreignKey.from === 'note_id' &&
          foreignKey.to === 'id' &&
          foreignKey.on_delete.toUpperCase() === 'CASCADE',
      )
    ) {
      throw new Error(
        'Migration postcondition failed: note_revisions.note_id must cascade to notes.id',
      );
    }
    const missingBaselines = this.db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count
         FROM notes
         LEFT JOIN note_revisions
           ON note_revisions.note_id = notes.id
          AND note_revisions.revision = notes.revision
         WHERE note_revisions.note_id IS NULL`,
      )
      .get()?.count;
    if ((missingBaselines ?? 0) !== 0) {
      throw new Error('Migration postcondition failed: not every note has a current revision');
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.getSchemaSql('table', table)) {
      throw new Error(`Cannot add ${table}.${column}: table ${table} does not exist`);
    }
    if (!this.getColumns(table).some((candidate) => candidate.name === column)) {
      this.db.exec(
        `ALTER TABLE ${this.quoteIdentifier(table)} ADD COLUMN ${this.quoteIdentifier(column)} ${definition};`,
      );
    }
  }

  private applyContinuationMigration(): void {
    this.addColumnIfMissing('session_runs', 'continuation_id', 'TEXT');
    this.addColumnIfMissing('user_inputs', 'run_id', 'TEXT');
    this.addColumnIfMissing('user_inputs', 'run_revision', 'INTEGER');
    this.addColumnIfMissing('user_inputs', 'status', 'TEXT');
    this.addColumnIfMissing('session_run_events', 'dead_letter_reason', 'TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_run_continuations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        wait_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, run_id, wait_revision),
        CHECK (kind IN ('user_question', 'process_set')),
        CHECK (state IN ('pending', 'ready', 'claimed', 'consumed', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_continuations_state
        ON session_run_continuations(state, updated_at);
      INSERT OR IGNORE INTO session_runs (
        session_id, run_id, revision, phase, status, waiting_reason,
        continuation_id, active_agent_ids, started_at, updated_at,
        finished_at, terminal_reason
      )
      SELECT
        id, NULL, 0, 'idle', 'idle', '', NULL, '[]', NULL,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL
      FROM sessions;
      CREATE TRIGGER IF NOT EXISTS trg_sessions_seed_session_run
      AFTER INSERT ON sessions
      BEGIN
        INSERT OR IGNORE INTO session_runs (
          session_id, run_id, revision, phase, status, waiting_reason,
          continuation_id, active_agent_ids, started_at, updated_at,
          finished_at, terminal_reason
        ) VALUES (
          NEW.id, NULL, 0, 'idle', 'idle', '', NULL, '[]', NULL,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, NULL
        );
      END;
    `);
  }

  private applyContinuationProcessMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_run_continuation_processes (
        continuation_id TEXT NOT NULL,
        process_id TEXT NOT NULL,
        PRIMARY KEY (continuation_id, process_id),
        FOREIGN KEY(continuation_id)
          REFERENCES session_run_continuations(id) ON DELETE CASCADE,
        FOREIGN KEY(process_id)
          REFERENCES supervised_processes(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_session_run_continuation_processes_process
        ON session_run_continuation_processes(process_id, continuation_id);
    `);

    // Process tables are initialized by the supervisor after core migrations
    // on a brand-new database. That ordering is safe only when no legacy wait
    // exists to backfill; an upgrade with a live wait must already have its
    // durable process parent available.
    if (!this.getSchemaSql('table', 'supervised_processes')) {
      const liveContinuations =
        this.db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count
             FROM session_run_continuations
             WHERE kind = 'process_set' AND state IN ('pending', 'ready', 'claimed')`,
          )
          .get()?.count ?? 0;
      if (liveContinuations !== 0) {
        throw new Error('Cannot backfill live process continuations without supervised_processes');
      }
      return;
    }

    this.db.exec(`
      DELETE FROM session_run_continuation_processes
      WHERE NOT EXISTS (
        SELECT 1
        FROM session_run_continuations AS continuation
        WHERE continuation.id = session_run_continuation_processes.continuation_id
          AND continuation.kind = 'process_set'
          AND continuation.state IN ('pending', 'ready', 'claimed')
      );

      INSERT OR IGNORE INTO session_run_continuation_processes (continuation_id, process_id)
      SELECT continuation.id, CAST(process.value AS TEXT)
      FROM session_run_continuations AS continuation
      JOIN json_each(
        CASE WHEN json_valid(continuation.payload)
          THEN continuation.payload ELSE '{"processIds":[]}' END,
        '$.processIds'
      ) AS process
      JOIN supervised_processes AS supervised
        ON supervised.id = CAST(process.value AS TEXT)
       AND supervised.session_id = continuation.session_id
      WHERE continuation.kind = 'process_set'
        AND continuation.state IN ('pending', 'ready', 'claimed')
        AND process.type = 'text'
        AND length(CAST(process.value AS TEXT)) > 0;
    `);
  }

  private foreignKeyDirectives(sql: string): Array<'ON' | 'OFF'> {
    return Array.from(sql.matchAll(/PRAGMA\s+foreign_keys\s*=\s*(ON|OFF)\s*;/gi)).map(
      (match) => match[1]!.toUpperCase() as 'ON' | 'OFF',
    );
  }

  private transactionBody(sql: string): string {
    // A few early migrations carried their own transaction and foreign-key
    // pragmas. The runner owns both now so schema work and the ledger row are
    // one atomic commit.
    return sql
      .replace(/^\s*BEGIN\s+TRANSACTION\s*;\s*$/gim, '')
      .replace(/^\s*COMMIT\s*;\s*$/gim, '')
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)\s*;\s*$/gim, '');
  }

  private validateMigrationPostconditions(migration: Migration): void {
    if (migration.version === '0032') this.validateSessionRunSchema();
    if (migration.version === '0033') this.validateContinuationSchema();
    if (migration.version === '0034') this.validateNotesDataTrustSchema();
    if (migration.version === '0036') this.validateSessionArchiveSchema();
    if (migration.version === '0037') this.validateContinuationProcessSchema();
    if (migration.version === '0038') this.validateRestartHandoffSchema();
    if (migration.version === '0039') this.validateNotesWorkspaceSchema();
    if (migration.version === '0040') this.validateProcessSupervisorSchema();
    if (migration.version === '0041') this.validateVaultRestoreCommitSchema();
    if (migration.version === '0042') this.validateFeedPersistenceSchema();
    if (migration.version === '0043') this.validateSessionTurnCommandSchema();
  }

  /**
   * A ledger row proves only that a migration committed once. It does not
   * prove that the schema is still intact on a later startup. Re-run every
   * declared postcondition while holding a reserved writer lock so another
   * backend process cannot alter the schema between reading the ledger and
   * completing the attestation.
   */
  private attestAppliedMigrationPostconditions(): void {
    let transactionOpen = false;

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;

      const records = this.db
        .query<MigrationRecord, []>(
          `SELECT version, description, applied_at AS appliedAt, checksum
           FROM ${this.migrationsTable} ORDER BY version`,
        )
        .all();

      for (const record of records) {
        const migration = MIGRATIONS.find((candidate) => candidate.version === record.version);
        if (!migration) continue;
        this.assertStoredChecksum(record, migration);
        this.validateMigrationPostconditions(migration);
      }

      this.db.exec('COMMIT;');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen || this.db.inTransaction) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // Preserve the attestation failure that explains the damaged schema.
        }
      }
      throw error;
    }
  }

  /**
   * Apply a single migration
   */
  async applyMigration(migration: Migration): Promise<boolean> {
    const checksum = this.calculateChecksum(migration);
    const foreignKeyMode = Boolean(
      this.db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys,
    );
    const foreignKeyDirectives = this.foreignKeyDirectives(migration.up);
    let transactionOpen = false;

    serverLog.info(
      { version: migration.version, description: migration.description },
      'Applying migration',
    );

    try {
      if (foreignKeyDirectives[0]) {
        this.db.exec(`PRAGMA foreign_keys = ${foreignKeyDirectives[0]};`);
      }
      this.db.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;

      // getPendingMigrations() is only a hint. Another desktop/backend process
      // may have committed this version while this runner waited for the write
      // lock, so recheck under the lock before touching schema.
      const existing = this.db
        .query<MigrationRecord, [string]>(
          `SELECT version, description, applied_at AS appliedAt, checksum
           FROM ${this.migrationsTable} WHERE version = ?`,
        )
        .get(migration.version);
      if (existing) {
        this.assertStoredChecksum(existing, migration);
        this.validateMigrationPostconditions(migration);
        this.db.exec('COMMIT;');
        transactionOpen = false;
        if (foreignKeyDirectives.at(-1)) {
          this.db.exec(`PRAGMA foreign_keys = ${foreignKeyDirectives.at(-1)};`);
        }
        serverLog.info(
          { version: migration.version },
          'Migration already applied by another runner',
        );
        return false;
      }

      // SQLite has no portable `ADD COLUMN IF NOT EXISTS`. These durability
      // migrations may encounter databases where Drizzle/bootstrap created
      // the column before the migration ledger was introduced, so inspect the
      // real schema and apply only the missing part. This preserves existing
      // data and still records the unchanged migration/checksum.
      if (migration.version === '0022') {
        const columns = this.db.query(`PRAGMA table_info(sessions)`).all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'conversation_revision')) {
          this.db.exec(migration.up);
        }
      } else if (migration.version === '0023') {
        const columns = this.db.query(`PRAGMA table_info(messages)`).all() as Array<{
          name: string;
        }>;
        if (!columns.some((column) => column.name === 'context_revision')) {
          this.db.exec(
            'ALTER TABLE messages ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;',
          );
        }
        this.db.exec(
          migration.up.replace(
            'ALTER TABLE messages ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;',
            '',
          ),
        );
      } else if (migration.version === '0025') {
        const table = this.db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ordered_session_events'",
          )
          .get();
        if (table) {
          const columns = this.db
            .query(`PRAGMA table_info(ordered_session_events)`)
            .all() as Array<{ name: string }>;
          if (!columns.some((column) => column.name === 'parent_sequence')) {
            this.db.exec(migration.up);
          }
        }
      } else if (migration.version === '0026') {
        // Some developer databases are bootstrapped from the current Drizzle
        // schema before their migration ledger is initialized. Add only the
        // missing columns, then run the same lossless backfill either way.
        const sessionColumns = this.db.query(`PRAGMA table_info(sessions)`).all() as Array<{
          name: string;
        }>;
        const messageColumns = this.db.query(`PRAGMA table_info(messages)`).all() as Array<{
          name: string;
        }>;
        const providerRevisionWasMissing = !sessionColumns.some(
          (column) => column.name === 'provider_conversation_revision',
        );
        if (!sessionColumns.some((column) => column.name === 'active_message_id')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN active_message_id TEXT;');
        }
        if (providerRevisionWasMissing) {
          this.db.exec(
            'ALTER TABLE sessions ADD COLUMN provider_conversation_revision INTEGER DEFAULT 0;',
          );
        }
        if (!messageColumns.some((column) => column.name === 'parent_message_id')) {
          this.db.exec('ALTER TABLE messages ADD COLUMN parent_message_id TEXT;');
        }
        this.db.exec(
          providerRevisionWasMissing
            ? `UPDATE sessions
               SET provider_conversation_revision = COALESCE(conversation_revision, 0);`
            : `UPDATE sessions
               SET provider_conversation_revision = COALESCE(conversation_revision, 0)
               WHERE provider_conversation_revision IS NULL;`,
        );
        this.db.exec(`
          WITH ordered_messages AS (
            SELECT
              id,
              LAG(id) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS parent_id
            FROM messages
          )
          UPDATE messages
          SET parent_message_id = (
            SELECT parent_id FROM ordered_messages WHERE ordered_messages.id = messages.id
          )
          WHERE messages.session_id IN (
            SELECT id FROM sessions WHERE active_message_id IS NULL
          );

          UPDATE sessions
          SET active_message_id = (
            SELECT id
            FROM messages
            WHERE messages.session_id = sessions.id
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
          )
          WHERE active_message_id IS NULL
            AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id);

          CREATE INDEX IF NOT EXISTS idx_messages_session_parent
            ON messages(session_id, parent_message_id);
        `);
      } else if (migration.version === '0027') {
        // Current-schema bootstrap databases may already have either column.
        // Finish an interrupted migration one additive step at a time without
        // rewriting or dropping any existing note content.
        const noteColumns = this.db.query(`PRAGMA table_info(notes)`).all() as Array<{
          name: string;
        }>;
        if (!noteColumns.some((column) => column.name === 'project_root')) {
          this.db.exec('ALTER TABLE notes ADD COLUMN project_root TEXT;');
        }
        if (!noteColumns.some((column) => column.name === 'revision')) {
          this.db.exec('ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;');
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_notes_project_root ON notes(project_root);');
      } else if (migration.version === '0033') {
        this.applyContinuationMigration();
      } else if (migration.version === '0034') {
        // Finish interrupted/current-schema bootstraps additively. The baseline
        // INSERT is idempotent and never overwrites an existing historical state.
        const noteColumns = this.db.query(`PRAGMA table_info(notes)`).all() as Array<{
          name: string;
        }>;
        if (!noteColumns.some((column) => column.name === 'trashed_at')) {
          this.db.exec('ALTER TABLE notes ADD COLUMN trashed_at INTEGER;');
        }
        if (!noteColumns.some((column) => column.name === 'trash_reason')) {
          this.db.exec('ALTER TABLE notes ADD COLUMN trash_reason TEXT;');
        }
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS note_revisions (
            note_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            project_root TEXT NOT NULL,
            operation TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            content_bytes INTEGER NOT NULL,
            folder_path TEXT NOT NULL,
            tags TEXT NOT NULL,
            pinned INTEGER NOT NULL,
            include_in_context INTEGER NOT NULL,
            format TEXT NOT NULL,
            source_path TEXT,
            trashed_at INTEGER,
            trash_reason TEXT,
            note_created_at INTEGER NOT NULL,
            note_updated_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (note_id, revision),
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_notes_project_trash
            ON notes(project_root, trashed_at, updated_at DESC);
          CREATE INDEX IF NOT EXISTS idx_note_revisions_project_note
            ON note_revisions(project_root, note_id, revision DESC);
          INSERT OR IGNORE INTO note_revisions (
            note_id, revision, project_root, operation, title, content, content_bytes,
            folder_path, tags, pinned, include_in_context, format, source_path,
            trashed_at, trash_reason, note_created_at, note_updated_at, created_at
          )
          SELECT
            id, revision, COALESCE(project_root, ''), 'update', title, content,
            length(CAST(content AS BLOB)), folder_path, tags, pinned,
            include_in_context, format, NULL, trashed_at, trash_reason,
            created_at, updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000
          FROM notes;
        `);
      } else if (migration.version === '0036') {
        // Current-schema bootstrap or an interrupted migration may already
        // contain the marker. Add only what is missing and never rewrite an
        // existing archive timestamp.
        const sessionColumns = this.db.query(`PRAGMA table_info(sessions)`).all() as Array<{
          name: string;
        }>;
        if (!sessionColumns.some((column) => column.name === 'archived_at')) {
          this.db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER;');
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_sessions_active_updated
            ON sessions(updated_at DESC) WHERE archived_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_sessions_archived_at
            ON sessions(archived_at DESC) WHERE archived_at IS NOT NULL;
        `);
      } else if (migration.version === '0037') {
        this.applyContinuationProcessMigration();
      } else {
        this.db.exec(this.transactionBody(migration.up));
      }

      // A CREATE TABLE IF NOT EXISTS against a malformed pre-existing table is
      // not success. Prove the contract before making it durable in the ledger.
      this.validateMigrationPostconditions(migration);

      this.db.run(
        `INSERT INTO ${this.migrationsTable} (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)`,
        [migration.version, migration.description, Date.now(), checksum],
      );

      this.db.exec('COMMIT;');
      transactionOpen = false;
      if (foreignKeyDirectives.at(-1)) {
        this.db.exec(`PRAGMA foreign_keys = ${foreignKeyDirectives.at(-1)};`);
      }

      serverLog.info({ version: migration.version }, 'Migration applied successfully');
      return true;
    } catch (error) {
      if (transactionOpen || this.db.inTransaction) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // Preserve the original migration failure.
        }
      }
      this.db.exec(`PRAGMA foreign_keys = ${foreignKeyMode ? 'ON' : 'OFF'};`);
      serverLog.error({ version: migration.version, error }, 'Migration failed');
      throw error;
    }
  }

  /**
   * Rollback a single migration
   */
  async rollbackMigration(migration: Migration): Promise<void> {
    if (!migration.down) {
      throw new Error(`Migration ${migration.version} does not support rollback`);
    }

    serverLog.info(
      { version: migration.version, description: migration.description },
      'Rolling back migration',
    );

    try {
      // Execute the rollback SQL
      this.db.exec(migration.down);

      // Remove the migration record
      this.db.run(`DELETE FROM ${this.migrationsTable} WHERE version = ?`, [migration.version]);

      serverLog.info({ version: migration.version }, 'Migration rolled back successfully');
    } catch (error) {
      serverLog.error({ version: migration.version, error }, 'Migration rollback failed');
      throw error;
    }
  }

  /**
   * Run all pending migrations
   */
  async migrate(): Promise<number> {
    this.attestAppliedMigrationPostconditions();
    const pending = this.getPendingMigrations();

    if (pending.length === 0) {
      serverLog.info('No pending migrations');
      return 0;
    }

    serverLog.info({ count: pending.length }, 'Running pending migrations');

    let applied = 0;
    for (const migration of pending) {
      if (await this.applyMigration(migration)) applied += 1;
    }

    return applied;
  }

  /**
   * Rollback the last N migrations
   */
  async rollback(count: number = 1): Promise<number> {
    const applied = this.getAppliedMigrations();
    const toRollback = applied.slice(-count);

    if (toRollback.length === 0) {
      serverLog.info('No migrations to rollback');
      return 0;
    }

    serverLog.info({ count: toRollback.length }, 'Rolling back migrations');

    // Rollback in reverse order
    for (const record of toRollback.reverse()) {
      const migration = MIGRATIONS.find((m) => m.version === record.version);
      if (migration) {
        await this.rollbackMigration(migration);
      }
    }

    return toRollback.length;
  }

  /**
   * Get migration status
   */
  getStatus(): {
    applied: MigrationRecord[];
    pending: Migration[];
    currentVersion: string | null;
  } {
    const applied = this.getAppliedMigrations();
    const pending = this.getPendingMigrations();
    const currentVersion = applied.length > 0 ? applied[applied.length - 1]!.version : null;

    return { applied, pending, currentVersion };
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Run migrations on database initialization
 */
export async function runMigrations(db: Database): Promise<void> {
  const runner = new MigrationRunner(db);
  const count = await runner.migrate();

  if (count > 0) {
    const status = runner.getStatus();
    serverLog.info(
      {
        migrationsApplied: count,
        currentVersion: status.currentVersion,
      },
      'Database migrations complete',
    );
  }
}
