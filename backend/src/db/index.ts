import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
import path from 'path';
import { runMigrations } from './migrations';
import { ensureSecureDir, hardenFilePermissions } from '../security/fs-permissions';
import { serverLog } from '../logger';

// Get database path from env or default to data/ directory.
// Handle both `sqlite://path` (URL form) and `sqlite:path` (test-runner form).
// On Windows, the path after `sqlite:` is a drive path like `C:\Users\...`
// which does not start with `/`, so `sqlite://` won't match — strip any
// `sqlite:` prefix instead.
const dbPath =
  process.env.DATABASE_URL?.replace(/^sqlite:\/\//, '').replace(/^sqlite:/, '') ||
  'data/koryphaios.db';
// First run (packaged app: cwd = per-user data dir): the data/ folder does not
// exist yet and SQLite refuses to create intermediate directories itself.
// The DB and its WAL/SHM sidecars contain sessions, notes, and billing data —
// tighten the directory to 0o700 so other local users can't list or read them.
try {
  const { dirname } = require('node:path') as typeof import('node:path');
  if (dirname(dbPath) !== '.') ensureSecureDir(dirname(dbPath));
} catch (err: unknown) {
  serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to secure database directory');
}

// Create bun:sqlite database instance
const sqlite = new Database(dbPath);

// SQLite creates the .db file with the process umask (often 0o644 —
// world-readable). The DB holds sessions, notes, and billing rows; tighten
// it to 0o600. WAL/SHM sidecars are created by the next PRAGMA; harden them
// after they exist.
hardenFilePermissions(dbPath);

// Enable WAL mode for better concurrent performance
sqlite.exec('PRAGMA journal_mode = WAL;');
// Foreign-key enforcement is connection-local in SQLite. A migration-time
// PRAGMA does not survive process restart, so enable it for every live DB
// connection before Drizzle performs any writes.
sqlite.exec('PRAGMA foreign_keys = ON;');

// Harden the WAL/SHM sidecars that WAL mode just created.
hardenFilePermissions(`${dbPath}-wal`);
hardenFilePermissions(`${dbPath}-shm`);

// Create and export drizzle instance
export const db = drizzle(sqlite, { schema });

// Export everything needed for database operations
export * from './schema';

// Backward compatibility for bootstrap layer
export async function initDb() {
  // Migrations can be run here if needed
  await runMigrations(sqlite);
  return db;
}

export function getDb() {
  return sqlite;
}

export function getDatabase() {
  return db;
}
