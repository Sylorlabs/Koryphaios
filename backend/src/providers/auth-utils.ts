import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';
import {
  inspectFreebuffCredentials,
  readFreebuffPlaintextCredentials,
} from './freebuff-credentials';

// Cache for token detection results to avoid repeated slow operations
const tokenCache = new Map<string, { result: string | null; timestamp: number }>();
const TOKEN_CACHE_TTL_MS = 30_000; // 30 seconds

function getCachedToken(
  key: string,
  detector: () => string | null,
  options?: { cacheNull?: boolean },
): string | null {
  const cacheNull = options?.cacheNull ?? true;
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (
    cached &&
    now - cached.timestamp < TOKEN_CACHE_TTL_MS &&
    (cacheNull || cached.result !== null)
  ) {
    return cached.result;
  }
  const result = detector();
  if (result !== null || cacheNull) {
    tokenCache.set(key, { result, timestamp: now });
  } else {
    tokenCache.delete(key);
  }
  return result;
}

/**
 * Clear all token detection caches. Useful for testing.
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

export function clearCachedToken(key: string): void {
  tokenCache.delete(key);
}

const CODEX_CLI_AUTH_PREFIX = 'cli:codex:';
const CLAUDE_CLI_AUTH_PREFIX = 'cli:claude:';
const OPENCODE_CLI_AUTH_PREFIX = 'cli:opencode:';
/** OpenCode CLI opt-in marker — the CLI owns its own auth (~/.local/share/opencode/auth.json). */
export function isOpenCodeCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(OPENCODE_CLI_AUTH_PREFIX);
}
export function createOpenCodeCLIAuthMarker(): string {
  return `${OPENCODE_CLI_AUTH_PREFIX}${Date.now()}`;
}

/** Detect only the CLI-owned credential signal (workspace credentials are
 *  CLI-owned). A live ACP turn remains the verification authority. */
export function detectOpenCodeCLILogin(): boolean {
  const home = homeDir();
  if (!home) return false;
  return existsSync(join(home, '.local', 'share', 'opencode', 'auth.json'));
}

const GROK_CLI_AUTH_PREFIX = 'cli:grok:';
const CODEBUDDY_CLI_AUTH_PREFIX = 'cli:codebuddy:';
/** WorkBuddy Desktop marker — the installed desktop app owns the login. */
const WORKBUDDY_DESKTOP_AUTH_PREFIX = 'workbuddy-desktop:installed:';
const ANTIGRAVITY_CLI_AUTH_PREFIX = 'cli:antigravity:';
const OMNIRUSH_CLI_AUTH_PREFIX = 'cli:omnirush:';
const KORY_CODEX_HOME = join(PROJECT_ROOT, '.koryphaios', 'codex-home');

/** Grok Build CLI opt-in marker — the CLI owns its own auth (subscription or XAI key). */
export function isGrokCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(GROK_CLI_AUTH_PREFIX);
}
export function createGrokCLIAuthMarker(): string {
  return `${GROK_CLI_AUTH_PREFIX}${Date.now()}`;
}

/** CodeBuddy CLI opt-in marker — the CLI owns its own auth (~/.codebuddy login). */
export function isCodeBuddyCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CODEBUDDY_CLI_AUTH_PREFIX);
}
export function createCodeBuddyCLIAuthMarker(): string {
  return `${CODEBUDDY_CLI_AUTH_PREFIX}${Date.now()}`;
}

/** WorkBuddy Desktop opt-in marker — presence means "the desktop app owns the
 *  login". Installing the app is the entire configuration; no token is ever
 *  requested from the user. */
export function isWorkBuddyDesktopAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(WORKBUDDY_DESKTOP_AUTH_PREFIX);
}
export function createWorkBuddyDesktopAuthMarker(): string {
  return `${WORKBUDDY_DESKTOP_AUTH_PREFIX}${Date.now()}`;
}

/** Detect the CLI-owned login signal; a live turn remains the real verification. */
export function detectCodeBuddyCLILogin(): boolean {
  if (process.env.CODEBUDDY_API_KEY?.trim()) return true;
  const home = homeDir();
  if (!home) return false;
  return existsSync(join(home, '.codebuddy', 'settings.json')) ||
    existsSync(join(home, '.codebuddy', 'auth.json')) ||
    existsSync(join(home, '.codebuddy', 'user-state.json'));
}

export function isCursorCLIAuthMarker(value: string | null | undefined): boolean {
  return value === 'cursor-cli-session';
}
export function createCursorCLIAuthMarker(): string {
  return 'cursor-cli-session';
}

export function isAntigravityCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ANTIGRAVITY_CLI_AUTH_PREFIX);
}
export function createAntigravityCLIAuthMarker(): string {
  return `${ANTIGRAVITY_CLI_AUTH_PREFIX}${Date.now()}`;
}

export function isOmnirushCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(OMNIRUSH_CLI_AUTH_PREFIX);
}

export function createOmnirushCLIAuthMarker(): string {
  return `${OMNIRUSH_CLI_AUTH_PREFIX}${Date.now()}`;
}

/** Detect only the CLI-owned state signal; whoami remains the verification authority. */
export function detectOmnirushCLILogin(): boolean {
  return existsSync(join(omnirushStateDirectory(), 'auth.json'));
}

export function omnirushStateDirectory(): string {
  return process.env.OMNIRUSH_DIR?.trim() || join(homeDir(), '.omnirush');
}

const GEMINI_CLI_AUTH_PREFIX = 'cli:gemini:';
/** Gemini CLI opt-in marker — the gemini CLI owns its own OAuth (no API key needed). */
export function isGeminiCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(GEMINI_CLI_AUTH_PREFIX);
}
export function createGeminiCLIAuthMarker(): string {
  return `${GEMINI_CLI_AUTH_PREFIX}${Date.now()}`;
}

export function getKoryCodexHome(): string {
  return KORY_CODEX_HOME;
}

export function isCodexCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CODEX_CLI_AUTH_PREFIX);
}

export function createCodexCLIAuthMarker(): string {
  return `${CODEX_CLI_AUTH_PREFIX}${Date.now()}`;
}

/**
 * Detects an active Claude Code OAuth token from environment variables or Claude CLI config.
 * Returns the token and optional base URL override.
 */
export function detectClaudeCodeToken(): { token: string | null; baseUrl?: string } {
  const cached = getCachedToken(
    'claude-full',
    () => {
      // 1. Check environment variable
      const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (typeof envToken === 'string' && envToken.trim()) {
        return envToken.trim();
      }

      // 2. Check Claude CLI config files
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const claudeConfigPaths = [
        join(home, '.claude', '.credentials'),
        join(home, '.claude', 'credentials.json'),
        join(home, '.config', 'claude', 'credentials.json'),
      ];

      for (const configPath of claudeConfigPaths) {
        if (!existsSync(configPath)) continue;
        try {
          const data = JSON.parse(readFileSync(configPath, 'utf-8'));
          // Claude CLI stores OAuth tokens in various formats depending on version
          const token = data?.oauthAccessToken ?? data?.accessToken ?? data?.oauth_token;
          if (typeof token === 'string' && token.trim()) {
            return token.trim();
          }
        } catch (err: unknown) {
          // Ignore malformed config files
          serverLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'auth-utils: malformed Claude config file',
          );
        }
      }

      return null;
    },
    { cacheNull: false },
  );

  return { token: cached };
}

// ─── Claude Code subscription (CLI harness) auth ────────────────────────────
// The Claude Code subscription is driven through the official `claude` CLI, which
// owns its own OAuth credentials. We never persist or transmit the raw subscription
// token ourselves — instead we store an opaque marker indicating the user opted in,
// and the CLI authenticates each request. This keeps Koryphaios compliant with
// Anthropic's terms (subscription auth must flow through the Claude Code product,
// not direct API calls).

export function isClaudeCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CLAUDE_CLI_AUTH_PREFIX);
}

export function createClaudeCLIAuthMarker(): string {
  return `${CLAUDE_CLI_AUTH_PREFIX}${Date.now()}`;
}

/**
 * Detects whether Claude Code left recognized local login material without depending on
 * the exact token format. This does not prove account authentication, plan, expiry, or
 * entitlement; the CLI remains the authority when it actually runs.
 */
export function detectClaudeCodeLogin(): boolean {
  return (
    getCachedToken(
      'claude-login',
      () => {
        // 1. Explicit OAuth token via environment
        const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        if (typeof envToken === 'string' && envToken.trim()) return 'yes';

        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        if (!home) return null;

        // 2. Claude CLI credential files (subscription OAuth lives here)
        const credentialPaths = [
          join(home, '.claude', '.credentials.json'),
          join(home, '.claude', '.credentials'),
          join(home, '.claude', 'credentials.json'),
          join(home, '.config', 'claude', 'credentials.json'),
        ];
        for (const path of credentialPaths) {
          if (existsSync(path)) return 'yes';
        }

        // 3. ~/.claude.json with a linked OAuth account
        const claudeJson = join(home, '.claude.json');
        if (existsSync(claudeJson)) {
          try {
            const data = JSON.parse(readFileSync(claudeJson, 'utf-8'));
            if (data?.oauthAccount) return 'yes';
          } catch (err: unknown) {
            // Ignore malformed config
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'auth-utils: malformed .claude.json config',
            );
          }
        }

        return null;
      },
      { cacheNull: false },
    ) === 'yes'
  );
}

// ─── Agent-CLI login detection ──────────────────────────────────────────────
// Koryphaios detects agent CLIs plus local login signals (Claude Code, Codex,
// Antigravity, Grok Build, Cursor) so their adapters can be configured
// without copying CLI-owned secrets. These helpers report local configuration,
// not account entitlement or a successful remote request.

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

/**
 * Freebuff resolves its profile from FREEBUFF_CONFIG_DIR when set, otherwise
 * from ~/.config/manicode. Keep discovery aligned with the CLI instead of
 * assuming the default path on every host.
 */
export function freebuffConfigDir(): string {
  return process.env.FREEBUFF_CONFIG_DIR?.trim() || join(homeDir(), '.config', 'manicode');
}

/**
 * Detects a machine-wide Codex CLI login at ~/.codex/auth.json. This is separate from
 * Koryphaios's managed Codex app-server profile and is informational —
 * it tells us the user has the Codex CLI set up on their system.
 */
export function detectCodexCLILogin(): boolean {
  const home = homeDir();
  if (!home) return false;
  const authPath = join(home, '.codex', 'auth.json');
  if (!existsSync(authPath)) return false;
  try {
    const data = JSON.parse(readFileSync(authPath, 'utf-8'));
    return !!(data?.tokens?.access_token || data?.OPENAI_API_KEY || data?.access_token);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'auth-utils: Codex auth.json parse failed',
    );
    return false;
  }
}

/** The xAI API key the Grok Build CLI uses for headless/API access, if present. */
export function detectGrokXaiKey(): string | null {
  const k = process.env.GROK_CODE_XAI_API_KEY?.trim() || process.env.GROK_API_KEY?.trim();
  return k || null;
}

/**
 * Detects whether the Grok Build CLI is set up: a headless xAI key in the environment
 * or the CLI's cached OAuth credentials at ~/.grok/auth.json (subscription login).
 */
export function detectGrokCLILogin(): boolean {
  if (detectGrokXaiKey()) return true;
  const home = homeDir();
  return !!home && existsSync(join(home, '.grok', 'auth.json'));
}

export function detectDevinCLILogin(): boolean {
  if (process.env.COGNITION_API_KEY?.trim() || process.env.DEVIN_API_KEY?.trim()) return true;
  const home = homeDir();
  if (!home) return false;
  // Credentials file written by `devin auth login`.
  return existsSync(join(home, '.local', 'share', 'devin', 'credentials.toml'));
}
export function isDevinCLIAuthMarker(value: string | null | undefined): boolean {
  return value === 'devin-cli-session';
}
export function createDevinCLIAuthMarker(): string {
  return 'devin-cli-session';
}

// ─── Freebuff local-material detection ─────────────────────────────────────
// Retained only to report whether the user's existing Freebuff installation
// left local setup material behind. Koryphaios does not interpret this as an
// authenticated session and does not send the token to an undocumented API.

const FREEBUFF_CLI_AUTH_PREFIX = 'cli:freebuff:';

export function isFreebuffCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(FREEBUFF_CLI_AUTH_PREFIX);
}
export function createFreebuffCLIAuthMarker(): string {
  return `${FREEBUFF_CLI_AUTH_PREFIX}${Date.now()}`;
}

/**
 * Detects Freebuff setup material: a credentials file at
 * ~/.config/manicode/credentials.json with a legacy token or the CLI-owned
 * tokenStore:'keychain' reference. Never reads the keychain; this is not proof
 * of login validity, entitlement, or runtime/keychain support.
 */
export function detectFreebuffCLILogin(): boolean {
  const profile = freebuffConfigDir();
  if (!profile) return false;
  const status = inspectFreebuffCredentials(profile);
  return status.kind === 'plaintext' || status.kind === 'keychain';
}

/**
 * Legacy plaintext-only compatibility reader; never resolves a keychain secret.
 * Freebuff CLI tokens must never be used as Codebuff SDK API keys.
 */
export function readFreebuffAuthToken(): string | null {
  const creds = readFreebuffCredentials();
  return creds?.authToken ?? null;
}

/**
 * Reads the local Freebuff credential fields for backwards-compatible
 * migration and diagnostics. No supported provider adapter consumes them.
 */
export function readFreebuffCredentials(): {
  authToken: string;
  fingerprintId: string;
} | null {
  const profile = freebuffConfigDir();
  if (!profile) return null;
  return readFreebuffPlaintextCredentials(profile);
}

// ─── Multi-account Freebuff discovery ────────────────────────────────────────
// Mirrors the codex CLI pattern: scan ~/.config/manicode, ~/.config/manicode2,
// ~/.config/manicode3, etc. for sibling credential directories. Users with
// multiple Freebuff CLI accounts can isolate them with wrappers like
// FREEBUFF_CONFIG_DIR=~/.config/manicode2. Each discovered account gets its own
// model list entry so the user can pick which account to use.

export interface FreebuffAccount {
  id: string;
  label: string;
  profileDir: string;
  /** Legacy plaintext only; empty for keychain references. Never an SDK key. */
  authToken: string;
  fingerprintId: string;
  credentialStorage?: 'plaintext' | 'keychain';
}

/**
 * Discovers Freebuff CLI profiles in ~/.config/manicode* without reading any
 * OS keychain secrets. References are setup evidence, not verified logins.
 * The provider materializes credentials only when starting a private turn.
 */
export function discoverFreebuffAccounts(): FreebuffAccount[] {
  const home = homeDir();
  if (!home) return [];

  const configuredProfile = process.env.FREEBUFF_CONFIG_DIR?.trim();
  const configDir = configuredProfile ? join(configuredProfile, '..') : join(home, '.config');
  if (!existsSync(configDir)) return [];

  // Scan for manicode* directories (manicode, manicode2, manicode-work, etc.)
  let candidateDirs: string[] = [];
  try {
    candidateDirs = readdirSync(configDir)
      .filter((name) => name === 'manicode' || name.startsWith('manicode'))
      .map((name) => join(configDir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
    if (configuredProfile && existsSync(configuredProfile) && !candidateDirs.includes(configuredProfile)) {
      candidateDirs.push(configuredProfile);
    }
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'auth-utils: Freebuff account directory scan failed',
    );
    return [];
  }

  const accounts: FreebuffAccount[] = [];
  for (const dir of candidateDirs) {
    const credPath = join(dir, 'credentials.json');
    if (!existsSync(credPath)) continue;
    try {
      const status = inspectFreebuffCredentials(dir);
      if (status.kind !== 'plaintext' && status.kind !== 'keychain') continue;
      const legacy = status.kind === 'plaintext' ? readFreebuffPlaintextCredentials(dir) : null;
      if (status.kind === 'plaintext' && !legacy) continue;

      const dirName = basename(dir);
      const label =
        dirName === 'manicode' ? 'freebuff' : `freebuff ${dirName.replace(/^manicode[-_]?/, '')}`;

      accounts.push({
        id: `cli:freebuff:${Buffer.from(dir).toString('base64url')}`,
        label: label.replace(/\s+/g, ' ').trim(),
        profileDir: dir,
        authToken: legacy?.authToken ?? '',
        fingerprintId: status.fingerprintId,
        credentialStorage: status.kind,
      });
    } catch {
      // Skip malformed credential files
    }
  }

  return accounts.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Reads Freebuff credentials from a specific account directory (for multi-account
 * support). Falls back to the default readFreebuffCredentials() if profileDir
 * is not provided.
 */
export function readFreebuffCredentialsFrom(profileDir?: string): {
  authToken: string;
  fingerprintId: string;
} | null {
  if (!profileDir) return readFreebuffCredentials();
  return readFreebuffPlaintextCredentials(profileDir);
}

export function detectCursorCLILogin(): boolean {
  if (process.env.CURSOR_API_KEY?.trim()) return true;
  const home = homeDir();
  if (!home) return false;
  const cfg = join(home, '.cursor', 'cli-config.json');
  if (!existsSync(cfg)) return false;
  try {
    const data = JSON.parse(readFileSync(cfg, 'utf-8'));
    return !!(data?.authInfo && Object.keys(data.authInfo).length > 0);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'auth-utils: Cursor cli-config.json parse failed',
    );
    return false;
  }
}

/** The Antigravity CLI (`agy`) API key from the environment. */
export function detectAntigravityApiKey(): string | null {
  const k = process.env.ANTIGRAVITY_API_KEY?.trim();
  return k || null;
}

/**
 * Detects whether the Antigravity CLI is configured: an API key in the environment
 * or the CLI's config dir at ~/.gemini/antigravity-cli/settings.json.
 */
export function detectAntigravityCLILogin(): boolean {
  if (detectAntigravityApiKey()) return true;
  const home = homeDir();
  if (!home) return false;
  return existsSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'));
}

// ─── Kimi Code CLI login detection ──────────────────────────────────────────
// The official `kimi` CLI stores its OAuth device-flow credentials at
// ~/.kimi/credentials/kimi-code.json. Koryphaios can read that session and
// call api.kimi.com/coding/v1 directly with the stored access token (refreshing
// it as needed), so a user who already ran `kimi login` gets the provider
// without a second sign-in. This is a login-signal check only — the token
// itself stays on disk and is read lazily at request time.

/**
 * Detects whether the official `kimi` CLI is logged in: a KIMI_CODE_AUTH_TOKEN
 * in the environment or stored OAuth credentials at ~/.kimi/credentials/kimi-code.json.
 */
export function detectKimiCodeCLILogin(): boolean {
  const envToken = process.env.KIMI_CODE_AUTH_TOKEN?.trim();
  if (envToken) return true;
  const home = homeDir();
  return !!home && existsSync(join(home, '.kimi', 'credentials', 'kimi-code.json'));
}
