/**
 * Side-channel SQLite access for seeding the live Playwright database.
 *
 * Playwright runs spec files under Node, so this helper has to work under
 * Node's ABI. It prefers the `node:sqlite` built-in (present since Node 22.5,
 * experimental) precisely because that needs no compiled addon.
 *
 * `better-sqlite3` is kept only as a fallback. It is a backend dependency with
 * a prebuilt binding, but that binding is compiled for **Bun's** ABI: `bun -e
 * 'process.versions.modules'` reports `137`, while the Node binaries on this
 * machine report `127` (22.22.2) and `147` (26.8.1). Loading it under Node
 * therefore fails with:
 *
 *   The module '…/better_sqlite3.node' was compiled against a different
 *   Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
 *   requires NODE_MODULE_VERSION 127.
 *
 * The fallback still helps an environment whose addon matches its Node ABI, but
 * it cannot work here, so `node:sqlite` is tried first.
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

/**
 * Resolved through `backendRequire` rather than a bare `require` so it works
 * whatever module format the Playwright transform emits — builtin specifiers
 * resolve from any `createRequire` base.
 */
function openWithNodeSqlite(dbPath: string): SeedDatabase | null {
  try {
    const { DatabaseSync } = backendRequire('node:sqlite') as {
      DatabaseSync: new (path: string) => SeedDatabase;
    };
    return new DatabaseSync(dbPath);
  } catch {
    return null;
  }
}

function openWithBetterSqlite3(dbPath: string): SeedDatabase {
  const Database = backendRequire('better-sqlite3') as new (path: string) => SeedDatabase;
  return new Database(dbPath);
}

export function openSqlite(dbPath: string): SeedDatabase {
  return openWithNodeSqlite(dbPath) ?? openWithBetterSqlite3(dbPath);
}
