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

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
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

  serverLog.info({ dbPath }, "Database initialized (SQLite/WAL)");
}

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
