import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import { serverLog } from "../logger";

let db: Database;

export function initDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "koryphaios.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Users table (required for getOrCreateLocalUser / auth)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);

  // Create tables
  db.run(`
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
    )
  `);

  // Add user_id if missing (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`);
  } catch {
    // Column already exists
  }

  db.run(`
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      domain TEXT,
      status TEXT DEFAULT 'pending', -- pending, active, done, failed, interrupted
      plan TEXT,
      assigned_model TEXT,
      allowed_paths TEXT,
      result TEXT,
      error TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Active workers table for persistence
  db.run(`
    CREATE TABLE IF NOT EXISTS active_workers (
      session_id TEXT NOT NULL,
      task_id TEXT PRIMARY KEY,
      task_data TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Abort controllers table for persistence
  db.run(`
    CREATE TABLE IF NOT EXISTS abort_controllers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // User inputs table for persistence
  db.run(`
    CREATE TABLE IF NOT EXISTS user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Session changes log for tracking modifications
  db.run(`
    CREATE TABLE IF NOT EXISTS session_changes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      change_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Refresh tokens table (for JWT refresh token persistence)
  db.run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // API keys table (for programmatic access)
  db.run(`
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
    )
  `);

  // Audit logs table
  db.run(`
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
    )
  `);

  // Create indexes for better query performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_active_workers_session ON active_workers(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_abort_controllers_session ON abort_controllers(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_user_inputs_session ON user_inputs(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_session_changes_session ON session_changes(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`);

  serverLog.info({ dbPath }, "Database initialized (SQLite/WAL)");
}

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
