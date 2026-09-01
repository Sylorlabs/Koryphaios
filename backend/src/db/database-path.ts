import { dirname, join, resolve } from 'node:path';
import { ensureSecureDir } from '../security/fs-permissions';

export type DatabasePathEnvironment = { DATABASE_URL?: string; NODE_ENV?: string };

/**
 * Resolve the primary application database without depending on process cwd.
 * The desktop runtime supplies a per-user project root; tests and packaged
 * launches must never fall back to a shared checkout-relative database.
 */
export function resolveDatabasePath(
  projectRoot: string,
  environment: DatabasePathEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  },
): string {
  const configured = environment.DATABASE_URL?.trim();
  const defaultPath = join(projectRoot, 'data', 'koryphaios.db');
  if (environment.NODE_ENV === 'test' && !configured) {
    throw new Error(
      'Refusing to open the default Koryphaios database in a test process. Set DATABASE_URL to an isolated SQLite database or use bun run test:backend:isolated.',
    );
  }

  if (configured) {
    // Accept sqlite://path, sqlite:path, and plain filesystem paths. A Windows
    // drive path remains intact after the sqlite: prefix is removed.
    const configuredPath = configured.replace(/^sqlite:\/\//, '').replace(/^sqlite:/, '');
    if (
      environment.NODE_ENV === 'test' &&
      configuredPath !== ':memory:' &&
      resolve(configuredPath) === resolve(defaultPath)
    ) {
      throw new Error(
        'Refusing to open the live Koryphaios database in a test process. Choose a dedicated test DATABASE_URL.',
      );
    }
    return configuredPath;
  }

  return defaultPath;
}

/**
 * Prepare the database parent without ever chmodding a broad user-configured
 * directory. The default data/ directory is application-managed and may heal
 * an older loose mode; an explicit DATABASE_URL must use a missing leaf that
 * Koryphaios can create or an existing owner-only directory.
 */
export function ensureDatabaseDirectory(
  databasePath: string,
  environment: DatabasePathEnvironment = { DATABASE_URL: process.env.DATABASE_URL },
): void {
  if (databasePath === ':memory:') return;

  const parent = dirname(databasePath);
  const configured = Boolean(environment.DATABASE_URL?.trim());
  if (configured && parent === '.') {
    throw new Error(
      'Configured DATABASE_URL must place the database in a dedicated private directory',
    );
  }
  if (parent === '.') return;

  ensureSecureDir(parent, { repairExistingPermissions: !configured });
}
