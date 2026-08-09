import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { serverLog } from '../logger';

/**
 * Load a .env file into process.env (only sets keys that are not already set).
 * Returns the set of keys that were loaded.
 */
function loadEnvFile(envPath: string, label: string): Set<string> {
  if (!existsSync(envPath)) return new Set();
  try {
    const content = readFileSync(envPath, 'utf-8');
    const loaded = new Set<string>();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = value;
        loaded.add(key);
      }
    }
    serverLog.debug({ path: envPath, count: loaded.size }, `Loaded ${label}`);
    return loaded;
  } catch (err) {
    serverLog.warn({ path: envPath, error: String(err) }, `Could not load ${label}`);
    return new Set();
  }
}

/**
 * Load environment variables into process.env with the following precedence
 * (highest first):
 *
 *   1. Existing process.env (caller-set, e.g. systemd, launch-desktop.ts)
 *   2. ~/.config/koryphaios/secrets.env  — user-owned secrets, OUTSIDE the
 *      repo tree. This is the preferred location for JWT_SECRET,
 *      SESSION_TOKEN_SECRET, RELAY_HOST_SECRET, etc.
 *   3. <projectRoot>/.env                — repo-local dev overrides.
 *      SHOULD NOT contain production secrets. Kept for backwards compat
 *      and dev convenience.
 *
 * Only keys not already in process.env are set, so a caller that exports
 * a secret before spawning the backend always wins.
 */
export function loadEnvFromProject(projectRoot: string): void {
  // User secrets dir (outside the repo tree) — loaded first so it wins
  // over the repo .env. Only the repo .env used to hold secrets; the
  // rotation script moves them here.
  const userSecretsDir = join(homedir(), '.config', 'koryphaios');
  const userSecretsPath = join(userSecretsDir, 'secrets.env');
  loadEnvFile(userSecretsPath, 'user secrets');

  // Repo-local .env — dev overrides, provider API keys for local dev.
  loadEnvFile(join(projectRoot, '.env'), 'project .env');
}

/** Validate essential environment variables. */
export function validateEnvironment(): void {
  // Add validation logic if needed
}

/** Restrict .env to owner read/write only (0600). Works on Windows, macOS, and Linux. */
function restrictEnvFilePermissions(envPath: string) {
  try {
    chmodSync(envPath, 0o600);
  } catch (err) {
    serverLog.warn({ path: envPath, error: String(err) }, 'Could not set .env file mode to 0600');
  }
}

export function persistEnvVar(projectRoot: string, key: string, value: string) {
  const envPath = join(projectRoot, '.env');
  let content = '';
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch (err) {
    serverLog.debug({ key, error: String(err) }, 'No existing .env file, creating new one');
  }

  process.env[key] = value;

  const lines = content.split('\n');
  const existingIdx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (existingIdx >= 0) {
    lines[existingIdx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }

  try {
    writeFileSync(envPath, lines.join('\n'));
    restrictEnvFilePermissions(envPath);
    serverLog.debug({ key }, 'Persisted environment variable');
  } catch (err) {
    serverLog.error({ key, error: String(err) }, 'Failed to persist environment variable');
  }
}

export function clearEnvVar(projectRoot: string, key: string) {
  const envPath = join(projectRoot, '.env');
  let content = '';
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch (err: unknown) {
    serverLog.debug({ err: err instanceof Error ? err.message : String(err), key }, 'Env file not readable, clearing env var in memory only');
    delete process.env[key];
    return;
  }

  delete process.env[key];
  const lines = content.split('\n').filter((line) => !line.startsWith(`${key}=`));
  try {
    writeFileSync(envPath, lines.join('\n'));
    restrictEnvFilePermissions(envPath);
    serverLog.debug({ key }, 'Cleared environment variable');
  } catch (err) {
    serverLog.error({ key, error: String(err) }, 'Failed to clear environment variable');
  }
}