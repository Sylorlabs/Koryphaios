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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { serverLog } from '../logger';

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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(secrets, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on exotic filesystems */
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

export function removeProviderSecrets(projectRoot: string, provider: string): void {
  const secrets = loadProviderSecrets(projectRoot);
  if (secrets[provider]) {
    delete secrets[provider];
    saveProviderSecrets(projectRoot, secrets);
  }
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
