import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';

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
const GROK_CLI_AUTH_PREFIX = 'cli:grok:';
const ANTIGRAVITY_CLI_AUTH_PREFIX = 'cli:antigravity:';
const KORY_CODEX_HOME = join(PROJECT_ROOT, '.koryphaios', 'codex-home');

/** Grok Build CLI opt-in marker — the CLI owns its own auth (subscription or XAI key). */
export function isGrokCLIAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(GROK_CLI_AUTH_PREFIX);
}
export function createGrokCLIAuthMarker(): string {
  return `${GROK_CLI_AUTH_PREFIX}${Date.now()}`;
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
        } catch {
          // Ignore malformed config files
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
 * Detects whether the Claude Code CLI is logged in (Pro/Max subscription or OAuth),
 * without depending on the exact on-disk token format. Returns true if any recognized
 * login signal is present. The CLI remains the source of truth for the actual token.
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
          } catch {
            // Ignore malformed config
          }
        }

        return null;
      },
      { cacheNull: false },
    ) === 'yes'
  );
}

// ─── Agent-CLI login detection ──────────────────────────────────────────────
// Koryphaios auto-detects agent CLIs installed + logged-in on the user's machine
// (Claude Code, Codex, Antigravity CLI, Grok Build, Cursor) so their providers light up
// with no manual configuration. These helpers detect a login signal WITHOUT holding
// the raw credential where a CLI/subscription owns it.

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

const CLINE_AUTH_KEY_HINTS = [
  'token',
  'apikey',
  'api_key',
  'api-key',
  'access_token',
  'access-token',
  'refresh_token',
  'refresh-token',
  'secret',
  'secret_key',
  'secret-key',
  'auth',
  'auth_token',
  'auth-token',
  'authorization',
  'credential',
  'credentials',
  'session',
];

function hasClineAuthKeyHint(key: string): boolean {
  const normalized = key.toLowerCase();
  return CLINE_AUTH_KEY_HINTS.some((hint) => normalized.includes(hint));
}

function looksLikeClineAuthValue(value: string): boolean {
  const token = value.trim();
  if (!token || token === 'cline-cli-session') return false;
  if (token.length < 16) return false;
  if (token.length > 3_000) return false;
  if (/\s/.test(token)) return false;
  // API keys are usually encoded tokens. For unknown formats, we only
  // accept sufficiently long opaque values or JWT-like structures.
  if (/^[A-Za-z0-9._~+/\-=%$@]+$/u.test(token)) return true;
  return token.split('.').length >= 2;
}

function isClineAuthValue(value: unknown, key: string): boolean {
  return typeof value === 'string' && hasClineAuthKeyHint(key) && looksLikeClineAuthValue(value);
}

function hasClineCLILoginSignal(node: unknown, key: string): boolean {
  if (typeof node === 'string') return isClineAuthValue(node, key);
  if (!node || typeof node !== 'object') return false;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (hasClineCLILoginSignal(item, key)) return true;
    }
    return false;
  }

  for (const [entryKey, entryValue] of Object.entries(node as Record<string, unknown>)) {
    if (hasClineCLILoginSignal(entryValue, entryKey)) return true;
  }
  return false;
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
  } catch {
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

/**
 * Detects whether the Cursor CLI (cursor-agent) is logged in: a CURSOR_API_KEY in the
 * environment or stored auth in ~/.cursor/cli-config.json (the `authInfo` block).
 */
export function detectClineCLILogin(): boolean {
  const home = homeDir();
  if (!home) return false;
  const secrets = join(home, '.cline', 'data', 'secrets.json');
  if (!existsSync(secrets)) return false;
  try {
    const data = JSON.parse(readFileSync(secrets, 'utf-8')) as Record<string, unknown>;
    return hasClineCLILoginSignal(data, 'secrets');
  } catch {
    return false;
  }
}
export function isClineCLIAuthMarker(value: string | null | undefined): boolean {
  return value === 'cline-cli-session';
}
export function createClineCLIAuthMarker(): string {
  return 'cline-cli-session';
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

export function detectCursorCLILogin(): boolean {
  if (process.env.CURSOR_API_KEY?.trim()) return true;
  const home = homeDir();
  if (!home) return false;
  const cfg = join(home, '.cursor', 'cli-config.json');
  if (!existsSync(cfg)) return false;
  try {
    const data = JSON.parse(readFileSync(cfg, 'utf-8'));
    return !!(data?.authInfo && Object.keys(data.authInfo).length > 0);
  } catch {
    return false;
  }
}

/** Google Jules API key from the environment (https://jules.google.com/settings#api). */
export function detectJulesApiKey(): string | null {
  const k = process.env.JULES_API_KEY?.trim();
  return k || null;
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
