import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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

// These are login stores owned by the official CLI harnesses. Numbered or
// suffixed sibling homes are intentionally included: users commonly isolate
// work/personal subscriptions with wrappers such as CODEX_HOME=~/.codex2.
const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  { provider: 'codex', command: 'codex', directoryPrefix: '.codex', authFiles: ['auth.json'] },
  { provider: 'claude', command: 'claude', directoryPrefix: '.claude', authFiles: ['.credentials.json'] },
  { provider: 'grok', command: 'grok', directoryPrefix: '.grok', authFiles: ['auth.json'] },
  { provider: 'cursor', command: 'cursor-agent', directoryPrefix: '.cursor', authFiles: ['cli-config.json'] },
  { provider: 'cline', command: 'cline', directoryPrefix: '.cline', authFiles: ['data/secrets.json'] },
  { provider: 'antigravity', command: 'agy', directoryPrefix: '.gemini', authFiles: ['antigravity-cli/auth.json'] },
  { provider: 'devin', command: 'devin', directoryPrefix: '.local/share/devin', authFiles: ['credentials.toml'] },
];

function decodeJwt(token: unknown): Record<string, any> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function identityFromAuth(path: string): Pick<DiscoveredCliAccount, 'email' | 'plan' | 'expiresAt' | 'health'> {
  const data = safeJson(path);
  if (!data) return { email: null, plan: null, expiresAt: null, health: 'unknown' };
  const token = data.tokens?.id_token ?? data.tokens?.access_token ?? data.id_token ?? data.access_token;
  const claims = decodeJwt(token) ?? {};
  const openAiAuth = claims['https://api.openai.com/auth'] ?? {};
  const openAiProfile = claims['https://api.openai.com/profile'] ?? {};
  const email = firstString(claims.email, openAiProfile.email, data.email, data.account?.email);
  const plan = firstString(
    openAiAuth.chatgpt_plan_type,
    claims.chatgpt_plan_type,
    data.plan,
    data.subscription?.plan,
    data.account?.plan,
  );
  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  return {
    email,
    plan,
    expiresAt,
    health: expiresAt == null ? 'unknown' : expiresAt > Date.now() ? 'ready' : 'expired',
  };
}

function candidateDirectories(home: string, definition: ProfileDefinition): string[] {
  if (definition.directoryPrefix.includes('/')) {
    const exact = join(home, definition.directoryPrefix);
    return existsSync(exact) ? [exact] : [];
  }
  try {
    return readdirSync(home)
      .filter((name) => name === definition.directoryPrefix || name.startsWith(`${definition.directoryPrefix}`))
      .map((name) => join(home, name))
      .filter((path) => {
        try { return statSync(path).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

export function discoverCliAccounts(home = homedir()): DiscoveredCliAccount[] {
  const accounts: DiscoveredCliAccount[] = [];
  for (const definition of PROFILE_DEFINITIONS) {
    for (const profileDir of candidateDirectories(home, definition)) {
      const authFile = definition.authFiles.map((file) => join(profileDir, file)).find(existsSync);
      if (!authFile) continue;
      const profileName = basename(profileDir);
      const identity = identityFromAuth(authFile);
      const suffix = profileName === definition.directoryPrefix ? 'Default' : profileName.replace(/^\./, '');
      accounts.push({
        id: `cli:${definition.provider}:${Buffer.from(profileDir).toString('base64url')}`,
        provider: definition.provider,
        label: identity.email ? `${identity.email} (${suffix})` : `${definition.provider} ${suffix}`,
        ...identity,
        profileDir,
        authFile,
        command: definition.command,
        commandArgs: [],
        source: 'cli-autodetect',
      });
    }
  }
  return accounts.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

export function getDiscoveredCliAccount(id: string): DiscoveredCliAccount | null {
  return discoverCliAccounts().find((account) => account.id === id) ?? null;
}

