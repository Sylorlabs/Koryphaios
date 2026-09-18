/**
 * Side-channel SQLite access for seeding the live Playwright database.
 *
 * Playwright runs spec files under Node, and the CI runner's Node lacks the
 * `node:sqlite` built-in. `better-sqlite3` is already a backend dependency
 * with a prebuilt native binding, so resolve it from the backend package.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export interface SeedStatement {
  run(...params: unknown[]): unknown;
}

export interface SeedDatabase {
  prepare(sql: string): SeedStatement;
  close(): void;
}

const backendRequire = createRequire(resolve(__dirname, '../../backend/package.json'));

export function openSqlite(dbPath: string): SeedDatabase {
  const Database = backendRequire('better-sqlite3') as new (path: string) => SeedDatabase;
  return new Database(dbPath);
}
