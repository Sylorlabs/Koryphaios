import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
import { runMigrations } from './migrations';
import { hardenFilePermissions } from '../security/fs-permissions';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureDatabaseDirectory, resolveDatabasePath } from './database-path';

// Get database path from env or default to data/ directory.
// Handle both `sqlite://path` (URL form) and `sqlite:path` (test-runner form).
// On Windows, the path after `sqlite:` is a drive path like `C:\Users\...`
// which does not start with `/`, so `sqlite://` won't match — strip any
// `sqlite:` prefix instead.
const dbPath = resolveDatabasePath(PROJECT_ROOT);
// First run (packaged app: cwd = per-user data dir): the data/ folder does not
// exist yet and SQLite refuses to create intermediate directories itself.
// The DB and its WAL/SHM sidecars contain sessions, notes, and billing data —
// tighten the directory to 0o700 so other local users can't list or read them.
// A configured broad or loose parent is rejected here before SQLite can create
// a potentially world-readable database. Startup must fail closed rather than
// mutate /, HOME, a shared temp root, or another user-owned directory.
ensureDatabaseDirectory(dbPath);

// Create bun:sqlite database instance.
// We use a holder object so that `reopenDatabase()` can replace a closed
// Database with a fresh one pointing at the same path — tests that simulate
// persistence failures by calling `getDb().close()` need this to avoid
// breaking all subsequent tests in the same process.
const dbHolder: { sqlite: Database } = {
  sqlite: new Database(dbPath),
};

// SQLite creates the .db file with the process umask (often 0o644 —
// world-readable). The DB holds sessions, notes, and billing rows; tighten
// it to 0o600. WAL/SHM sidecars are created by the next PRAGMA; harden them
// after they exist.
hardenFilePermissions(dbPath);

// Enable WAL mode for better concurrent performance
dbHolder.sqlite.exec('PRAGMA journal_mode = WAL;');
// Foreign-key enforcement is connection-local in SQLite. A migration-time
// PRAGMA does not survive process restart, so enable it for every live DB
// connection before Drizzle performs any writes.
dbHolder.sqlite.exec('PRAGMA foreign_keys = ON;');
// Set a busy timeout so concurrent writers wait instead of immediately
// throwing "database is locked". 5 seconds is generous for a local DB.
dbHolder.sqlite.exec('PRAGMA busy_timeout = 5000;');

// Harden the WAL/SHM sidecars that WAL mode just created.
hardenFilePermissions(`${dbPath}-wal`);
hardenFilePermissions(`${dbPath}-shm`);

// Create and export drizzle instance
export const db = drizzle(dbHolder.sqlite, { schema });

// Export everything needed for database operations
export * from './schema';

// Backward compatibility for bootstrap layer
export async function initDb() {
  // Migrations can be run here if needed
  await runMigrations(dbHolder.sqlite);
  return db;
}

export function getDb() {
  return dbHolder.sqlite;
}

export function getDatabase() {
  return db;
}

/**
 * Reopen the database after a test has closed it. Tests that simulate
 * persistence failures by calling `getDb().close()` must call this in an
 * `afterEach` hook so subsequent tests in the same process don't inherit a
 * closed database. Creates a fresh Database, patches it into the drizzle
 * instance's internal session, and re-runs migrations.
 *
 * @param overridePath - Optional path to use instead of the original. Used by
 *   tests that need to point the shared `db` at a temp file (e.g.
 *   session-store-optimistic-locking.test.ts) without using `mock.module()`,
 *   which is process-wide and cannot be undone by `mock.restore()`.
 */
export async function reopenDatabase(overridePath?: string): Promise<void> {
  const path = overridePath ?? dbPath;
  // The old Database is already closed — create a fresh one.
  const fresh = new Database(path);
  fresh.exec('PRAGMA journal_mode = WAL;');
  fresh.exec('PRAGMA foreign_keys = ON;');
  fresh.exec('PRAGMA busy_timeout = 5000;');
  // Patch the drizzle instance's internal client and session so all
  // subsequent queries go through the new Database.
  (db as unknown as { $client: Database }).$client = fresh;
  const session = (db as unknown as { session?: { client?: Database } }).session;
  if (session) {
    session.client = fresh;
  }
  // Update the holder so getDb() returns the new Database.
  dbHolder.sqlite = fresh;
  await runMigrations(fresh);
}
