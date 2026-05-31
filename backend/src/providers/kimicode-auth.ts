import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform, release as osRelease, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../runtime/paths';

const KIMICODE_AUTH_MARKER_PREFIX = 'oauth:kimicode:';
const KIMICODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMICODE_DEFAULT_OAUTH_HOST = 'https://auth.kimi.com';
const KIMICODE_DEFAULT_VERSION = '1.36.0';
const KIMICODE_REFRESH_THRESHOLD_MS = 5 * 60_000;
const KORY_KIMI_HOME = join(PROJECT_ROOT, '.koryphaios', 'kimi-home');
const KIMICODE_DEVICE_ID_PATH = join(KORY_KIMI_HOME, 'device_id');
const KIMICODE_CREDENTIALS_PATH = join(KORY_KIMI_HOME, 'credentials', 'kimi-code.json');

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

let refreshPromise: Promise<KimiCodeAuthState | null> | null = null;

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

function getDeviceId(): string {
  if (existsSync(KIMICODE_DEVICE_ID_PATH)) {
    return readFileSync(KIMICODE_DEVICE_ID_PATH, 'utf-8').trim();
  }
  mkdirSync(KORY_KIMI_HOME, { recursive: true });
  const deviceId = crypto.randomUUID().replace(/-/g, '');
  writeFileSync(KIMICODE_DEVICE_ID_PATH, deviceId, 'utf-8');
  ensurePrivatePath(KIMICODE_DEVICE_ID_PATH);
  return deviceId;
}

function kimiCommonHeaders(): Record<string, string> {
  const version = process.env.KIMI_CODE_CLI_VERSION || KIMICODE_DEFAULT_VERSION;
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': version,
    'X-Msh-Device-Name': toAsciiHeaderValue(hostname() || homedir().split('/').pop() || 'koryphaios'),
    'X-Msh-Device-Model': toAsciiHeaderValue(deviceModel()),
    'X-Msh-Os-Version': toAsciiHeaderValue(osVersion()),
    'X-Msh-Device-Id': getDeviceId(),
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

export function getKoryKimiHome(): string {
  return KORY_KIMI_HOME;
}

export function createKimiCodeAuthMarker(timestamp = Date.now()): string {
  return `${KIMICODE_AUTH_MARKER_PREFIX}${timestamp}`;
}

export function isKimiCodeAuthMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(KIMICODE_AUTH_MARKER_PREFIX);
}

export function loadKimiCodeAuthState(): KimiCodeAuthState | null {
  if (!existsSync(KIMICODE_CREDENTIALS_PATH)) return null;
  try {
    return parseAuthState(JSON.parse(readFileSync(KIMICODE_CREDENTIALS_PATH, 'utf-8')));
  } catch {
    return null;
  }
}

export function saveKimiCodeAuthState(state: KimiCodeAuthState): void {
  mkdirSync(join(KORY_KIMI_HOME, 'credentials'), { recursive: true });
  writeFileSync(
    KIMICODE_CREDENTIALS_PATH,
    `${JSON.stringify(serializeAuthState(state), null, 2)}\n`,
    'utf-8',
  );
  ensurePrivatePath(KIMICODE_CREDENTIALS_PATH);
}

export function clearKimiCodeAuthState(): void {
  try {
    rmSync(KIMICODE_CREDENTIALS_PATH, { force: true });
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
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`${kimiOAuthHost().replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: kimiCommonHeaders(),
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
  });

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
  });

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

export async function refreshKimiCodeAccessToken(refreshToken: string): Promise<KimiCodeAuthState> {
  const { status, data } = await postKimiOAuthForm('/api/oauth/token', {
    client_id: KIMICODE_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  if (status !== 200 || typeof data.access_token !== 'string' || !data.access_token.trim()) {
    throw new Error(
      String(data.error_description || data.error || `Kimi Code token refresh failed (HTTP ${status})`),
    );
  }

  const token = mapTokenResponse(data);
  saveKimiCodeAuthState(token);
  return token;
}

export async function resolveKimiCodeAccessToken(
  authToken: string | null | undefined,
): Promise<string | null> {
  const trimmed = authToken?.trim();
  if (!trimmed) return null;
  if (!isKimiCodeAuthMarker(trimmed)) return trimmed;

  const state = loadKimiCodeAuthState();
  if (!state) return null;

  const msUntilExpiry = state.expiresAt - Date.now();
  if (msUntilExpiry > KIMICODE_REFRESH_THRESHOLD_MS) {
    return state.accessToken;
  }

  if (!state.refreshToken) return state.accessToken || null;

  if (!refreshPromise) {
    refreshPromise = refreshKimiCodeAccessToken(state.refreshToken)
      .catch((error) => {
        clearKimiCodeAuthState();
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  const refreshed = await refreshPromise;
  return refreshed?.accessToken ?? null;
}
