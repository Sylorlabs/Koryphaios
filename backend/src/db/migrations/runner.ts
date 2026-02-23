/**
 * Database Migration Runner
 * 
 * Manages database schema migrations with:
 * - Version tracking in database
 * - Up/down migrations
 * - Transaction safety
 * - Logging
 */

import { Database } from "bun:sqlite";
import { serverLog } from "../../logger";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

interface MigrationRecord {
  version: number;
  name: string;
  applied_at: number;
}

export class MigrationRunner {
  private db: Database;
  private migrationsDir: string;

  constructor(db: Database, migrationsDir: string) {
    this.db = db;
    this.migrationsDir = migrationsDir;
  }

  /**
   * Initialize migration tracking table
   */
  async initialize(): Promise<void> {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    
    serverLog.info("Migration tracking initialized");
  }

  /**
   * Get current schema version
   */
  getCurrentVersion(): number {
    const result = this.db
      .query("SELECT MAX(version) as version FROM schema_migrations")
      .get() as { version: number | null };
    
    return result.version || 0;
  }

  /**
   * Load all migration files
   */
  private loadMigrations(): Migration[] {
    const files = readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const migrations: Migration[] = [];

    for (const file of files) {
      // Parse filename: 001_migration_name.sql
      const match = file.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        serverLog.warn({ file }, "Skipping invalid migration filename");
        continue;
      }

      const version = parseInt(match[1]);
      const name = match[2].replace(/_/g, ' ');
      const content = readFileSync(join(this.migrationsDir, file), 'utf-8');

      // Split up/down migrations if separated by -- DOWN
      const parts = content.split(/--\s*DOWN/i);
      
      migrations.push({
        version,
        name,
        up: parts[0].trim(),
        down: parts[1]?.trim(),
      });
    }

    return migrations;
  }

  /**
   * Run pending migrations
   */
  async migrate(): Promise<void> {
    await this.initialize();

    const currentVersion = this.getCurrentVersion();
    const migrations = this.loadMigrations();

    const pendingMigrations = migrations.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      serverLog.info({ version: currentVersion }, "Database is up to date");
      return;
    }

    serverLog.info(
      { currentVersion, pending: pendingMigrations.length },
      "Running migrations"
    );

    for (const migration of pendingMigrations) {
      try {
        this.runMigration(migration);
        serverLog.info(
          { version: migration.version, name: migration.name },
          "Migration applied"
        );
      } catch (error: any) {
        serverLog.error(
          { error, version: migration.version, name: migration.name },
          "Migration failed"
        );
        throw error;
      }
    }

    serverLog.info(
      { newVersion: this.getCurrentVersion() },
      "Migrations complete"
    );
  }

  /**
   * Run a single migration in a transaction
   */
  private runMigration(migration: Migration): void {
    const transaction = this.db.transaction(() => {
      // Execute migration SQL
      this.db.exec(migration.up);

      // Record migration
      this.db.run(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.name, Date.now()]
      );
    });

    transaction();
  }

  /**
   * Rollback last migration
   */
  async rollback(): Promise<void> {
    const currentVersion = this.getCurrentVersion();
    
    if (currentVersion === 0) {
      serverLog.info("No migrations to rollback");
      return;
    }

    const migrations = this.loadMigrations();
    const migration = migrations.find(m => m.version === currentVersion);

    if (!migration) {
      throw new Error(`Migration ${currentVersion} not found`);
    }

    if (!migration.down) {
      throw new Error(`Migration ${currentVersion} has no down script`);
    }

    try {
      const transaction = this.db.transaction(() => {
        // Execute down migration
        this.db.exec(migration.down!);

        // Remove migration record
        this.db.run(
          `DELETE FROM schema_migrations WHERE version = ?`,
          [migration.version]
        );
      });

      transaction();

      serverLog.info(
        { version: migration.version, name: migration.name },
        "Migration rolled back"
      );
    } catch (error: any) {
      serverLog.error(
        { error, version: migration.version, name: migration.name },
        "Rollback failed"
      );
      throw error;
    }
  }

  /**
   * Get migration status
   */
  getStatus(): { version: number; migrations: { version: number; name: string; applied: boolean }[] } {
    const migrations = this.loadMigrations();
    const currentVersion = this.getCurrentVersion();

    return {
      version: currentVersion,
      migrations: migrations.map(m => ({
        version: m.version,
        name: m.name,
        applied: m.version <= currentVersion,
      })),
    };
  }

  /**
   * Reset all migrations (DANGEROUS - drops all tables)
   */
  async reset(): Promise<void> {
    serverLog.warn("Resetting all migrations - this will drop all tables!");

    const migrations = this.loadMigrations().reverse();

    for (const migration of migrations) {
      if (migration.down) {
        try {
          this.db.exec(migration.down);
          serverLog.info({ version: migration.version }, "Rolled back");
        } catch (error: any) {
          serverLog.error({ error, version: migration.version }, "Rollback error");
        }
      }
    }

    // Clear migration table
    this.db.run("DELETE FROM schema_migrations");

    serverLog.info("Database reset complete");
  }
}

// CLI interface for running migrations
export async function runMigrations(db: Database, migrationsDir: string, command: string = 'migrate'): Promise<void> {
  const runner = new MigrationRunner(db, migrationsDir);

  switch (command) {
    case 'migrate':
      await runner.migrate();
      break;
    case 'rollback':
      await runner.rollback();
      break;
    case 'status':
      const status = runner.getStatus();
      console.log(`Current version: ${status.version}`);
      console.log('\nMigrations:');
      for (const m of status.migrations) {
        console.log(`  ${m.applied ? '✓' : '○'} ${m.version}: ${m.name}`);
      }
      break;
    case 'reset':
      await runner.reset();
      break;
    default:
      console.log('Usage: migrate|rollback|status|reset');
      process.exit(1);
  }
}
