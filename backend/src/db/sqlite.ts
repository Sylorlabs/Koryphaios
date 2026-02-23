import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { serverLog } from "../logger";
import { MigrationRunner } from "./migrations/runner";
import { fileURLToPath } from "url";

let db: Database;

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

export async function initDb(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "koryphaios.db");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL;");

  // Enable foreign keys
  db.exec("PRAGMA foreign_keys = ON;");

  // Run migrations
  const migrationsDir = join(__dirname, "migrations");
  const runner = new MigrationRunner(db, migrationsDir);
  await runner.migrate();

  serverLog.info({ dbPath }, "Database initialized (SQLite/WAL)");
}

export function getDb() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
