import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
import path from 'path';
import { runMigrations } from './migrations';

// Get database path from env or default to data/ directory
const dbPath = process.env.DATABASE_URL?.replace('sqlite://', '') || 'data/koryphaios.db';
// First run (packaged app: cwd = per-user data dir): the data/ folder does not
// exist yet and SQLite refuses to create intermediate directories itself.
try {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  const { dirname } = require('node:path') as typeof import('node:path');
  if (dirname(dbPath) !== '.') mkdirSync(dirname(dbPath), { recursive: true });
} catch { /* open below will surface real permission problems */ }

// Create bun:sqlite database instance
const sqlite = new Database(dbPath);

// Enable WAL mode for better concurrent performance
sqlite.exec('PRAGMA journal_mode = WAL;');

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
