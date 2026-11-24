import { hostOS } from '../runtime/platform';
import { execFile } from 'node:child_process';
import {
  closeSync, constants, fstatSync, mkdtempSync, mkdirSync, openSync,
  readSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 256 * 1024;
const NATIVE_TOKEN_PATH = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'];
const INVALID = 'Antigravity login is missing or cannot be transferred. Sign in with the real CLI and retry.';

/** Native agy OAuth record, never converted into an API key. */
export function validateAntigravityCredential(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw new Error(INVALID);
  let record: Record<string, unknown>;
  try { record = JSON.parse(value); } catch { throw new Error(INVALID); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(INVALID);
  const token = record.token as Record<string, unknown> | undefined;
  if (!token || typeof token !== 'object' || Array.isArray(token) ||
      typeof token.access_token !== 'string' || !token.access_token ||
      typeof token.refresh_token !== 'string' || !token.refresh_token ||
      typeof token.expiry !== 'string' || !Number.isFinite(Date.parse(token.expiry))) {
    throw new Error(INVALID);
  }
  // Only CLI-owned authentication fields cross the device boundary. A native
  // record cannot smuggle settings, MCP servers, hooks, paths or environment.
  return JSON.stringify({
    token: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expiry: token.expiry,
      ...(typeof token.token_type === 'string' && { token_type: token.token_type }),
    },
    ...(typeof record.auth_method === 'string' && { auth_method: record.auth_method }),
    ...(typeof record.id_token === 'string' && { id_token: record.id_token }),
  });
}

function readNativeFile(home: string): string {
  const fd = openSync(join(home, ...NATIVE_TOKEN_PATH), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error(INVALID);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    try {
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_BYTES) throw new Error(INVALID);
      return validateAntigravityCredential(buffer.subarray(0, size).toString('utf8'));
    } finally { buffer.fill(0); }
  } finally { closeSync(fd); }
}

/** Address exactly agy's known service/account; never enumerate the keychain. */
function readNativeKeychain(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      { timeout: 60_000, maxBuffer: MAX_BYTES, signal }, (error, stdout) => {
        if (error) { reject(new Error(INVALID)); return; }
        try {
          const encoded = stdout.trim();
          const prefix = 'go-keyring-base64:';
          const raw = encoded.startsWith(prefix)
            ? Buffer.from(encoded.slice(prefix.length), 'base64').toString('utf8') : encoded;
          resolve(validateAntigravityCredential(raw));
        } catch { reject(new Error(INVALID)); }
      });
  });
}

export async function readPortableAntigravityCredential(options: {
  home?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  readKeychain?: (signal?: AbortSignal) => Promise<string>;
} = {}): Promise<string> {
  options.signal?.throwIfAborted();
  // Prefer the CLI-owned portable record when it exists. Reading the keychain
  // first on every device bundle build caused a consent/keychain lookup on
  // every Antigravity turn, even when agy already had a valid disk login.
  // The keychain remains a narrowly scoped fallback for keyring-only logins.
  try {
    return readNativeFile(options.home ?? homedir());
  } catch {
    options.signal?.throwIfAborted();
  }
  if ((options.platform ?? hostOS()) === 'darwin') {
    try {
      return validateAntigravityCredential(await (options.readKeychain ?? readNativeKeychain)(options.signal));
    } catch { options.signal?.throwIfAborted(); }
  }
  throw new Error(INVALID);
}

/** Fresh private home per run. No links to, or writes into, the user's login. */
export function stageAntigravityCredential(value: unknown, parent = tmpdir()): {
  home: string;
  cleanup: () => void;
} {
  const credential = validateAntigravityCredential(value);
  const home = mkdtempSync(join(parent, 'kory-device-agy-'));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    const dir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'antigravity-oauth-token'), credential, { mode: 0o600, flag: 'wx' });
    return { home, cleanup };
  } catch { cleanup(); throw new Error('Could not stage a private Antigravity login on the target.'); }
}
