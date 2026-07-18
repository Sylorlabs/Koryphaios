import { readFileSync, existsSync, rmSync } from 'node:fs';
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
 * Detects the active ChatGPT/Codex access token from Koryphaios's isolated Codex auth state.
 * This is intentionally separate from the user's machine-wide Codex login.
 */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/** The auth.json Koryphaios should use: its own store first, else the user's
 *  machine-wide Codex login — being signed into the codex CLI means you are
 *  signed into Koryphaios; no second login. */
function codexAuthPaths(): string[] {
  const paths = [join(KORY_CODEX_HOME, 'auth.json')];
  const home = homeDir();
  if (home) {
    paths.push(join(home, '.codex', 'auth.json'));
    try {
      for (const entry of require('node:fs').readdirSync(home) as string[]) {
        if (!entry.startsWith('.codex') || entry === '.codex') continue;
        paths.push(join(home, entry, 'auth.json'));
      }
    } catch {
      // A missing/unreadable home simply means no additional CLI profiles.
    }
  }
  return paths;
}

function readCodexAuthFile(path: string): { tokens?: { access_token?: string; refresh_token?: string } } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Refresh the ChatGPT/Codex token natively (no codex binary) and persist the
 *  new pair back to the auth.json it came from. Returns the fresh token. */
export async function refreshCodexAuthToken(marker?: string | null): Promise<string | null> {
  const selectedPath = codexMarkerAuthPath(marker);
  for (const path of selectedPath ? [selectedPath] : codexAuthPaths()) {
    if (!existsSync(path)) continue;
    const data = readCodexAuthFile(path);
    const refreshToken = data?.tokens?.refresh_token;
    if (!refreshToken) continue;
    try {
      const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CODEX_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
          scope: 'openid profile email',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
      if (!j.access_token) continue;
      const merged = {
        ...(data as Record<string, unknown>),
        tokens: {
          ...(data?.tokens ?? {}),
          access_token: j.access_token,
          ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}),
          ...(j.id_token ? { id_token: j.id_token } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      writeFileSync(path, JSON.stringify(merged, null, 2), 'utf-8');
      clearCachedToken(selectedPath ? `codex-cli-auth:${selectedPath}` : 'codex-cli-auth');
      return j.access_token;
    } catch {
      /* try the next store */
    }
  }
  return null;
}

function codexMarkerAuthPath(marker?: string | null): string | null {
  if (!marker?.startsWith(CODEX_CLI_AUTH_PREFIX)) return null;
  const encoded = marker.slice(CODEX_CLI_AUTH_PREFIX.length);
  if (!encoded || /^\d+$/.test(encoded)) return null;
  try {
    const profileDir = Buffer.from(encoded, 'base64url').toString('utf8');
    const home = homeDir();
    if (!home || (!profileDir.startsWith(`${home}/.codex`) && profileDir !== KORY_CODEX_HOME)) return null;
    return join(profileDir, 'auth.json');
  } catch {
    return null;
  }
}

function jwtExpiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function createCodexCLIProfileMarker(profileDir: string): string {
  return `${CODEX_CLI_AUTH_PREFIX}${Buffer.from(profileDir).toString('base64url')}`;
}

export function detectCodexAuthToken(marker?: string | null): string | null {
  const selectedPath = codexMarkerAuthPath(marker);
  const cacheKey = selectedPath ? `codex-cli-auth:${selectedPath}` : 'codex-cli-auth';
  return getCachedToken(cacheKey, () => {
    const candidates = selectedPath ? [selectedPath] : codexAuthPaths();
    if (!selectedPath) {
      const identities = new Set<string>();
      for (const authPath of candidates) {
        const data = readCodexAuthFile(authPath);
        const accountId = (data as any)?.tokens?.account_id;
        const token = data?.tokens?.access_token;
        if (typeof token === 'string' && token.trim()) {
          identities.add(typeof accountId === 'string' && accountId ? accountId : authPath);
        }
      }
      // Multiple verified identities require an explicit profile marker. Never
      // silently select a personal/work subscription based on directory order.
      if (identities.size > 1) return null;
    }
    let expiredFallback: string | null = null;
    for (const authPath of candidates) {
      if (!existsSync(authPath)) continue;
      const accessToken = readCodexAuthFile(authPath)?.tokens?.access_token;
      if (typeof accessToken === 'string' && accessToken.trim()) {
        const token = accessToken.trim();
        const expiresAt = jwtExpiresAt(token);
        if (expiresAt == null || expiresAt > Date.now()) return token;
        expiredFallback ??= token;
      }
    }
    return expiredFallback;
  });
}

export function clearCodexAuthState(): void {
  const authPath = join(KORY_CODEX_HOME, 'auth.json');
  try {
    rmSync(authPath, { force: true });
  } catch {
    // Ignore cleanup failures; callers treat missing auth state as signed out.
  }
  clearCachedToken('codex-cli-auth');
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

/**
 * Detects a machine-wide Codex CLI login at ~/.codex/auth.json. This is separate from
 * Koryphaios's isolated codex-home (see detectCodexAuthToken) and is informational —
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
    return Object.values(data).some((v) => typeof v === 'string' && v.length > 0);
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
