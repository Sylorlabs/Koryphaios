// Database Migrations — versioned schema changes with rollback support
// Prevents data loss on schema changes and tracks migration history

import { Database } from 'bun:sqlite';
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
];

// ─── Migration Runner ────────────────────────────────────────────────────────

export class MigrationRunner {
  private db: Database;
  private migrationsTable = '_migrations';

  constructor(db: Database) {
    this.db = db;
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
    return this.db
      .query<MigrationRecord, []>(`SELECT * FROM ${this.migrationsTable} ORDER BY version`)
      .all();
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
    // Simple hash of the up SQL
    const str = migration.up;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Apply a single migration
   */
  async applyMigration(migration: Migration): Promise<void> {
    const checksum = this.calculateChecksum(migration);

    serverLog.info(
      { version: migration.version, description: migration.description },
      'Applying migration',
    );

    try {
      // Execute the migration SQL
      this.db.exec(migration.up);

      // Record the migration
      this.db.run(
        `INSERT INTO ${this.migrationsTable} (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)`,
        [migration.version, migration.description, Date.now(), checksum],
      );

      serverLog.info({ version: migration.version }, 'Migration applied successfully');
    } catch (error) {
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
    const pending = this.getPendingMigrations();

    if (pending.length === 0) {
      serverLog.info('No pending migrations');
      return 0;
    }

    serverLog.info({ count: pending.length }, 'Running pending migrations');

    for (const migration of pending) {
      await this.applyMigration(migration);
    }

    return pending.length;
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
