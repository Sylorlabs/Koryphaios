/**
 * Short-lived device-code recovery.
 *
 * Only the device authorization transaction is kept, in `sessionStorage`, so
 * a renderer reload can resume polling. Provider tokens and refresh tokens are
 * deliberately never handled here and never enter localStorage.
 */

export type DeviceAuthProvider = 'copilot' | 'kimicode' | 'codex-auth';

export type RecoverableDeviceAuth = {
  deviceAuthId?: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
};

type StoredFlows = Partial<Record<DeviceAuthProvider, RecoverableDeviceAuth>>;

const STORAGE_KEY = 'koryphaios-device-auth-recovery-v1';
const PROVIDERS = new Set<DeviceAuthProvider>(['copilot', 'kimicode', 'codex-auth']);

function safeSessionStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  if (typeof sessionStorage === 'undefined') return undefined;
  return sessionStorage;
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanFlow(value: unknown, now = Date.now()): RecoverableDeviceAuth | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.deviceCode !== 'string' ||
    !raw.deviceCode ||
    raw.deviceCode.length > 4_096 ||
    typeof raw.userCode !== 'string' ||
    !raw.userCode ||
    raw.userCode.length > 256 ||
    !validUrl(raw.verificationUri) ||
    typeof raw.expiresAt !== 'number' ||
    !Number.isFinite(raw.expiresAt) ||
    raw.expiresAt <= now ||
    typeof raw.intervalMs !== 'number' ||
    !Number.isFinite(raw.intervalMs)
  )
    return null;

  return {
    deviceCode: raw.deviceCode,
    userCode: raw.userCode,
    verificationUri: raw.verificationUri,
    ...(validUrl(raw.verificationUriComplete)
      ? { verificationUriComplete: raw.verificationUriComplete }
      : {}),
    ...(typeof raw.deviceAuthId === 'string' && raw.deviceAuthId
      ? { deviceAuthId: raw.deviceAuthId.slice(0, 512) }
      : {}),
    expiresAt: raw.expiresAt,
    intervalMs: Math.min(60_000, Math.max(1_000, Math.round(raw.intervalMs))),
  };
}

function readFlows(storage?: Storage, now = Date.now()): StoredFlows {
  const session = safeSessionStorage(storage);
  if (!session) return {};
  try {
    const parsed = JSON.parse(session.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: StoredFlows = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!PROVIDERS.has(provider as DeviceAuthProvider)) continue;
      const flow = cleanFlow(value, now);
      if (flow) result[provider as DeviceAuthProvider] = flow;
    }
    return result;
  } catch {
    return {};
  }
}

function writeFlows(flows: StoredFlows, storage?: Storage): void {
  const session = safeSessionStorage(storage);
  if (!session) return;
  try {
    if (Object.keys(flows).length === 0) {
      session.removeItem(STORAGE_KEY);
      return;
    }
    session.setItem(STORAGE_KEY, JSON.stringify(flows));
  } catch {
    // The provider auth UI remains usable even when browser session storage is
    // disabled. The next reload simply cannot resume the short-lived code.
  }
}

export function loadRecoverableDeviceAuthFlows(storage?: Storage, now = Date.now()): StoredFlows {
  const flows = readFlows(storage, now);
  // Also prune expired or malformed stale records as soon as they are seen.
  writeFlows(flows, storage);
  return flows;
}

export function saveRecoverableDeviceAuthFlow(
  provider: DeviceAuthProvider,
  flow: RecoverableDeviceAuth,
  storage?: Storage,
): boolean {
  const clean = cleanFlow(flow);
  if (!clean) return false;
  const flows = readFlows(storage);
  flows[provider] = clean;
  writeFlows(flows, storage);
  return true;
}

export function clearRecoverableDeviceAuthFlow(
  provider: DeviceAuthProvider,
  storage?: Storage,
): void {
  const flows = readFlows(storage);
  delete flows[provider];
  writeFlows(flows, storage);
}
