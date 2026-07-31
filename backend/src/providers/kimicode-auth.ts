import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform, release as osRelease, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';

const KIMICODE_AUTH_MARKER_PREFIX = 'oauth:kimicode:';
const KIMICODE_CLI_MARKER_PREFIX = 'cli:kimicode:';
const KIMICODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMICODE_DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
const KIMICODE_DEFAULT_VERSION = '1.36.0';
const KIMICODE_REFRESH_THRESHOLD_MS = 5 * 60_000;
const KORY_KIMI_HOME = join(PROJECT_ROOT, '.koryphaios', 'kimi-home');
const KIMI_CLI_DEFAULT_HOME = join(homedir(), '.kimi');

type KimiCodeOAuthFile = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  token_type?: string;
  expires_in?: number;
};

export type KimiCodeAuthState = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
  expiresIn?: number;
};

export type KimiCodeDeviceAuthStart = {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type KimiCodeDeviceAuthPoll = {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
  error?: string;
  errorDescription?: string;
};

// Per-profile refresh deduplication so two concurrent requests for the same
// profile share one refresh round-trip, while different profiles refresh
// independently.
const refreshPromises = new Map<string, Promise<KimiCodeAuthState | null>>();

function kimiOAuthHost(): string {
  return process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || KIMICODE_DEFAULT_OAUTH_HOST;
}

function ensurePrivatePath(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Ignore permission adjustment failures.
  }
}

function toAsciiHeaderValue(value: string, fallback = 'unknown'): string {
  if (/[^\x20-\x7E]/.test(value)) {
    const sanitized = value.replace(/[^\x20-\x7E]/g, '').trim();
    return sanitized || fallback;
  }
  return value.trim() || fallback;
}

function deviceModel(): string {
  const system = osPlatform();
  const version = osRelease();
  return `${system} ${version}`.trim();
}

/** Resolve the device_id for a given profile dir, creating it on first use.
 *  The kimi-cli binds issued JWTs to a stable device id, so each profile
 *  keeps its own (the managed session at KORY_KIMI_HOME and each discovered
 *  ~/.kimi* dir are independent devices). */
function getDeviceId(profileDir: string): string {
  const devicePath = join(profileDir, 'device_id');
  if (existsSync(devicePath)) {
    return readFileSync(devicePath, 'utf-8').trim();
  }
  mkdirSync(profileDir, { recursive: true });
  const deviceId = crypto.randomUUID().replace(/-/g, '');
  writeFileSync(devicePath, deviceId, 'utf-8');
  ensurePrivatePath(devicePath);
  return deviceId;
}

function kimiCommonHeaders(profileDir: string): Record<string, string> {
  const version = process.env.KIMI_CODE_CLI_VERSION || KIMICODE_DEFAULT_VERSION;
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': version,
    'X-Msh-Device-Name': toAsciiHeaderValue(hostname() || homedir().split('/').pop() || 'koryphaios'),
    'X-Msh-Device-Model': toAsciiHeaderValue(deviceModel()),
    'X-Msh-Os-Version': toAsciiHeaderValue(osVersion()),
    'X-Msh-Device-Id': getDeviceId(profileDir),
  };
}

function parseAuthState(payload: unknown): KimiCodeAuthState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Partial<KimiCodeOAuthFile>;
  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) return null;
  if (typeof raw.refresh_token !== 'string' || !raw.refresh_token.trim()) return null;
  const expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at : Number(raw.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return {
    accessToken: raw.access_token.trim(),
    refreshToken: raw.refresh_token.trim(),
    expiresAt,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
    expiresIn: typeof raw.expires_in === 'number' ? raw.expires_in : Number(raw.expires_in || 0) || undefined,
  };
}

function serializeAuthState(state: KimiCodeAuthState): KimiCodeOAuthFile {
  return {
    access_token: state.accessToken,
    refresh_token: state.refreshToken,
    expires_at: state.expiresAt,
    ...(state.scope ? { scope: state.scope } : {}),
    ...(state.tokenType ? { token_type: state.tokenType } : {}),
    ...(state.expiresIn ? { expires_in: state.expiresIn } : {}),
  };
}

function credentialsPathFor(profileDir: string): string {
  return join(profileDir, 'credentials', 'kimi-code.json');
}

export function getKoryKimiHome(): string {
  return KORY_KIMI_HOME;
}

// ── Managed session (device flow) markers ───────────────────────────────────
// The managed session lives at KORY_KIMI_HOME and is created by Koryphaios's
// own device-flow sign-in. The marker is a non-secret opt-in flag.

export function createKimiCodeAuthMarker(timestamp = Date.now()): string {
  return `${KIMICODE_AUTH_MARKER_PREFIX}${timestamp}`;
}

export function isKimiCodeAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(KIMICODE_AUTH_MARKER_PREFIX);
}

// ── CLI profile markers ─────────────────────────────────────────────────────
// A CLI profile marker points at a discovered ~/.kimi* directory. The
// profile dir is base64url-encoded so the marker is a single opaque string
// the registry can store as an authToken. The token itself stays on disk in
// the profile dir and is read lazily at request time.

export function createKimiCodeCliMarker(profileDir: string): string {
  return `${KIMICODE_CLI_MARKER_PREFIX}${Buffer.from(profileDir).toString('base64url')}`;
}

export function isKimiCodeCliMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(KIMICODE_CLI_MARKER_PREFIX);
}

/** Decode the profile dir from a CLI marker. Returns null for malformed markers. */
export function kimiCodeCliMarkerProfileDir(value: string): string | null {
  if (!isKimiCodeCliMarker(value)) return null;
  try {
    const decoded = Buffer.from(value.slice(KIMICODE_CLI_MARKER_PREFIX.length), 'base64url').toString('utf-8');
    return decoded || null;
  } catch {
    return null;
  }
}

/** True for any Kimi Code marker (managed or CLI profile). */
export function isKimiCodeMarker(value: string | null | undefined): boolean {
  return isKimiCodeAuthMarker(value) || isKimiCodeCliMarker(value);
}

/** Resolve the profile dir a marker points at, or null for raw tokens. */
export function kimiCodeMarkerProfileDir(value: string): string | null {
  if (isKimiCodeAuthMarker(value)) return KORY_KIMI_HOME;
  return kimiCodeCliMarkerProfileDir(value);
}

// ── Auth state load / save / clear (profile-dir aware) ──────────────────────

export function loadKimiCodeAuthState(profileDir: string = KORY_KIMI_HOME): KimiCodeAuthState | null {
  const path = credentialsPathFor(profileDir);
  if (!existsSync(path)) return null;
  try {
    return parseAuthState(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

export function saveKimiCodeAuthState(state: KimiCodeAuthState, profileDir: string = KORY_KIMI_HOME): void {
  const path = credentialsPathFor(profileDir);
  mkdirSync(join(profileDir, 'credentials'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializeAuthState(state), null, 2)}\n`, 'utf-8');
  ensurePrivatePath(path);
}

export function clearKimiCodeAuthState(profileDir: string = KORY_KIMI_HOME): void {
  try {
    rmSync(credentialsPathFor(profileDir), { force: true });
  } catch {
    // Ignore cleanup failures; callers treat missing auth state as signed out.
  }
}

function mapTokenResponse(payload: Record<string, unknown>): KimiCodeAuthState {
  const expiresIn = Number(payload.expires_in || 0);
  return {
    accessToken: String(payload.access_token || '').trim(),
    refreshToken: String(payload.refresh_token || '').trim(),
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1000,
    scope: payload.scope ? String(payload.scope) : undefined,
    tokenType: payload.token_type ? String(payload.token_type) : undefined,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined,
  };
}

async function postKimiOAuthForm(
  path: string,
  body: Record<string, string>,
  profileDir: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${kimiOAuthHost().replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: kimiCommonHeaders(profileDir),
    body: new URLSearchParams(body),
  });

  let data: Record<string, unknown> = {};
  try {
    const json = await response.json();
    if (json && typeof json === 'object') {
      data = json as Record<string, unknown>;
    }
  } catch {
    // Leave as empty object for callers to handle.
  }

  return { status: response.status, data };
}

export async function startKimiCodeDeviceAuth(): Promise<KimiCodeDeviceAuthStart> {
  const { status, data } = await postKimiOAuthForm('/api/oauth/device_authorization', {
    client_id: KIMICODE_CLIENT_ID,
  }, KORY_KIMI_HOME);

  if (status !== 200) {
    throw new Error(
      String(data.error_description || data.error || `Kimi Code device authorization failed (HTTP ${status})`),
    );
  }

  return {
    userCode: String(data.user_code || ''),
    deviceCode: String(data.device_code || ''),
    verificationUri: String(data.verification_uri || ''),
    verificationUriComplete: String(data.verification_uri_complete || data.verification_uri || ''),
    expiresIn: Math.max(1, Number(data.expires_in || 900)),
    interval: Math.max(1, Number(data.interval || 5)),
  };
}

export async function pollKimiCodeDeviceAuth(deviceCode: string): Promise<KimiCodeDeviceAuthPoll> {
  const { status, data } = await postKimiOAuthForm('/api/oauth/token', {
    client_id: KIMICODE_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }, KORY_KIMI_HOME);

  if (status === 200 && typeof data.access_token === 'string' && data.access_token.trim()) {
    const token = mapTokenResponse(data);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: token.tokenType,
      scope: token.scope,
      expiresIn: token.expiresIn,
    };
  }

  return {
    error: typeof data.error === 'string' ? data.error : `http_${status}`,
    errorDescription:
      typeof data.error_description === 'string'
        ? data.error_description
        : `Kimi Code token request failed (HTTP ${status})`,
  };
}

/** Refresh the access token for a given profile dir, writing the refreshed
 *  state back to that dir. Uses the profile's own device_id in the request
 *  headers so the refresh is bound to the same device that originally
 *  authenticated. */
export async function refreshKimiCodeAccessToken(
  refreshToken: string,
  profileDir: string = KORY_KIMI_HOME,
): Promise<KimiCodeAuthState> {
  const { status, data } = await postKimiOAuthForm('/api/oauth/token', {
    client_id: KIMICODE_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, profileDir);

  if (status !== 200 || typeof data.access_token !== 'string' || !data.access_token.trim()) {
    throw new Error(
      String(data.error_description || data.error || `Kimi Code token refresh failed (HTTP ${status})`),
    );
  }

  const token = mapTokenResponse(data);
  saveKimiCodeAuthState(token, profileDir);
  return token;
}

/** Resolve a Kimi Code authToken to a live access token.
 *
 *  - Raw token string: returned as-is (direct API key or pre-resolved token).
 *  - `oauth:kimicode:` marker: loads the managed session at KORY_KIMI_HOME.
 *  - `cli:kimicode:` marker: loads the CLI profile at the encoded profile dir.
 *
 *  Tokens near expiry are refreshed automatically (single-flight per profile). */
export async function resolveKimiCodeAccessToken(
  authToken: string | null | undefined,
): Promise<string | null> {
  const trimmed = authToken?.trim();
  if (!trimmed) return null;

  const profileDir = kimiCodeMarkerProfileDir(trimmed);
  if (!profileDir) return trimmed; // raw token — use directly

  const state = loadKimiCodeAuthState(profileDir);
  if (!state) return null;

  const msUntilExpiry = state.expiresAt - Date.now();
  if (msUntilExpiry > KIMICODE_REFRESH_THRESHOLD_MS) {
    return state.accessToken;
  }

  if (!state.refreshToken) return state.accessToken || null;

  let promise = refreshPromises.get(profileDir);
  if (!promise) {
    promise = refreshKimiCodeAccessToken(state.refreshToken, profileDir)
      .catch((error) => {
        clearKimiCodeAuthState(profileDir);
        throw error;
      })
      .finally(() => {
        refreshPromises.delete(profileDir);
      });
    refreshPromises.set(profileDir, promise);
  }

  const refreshed = await promise;
  return refreshed?.accessToken ?? null;
}

/** The default ~/.kimi home used by the official `kimi` CLI. */
export function getKimiCliDefaultHome(): string {
  return KIMI_CLI_DEFAULT_HOME;
}
