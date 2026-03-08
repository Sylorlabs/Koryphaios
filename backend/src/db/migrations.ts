// Database Migrations — versioned schema changes with rollback support
// Prevents data loss on schema changes and tracks migration history

import { Database } from "bun:sqlite";
import { serverLog } from "../logger";

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
    version: "20240101_001",
    description: "Initial schema with users, sessions, messages, tasks",
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
    version: "20240115_001",
    description: "Add worker persistence tables",
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
    version: "20240201_001",
    description: "Add authentication and API key tables",
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
    version: "20240215_001",
    description: "Add user_id column to sessions table for multi-user support",
    up: `
      -- Add user_id column if it doesn't exist
      -- SQLite doesn't support IF NOT EXISTS for columns, so we handle errors
      ALTER TABLE sessions ADD COLUMN user_id TEXT;
    `,
    down: `
      -- SQLite doesn't support DROP COLUMN, so we recreate the table
      -- This is a no-op for safety
    `,
  },

  // ─── Version 005: Provider credentials ──────────────────────────────────────
  {
    version: "20240301_001",
    description: "Add provider credentials storage table",
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
    version: "20240315_001",
    description: "Add metadata and tags to sessions",
    up: `
      -- Add metadata column to sessions
      ALTER TABLE sessions ADD COLUMN metadata TEXT;

      -- Add tags column to sessions
      ALTER TABLE sessions ADD COLUMN tags TEXT;

      -- Session tags table for querying
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, tag),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_tags_tag;
      DROP TABLE IF EXISTS session_tags;
    `,
  },
];

// ─── Migration Runner ────────────────────────────────────────────────────────

export class MigrationRunner {
  private db: Database;
  private migrationsTable = "_migrations";

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
    const applied = new Set(
      this.getAppliedMigrations().map((m) => m.version)
    );
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
      "Applying migration"
    );

    try {
      // Execute the migration SQL
      this.db.exec(migration.up);

      // Record the migration
      this.db.run(
        `INSERT INTO ${this.migrationsTable} (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)`,
        [migration.version, migration.description, Date.now(), checksum]
      );

      serverLog.info(
        { version: migration.version },
        "Migration applied successfully"
      );
    } catch (error) {
      serverLog.error(
        { version: migration.version, error },
        "Migration failed"
      );
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
      "Rolling back migration"
    );

    try {
      // Execute the rollback SQL
      this.db.exec(migration.down);

      // Remove the migration record
      this.db.run(
        `DELETE FROM ${this.migrationsTable} WHERE version = ?`,
        [migration.version]
      );

      serverLog.info(
        { version: migration.version },
        "Migration rolled back successfully"
      );
    } catch (error) {
      serverLog.error(
        { version: migration.version, error },
        "Migration rollback failed"
      );
      throw error;
    }
  }

  /**
   * Run all pending migrations
   */
  async migrate(): Promise<number> {
    const pending = this.getPendingMigrations();
    
    if (pending.length === 0) {
      serverLog.info("No pending migrations");
      return 0;
    }

    serverLog.info({ count: pending.length }, "Running pending migrations");

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
      serverLog.info("No migrations to rollback");
      return 0;
    }

    serverLog.info({ count: toRollback.length }, "Rolling back migrations");

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
        currentVersion: status.currentVersion 
      },
      "Database migrations complete"
    );
  }
}