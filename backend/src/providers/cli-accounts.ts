import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { serverLog } from '../logger';

export type CliAccountHealth = 'ready' | 'expired' | 'unknown';

export interface DiscoveredCliAccount {
  id: string;
  provider: string;
  label: string;
  email: string | null;
  plan: string | null;
  profileDir: string;
  authFile: string;
  command: string;
  commandArgs: string[];
  health: CliAccountHealth;
  expiresAt: number | null;
  source: 'cli-autodetect';
}

type ProfileDefinition = {
  provider: string;
  command: string;
  directoryPrefix: string;
  authFiles: string[];
};

/** A stable, human-facing name for a local CLI profile. This deliberately
 * describes the command context, not an email address or extracted token. */
export function cliAccountCommandLabel(
  definition: Pick<ProfileDefinition, 'provider' | 'directoryPrefix'>,
  profileDir: string,
): string {
  const profileName = basename(profileDir);
  if (profileName === definition.directoryPrefix) return definition.provider;
  const suffix = profileName.slice(definition.directoryPrefix.length).replace(/^[-_\s]+/, '');
  if (!suffix) return definition.provider;
  // `.codex2` is conventionally invoked through CODEX_HOME=~/.codex2. Present
  // that context as the command users recognize: “codex 2”.
  return `${definition.provider} ${suffix
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')}`
    .replace(/\s+/g, ' ')
    .trim();
}

// These are login stores owned by the official CLI harnesses. Numbered or
// suffixed sibling homes are intentionally included: users commonly isolate
// work/personal subscriptions with wrappers such as CODEX_HOME=~/.codex2.
const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  { provider: 'codex', command: 'codex', directoryPrefix: '.codex', authFiles: ['auth.json'] },
  {
    provider: 'claude',
    command: 'claude',
    directoryPrefix: '.claude',
    authFiles: ['.credentials.json'],
  },
  { provider: 'grok', command: 'grok', directoryPrefix: '.grok', authFiles: ['auth.json'] },
  {
    provider: 'cursor',
    command: 'cursor-agent',
    directoryPrefix: '.cursor',
    authFiles: ['cli-config.json'],
  },
  {
    provider: 'cline',
    command: 'cline',
    directoryPrefix: '.cline',
    authFiles: ['data/secrets.json'],
  },
  {
    provider: 'antigravity',
    command: 'agy',
    directoryPrefix: '.gemini',
    authFiles: ['antigravity-cli/auth.json'],
  },
  {
    provider: 'devin',
    command: 'devin',
    directoryPrefix: '.local/share/devin',
    authFiles: ['credentials.toml'],
  },
  // Kimi Code stores its OAuth device-flow credentials under ~/.kimi (the
  // official kimi CLI's home). Sibling homes like ~/.kimi2 are discovered
  // too, so users with multiple Kimi accounts can pick + order them.
  {
    provider: 'kimicode',
    command: 'kimi',
    directoryPrefix: '.kimi',
    authFiles: ['credentials/kimi-code.json'],
  },
];

function safeJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'cli-accounts: JSON file parse failed',
    );
    return null;
  }
}

function identityFromAuth(
  path: string,
): Pick<DiscoveredCliAccount, 'email' | 'plan' | 'expiresAt' | 'health'> {
  const data = safeJson(path);
  if (!data) return { email: null, plan: null, expiresAt: null, health: 'unknown' };
  // These files are merely local CLI state. JWT payloads are unsigned input
  // until their signatures and issuer are verified, while email, plan, and
  // expiry fields in local JSON can be stale or user-edited. Do not present
  // any of them as authenticated account metadata. A provider/CLI probe owns
  // the eventual verification verdict.
  return {
    email: null,
    plan: null,
    expiresAt: null,
    health: 'unknown',
  };
}

function candidateDirectories(home: string, definition: ProfileDefinition): string[] {
  if (definition.directoryPrefix.includes('/')) {
    const exact = join(home, definition.directoryPrefix);
    return existsSync(exact) ? [exact] : [];
  }
  try {
    return readdirSync(home)
      .filter(
        (name) =>
          name === definition.directoryPrefix || name.startsWith(`${definition.directoryPrefix}`),
      )
      .map((name) => join(home, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch (err: unknown) {
          serverLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'cli-accounts: statSync failed during directory filter',
          );
          return false;
        }
      });
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'cli-accounts: candidate directory scan failed',
    );
    return [];
  }
}

export function discoverCliAccounts(home = homedir()): DiscoveredCliAccount[] {
  const accounts: DiscoveredCliAccount[] = [];
  for (const definition of PROFILE_DEFINITIONS) {
    for (const profileDir of candidateDirectories(home, definition)) {
      const authFile = definition.authFiles.map((file) => join(profileDir, file)).find(existsSync);
      if (!authFile) continue;
      const identity = identityFromAuth(authFile);
      const commandLabel = cliAccountCommandLabel(definition, profileDir);
      accounts.push({
        id: `cli:${definition.provider}:${Buffer.from(profileDir).toString('base64url')}`,
        provider: definition.provider,
        // Keep the command profile first: it is what distinguishes accounts in
        // model pickers, billing, and an actual spawned CLI process.
        label: commandLabel,
        ...identity,
        profileDir,
        authFile,
        command: definition.command,
        commandArgs: [],
        source: 'cli-autodetect',
      });
    }
  }
  return accounts.sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label),
  );
}

export function getDiscoveredCliAccount(id: string): DiscoveredCliAccount | null {
  return discoverCliAccounts().find((account) => account.id === id) ?? null;
}
