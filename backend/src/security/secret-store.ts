// Provider secret store — API keys and auth tokens live HERE, never in
// koryphaios.json. That file is settings; committing it (or an auto-committer
// snapshotting it) must never leak a credential again.
//
// Storage: <projectRoot>/.koryphaios/credentials.json, chmod 0600.
//   • dev: .koryphaios/ is gitignored
//   • packaged: projectRoot IS the per-user data dir
// This is the same honest model gh/aws CLIs use: plaintext guarded by file
// permissions and location. (The old XOR-with-'dev-key' "encryption" in
// user-credentials.ts is theater — do not route secrets through it.)

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { serverLog } from '../logger';
import { ensureSecureDir } from './fs-permissions';

export const SECRET_FIELDS = ['apiKey', 'authToken'] as const;
type SecretField = (typeof SECRET_FIELDS)[number];
export type ProviderSecrets = Record<string, Partial<Record<SecretField, string>>>;

function secretsPath(projectRoot: string): string {
  return join(projectRoot, '.koryphaios', 'credentials.json');
}

export function loadProviderSecrets(projectRoot: string): ProviderSecrets {
  const path = secretsPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ProviderSecrets;
  } catch (err) {
    serverLog.warn({ err, path }, 'Failed to read credentials store');
    return {};
  }
}

export function saveProviderSecrets(projectRoot: string, secrets: ProviderSecrets): void {
  const path = secretsPath(projectRoot);
  ensureSecureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch (err: unknown) {
    /* best effort on exotic filesystems */
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'chmod 0o600 failed on credentials store, best effort',
    );
  }
}

/** Merge one provider's secret fields into the store. */
export function upsertProviderSecrets(
  projectRoot: string,
  provider: string,
  values: Partial<Record<SecretField, string>>,
): void {
  const filtered = Object.fromEntries(
    Object.entries(values).filter(([, v]) => typeof v === 'string' && v.trim()),
  );
  if (Object.keys(filtered).length === 0) return;
  const secrets = loadProviderSecrets(projectRoot);
  secrets[provider] = { ...secrets[provider], ...filtered };
  saveProviderSecrets(projectRoot, secrets);
}

export function removeProviderSecrets(projectRoot: string, provider: string): boolean {
  const path = secretsPath(projectRoot);
  if (!existsSync(path)) return false;

  let secrets: ProviderSecrets;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('credentials store root is not an object');
    }
    secrets = parsed as ProviderSecrets;
  } catch (err: unknown) {
    // A disconnect must never report success after silently treating an
    // unreadable credential store as empty. Preserve the file for recovery and
    // force the caller to surface an explicit failure instead.
    throw new Error(
      `Cannot remove ${provider} credentials because the direct credential store is unreadable`,
      { cause: err },
    );
  }

  if (!Object.prototype.hasOwnProperty.call(secrets, provider)) return false;
  delete secrets[provider];
  saveProviderSecrets(projectRoot, secrets);
  return true;
}

/** Split secret fields out of a providers map. Returns the cleaned map (safe
 *  to write to koryphaios.json) and the extracted secrets. */
export function stripProviderSecrets(providers: Record<string, unknown>): {
  clean: Record<string, unknown>;
  secrets: ProviderSecrets;
} {
  const clean: Record<string, unknown> = {};
  const secrets: ProviderSecrets = {};
  for (const [name, cfg] of Object.entries(providers)) {
    if (!cfg || typeof cfg !== 'object') {
      clean[name] = cfg;
      continue;
    }
    const copy = { ...(cfg as Record<string, unknown>) };
    for (const field of SECRET_FIELDS) {
      const v = copy[field];
      if (typeof v === 'string' && v.trim()) {
        (secrets[name] ??= {})[field] = v;
      }
      delete copy[field];
    }
    clean[name] = copy;
  }
  return { clean, secrets };
}

/** Merge stored secrets back into a providers map (for runtime use only). */
export function hydrateProviderSecrets<T extends Record<string, unknown>>(
  projectRoot: string,
  providers: T,
): T {
  const secrets = loadProviderSecrets(projectRoot);
  const out: Record<string, unknown> = { ...providers };
  for (const [name, vals] of Object.entries(secrets)) {
    out[name] = { ...((out[name] as Record<string, unknown>) ?? {}), ...vals };
  }
  return out as T;
}

// ─── MCP server env secret store ───────────────────────────────────────────
// MCP server `env` maps routinely carry tokens (GITHUB_TOKEN, API_KEY, etc.).
// Per the "all env to secret store" policy, the entire env map is treated as
// secret and stored here, never in koryphaios.json. The config file keeps only
// the key names (so the UI can show which vars are configured) with values
// stripped. Storage: <projectRoot>/.koryphaios/mcp-env.json, chmod 0600.

export type McpEnvSecrets = Record<string, Record<string, string>>;

function mcpEnvSecretsPath(projectRoot: string): string {
  return join(projectRoot, '.koryphaios', 'mcp-env.json');
}

export function loadMcpEnvSecrets(projectRoot: string): McpEnvSecrets {
  const path = mcpEnvSecretsPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as McpEnvSecrets;
  } catch (err) {
    serverLog.warn({ err, path }, 'Failed to read MCP env secret store');
    return {};
  }
}

export function saveMcpEnvSecrets(projectRoot: string, secrets: McpEnvSecrets): void {
  const path = mcpEnvSecretsPath(projectRoot);
  ensureSecureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'chmod 0o600 failed on MCP env secret store, best effort',
    );
  }
}

/** Merge one MCP server's env into the secret store. Empty values are dropped. */
export function upsertMcpEnvSecrets(
  projectRoot: string,
  serverName: string,
  env: Record<string, string>,
): void {
  const filtered = Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v === 'string' && v.trim()),
  );
  if (Object.keys(filtered).length === 0) return;
  const secrets = loadMcpEnvSecrets(projectRoot);
  secrets[serverName] = { ...secrets[serverName], ...filtered };
  saveMcpEnvSecrets(projectRoot, secrets);
}

export function removeMcpEnvSecrets(projectRoot: string, serverName: string): boolean {
  const path = mcpEnvSecretsPath(projectRoot);
  if (!existsSync(path)) return false;
  let secrets: McpEnvSecrets;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('MCP env secret store root is not an object');
    }
    secrets = parsed as McpEnvSecrets;
  } catch (err: unknown) {
    throw new Error(`Cannot remove ${serverName} MCP env secrets because the store is unreadable`, {
      cause: err,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(secrets, serverName)) return false;
  delete secrets[serverName];
  saveMcpEnvSecrets(projectRoot, secrets);
  return true;
}

/** Strip env values out of an mcpServers map. Returns the cleaned map (env keys
 *  retained with empty-string values so the UI can show which vars exist) and
 *  the extracted env secrets keyed by server name. */
export function stripMcpEnvSecrets(servers: Record<string, Record<string, unknown>>): {
  clean: Record<string, Record<string, unknown>>;
  secrets: McpEnvSecrets;
} {
  const clean: Record<string, Record<string, unknown>> = {};
  const secrets: McpEnvSecrets = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') {
      clean[name] = cfg;
      continue;
    }
    const copy = { ...cfg };
    const env = copy.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const extracted: Record<string, string> = {};
      const keyOnlyEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) {
          extracted[k] = v;
        }
        // Keep the key with an empty value so the UI knows it's configured.
        keyOnlyEnv[k] = '';
      }
      if (Object.keys(extracted).length > 0) secrets[name] = extracted;
      copy.env = keyOnlyEnv;
    }
    clean[name] = copy;
  }
  return { clean, secrets };
}

/** Merge stored MCP env secrets back into an mcpServers map (runtime only). */
export function hydrateMcpEnvSecrets<T extends Record<string, unknown>>(
  projectRoot: string,
  servers: T,
): T {
  const secrets = loadMcpEnvSecrets(projectRoot);
  const out = { ...servers } as Record<string, unknown>;
  for (const [name, env] of Object.entries(secrets)) {
    const existing = (out[name] ?? {}) as Record<string, unknown>;
    const existingEnv = (existing.env ?? {}) as Record<string, unknown>;
    out[name] = { ...existing, env: { ...existingEnv, ...env } };
  }
  return out as T;
}

/** One-time healing: if koryphaios.json still carries apiKey/authToken values,
 *  move them into the secret store and rewrite the config without them. */
export function migrateSecretsOutOfConfig(projectRoot: string): void {
  const configPath = join(projectRoot, 'koryphaios.json');
  if (!existsSync(configPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      providers?: Record<string, unknown>;
    };
    if (!config.providers) return;
    const { clean, secrets } = stripProviderSecrets(config.providers);
    if (Object.keys(secrets).length === 0) return;
    const existing = loadProviderSecrets(projectRoot);
    for (const [name, vals] of Object.entries(secrets)) {
      existing[name] = { ...existing[name], ...vals };
    }
    saveProviderSecrets(projectRoot, existing);
    config.providers = clean;
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tmp, configPath);
    serverLog.info(
      { providers: Object.keys(secrets) },
      'Migrated provider credentials out of koryphaios.json into the secret store',
    );
  } catch (err) {
    serverLog.warn({ err }, 'Secret migration from koryphaios.json failed');
  }
}
