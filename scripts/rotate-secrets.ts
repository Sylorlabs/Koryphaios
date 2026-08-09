#!/usr/bin/env bun
/**
 * Rotate Koryphaios secrets out of the repo tree.
 *
 * What this script does:
 *   1. Generates fresh JWT_SECRET, SESSION_TOKEN_SECRET, RELAY_HOST_SECRET
 *      using crypto.randomBytes(32).toString('hex').
 *   2. Writes them to ~/.config/koryphaios/secrets.env with mode 0o600.
 *      This location is OUTSIDE the repo working tree and is loaded by
 *      the backend at startup (see backend/src/runtime/env.ts).
 *   3. Backs up the existing repo .env to .env.pre-rotation.bak (gitignored)
 *      and scrubs the three secret lines + RELAY_URL from the repo .env so
 *      it no longer holds production secrets.
 *
 * What this script does NOT do:
 *   - Invalidate the old secrets on the relay server. If 158.51.125.29:8080
 *      (or your configured RELAY_URL) is a relay you control, you MUST
 *      rotate RELAY_HOST_SECRET on that host too. The new secret written
 *      here is only useful once the relay accepts it.
 *   - Rotate provider API keys (ANTHROPIC_API_KEY, etc.). Those stay in
 *      the repo .env or the secret store; rotate them via your provider's
 *      dashboard if needed.
 *
 * Usage:
 *   bun run scripts/rotate-secrets.ts            # generate + scrub
 *   bun run scripts/rotate-secrets.ts --dry-run  # show what would change
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');

const SECRETS_TO_ROTATE = ['JWT_SECRET', 'SESSION_TOKEN_SECRET', 'RELAY_HOST_SECRET'] as const;
// RELAY_URL is not a secret but the hardcoded IP in the repo .env should not
// ship to users. Scrub it too; users set it via the UI or their own secrets.env.
const SCRUB_KEYS = [...SECRETS_TO_ROTATE, 'RELAY_URL'] as const;

const userSecretsDir = join(homedir(), '.config', 'koryphaios');
const userSecretsPath = join(userSecretsDir, 'secrets.env');
const repoRoot = process.cwd();
const repoEnvPath = join(repoRoot, '.env');
const repoEnvBackupPath = join(repoRoot, '.env.pre-rotation.bak');

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out.set(key, value);
  }
  return out;
}

function buildEnvFile(entries: Map<string, string>, headerComment: string): string {
  const lines = [headerComment, ''];
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  return lines.join('\n') + '\n';
}

console.log(DRY_RUN ? '=== DRY RUN ===' : '=== Rotating Koryphaios secrets ===');
console.log();

// 1. Generate fresh secrets.
const newSecrets: Record<string, string> = {};
for (const key of SECRETS_TO_ROTATE) {
  newSecrets[key] = generateSecret();
  console.log(`Generated fresh ${key} (${newSecrets[key].length} hex chars)`);
}

// 2. Write to ~/.config/koryphaios/secrets.env (merge with existing).
const existingUserSecrets = new Map<string, string>();
if (existsSync(userSecretsPath)) {
  existingUserSecrets = parseEnvFile(readFileSync(userSecretsPath, 'utf-8'));
}
for (const [key, value] of Object.entries(newSecrets)) {
  existingUserSecrets.set(key, value);
}

const userSecretsContent = buildEnvFile(
  existingUserSecrets,
  '# Koryphaios user secrets — loaded by backend/src/runtime/env.ts at startup.\n' +
    '# This file lives OUTSIDE the repo tree and should never be committed.\n' +
    '# Regenerate with: bun run scripts/rotate-secrets.ts',
);

if (DRY_RUN) {
  console.log();
  console.log(`Would write ${userSecretsPath} (mode 0o600) with ${existingUserSecrets.size} keys.`);
} else {
  mkdirSync(userSecretsDir, { recursive: true });
  writeFileSync(userSecretsPath, userSecretsContent, { mode: 0o600 });
  chmodSync(userSecretsPath, 0o600);
  console.log(`Wrote ${userSecretsPath} (mode 0o600)`);
}

// 3. Back up and scrub the repo .env.
if (!existsSync(repoEnvPath)) {
  console.log();
  console.log('No repo .env found — nothing to scrub.');
  console.log();
  console.log('IMPORTANT: The old secrets in your previous .env are NOT invalidated.');
  console.log('If a relay server uses them, rotate RELAY_HOST_SECRET on that host too.');
  process.exit(0);
}

const repoEnvContent = readFileSync(repoEnvPath, 'utf-8');
const repoEnvMap = parseEnvFile(repoEnvContent);

if (DRY_RUN) {
  console.log();
  console.log(`Would back up ${repoEnvPath} -> ${repoEnvBackupPath}`);
  const scrubbed = [...repoEnvMap.entries()].filter(([k]) => !(SCRUB_KEYS as readonly string[]).includes(k));
  console.log(`Would scrub ${repoEnvMap.size - scrubbed.length} keys from repo .env:`);
  for (const key of SCRUB_KEYS) {
    if (repoEnvMap.has(key)) console.log(`  - ${key}`);
  }
} else {
  copyFileSync(repoEnvPath, repoEnvBackupPath);
  console.log(`Backed up repo .env to ${repoEnvBackupPath} (gitignored)`);

  const scrubbed = new Map<string, string>();
  const removed: string[] = [];
  for (const [key, value] of repoEnvMap) {
    if ((SCRUB_KEYS as readonly string[]).includes(key)) {
      removed.push(key);
    } else {
      scrubbed.set(key, value);
    }
  }
  writeFileSync(repoEnvPath, buildEnvFile(scrubbed, '# Koryphaios repo-local .env\n# Secrets live in ~/.config/koryphaios/secrets.env — do not put them here.'));
  console.log(`Scrubbed ${removed.length} keys from repo .env: ${removed.join(', ') || '(none present)'}`);
}

console.log();
console.log('IMPORTANT: The old secrets are NOT invalidated by generating new ones.');
console.log('If a relay server uses RELAY_HOST_SECRET/JWT_SECRET, rotate them on that host too.');
console.log('See docs/secrets-rotation.md for the full runbook.');
