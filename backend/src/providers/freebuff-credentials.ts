import { execFile, type ExecFileOptions } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Verified against native Freebuff 0.2.12 (npm launcher 0.0.173):
 * fa = userSchema.extend({authToken: string.optional(), tokenStore: literal('keychain').optional()});
 * ya({isFreebuff, credentialsPath}) -> Bun.secrets.{get,set,delete}({service:'freebuff-cli', name:credentialsPath}).
 * credentialsPath = path.join(FREEBUFF_CONFIG_DIR || ~/.config/manicode, 'credentials.json').
 * The account is NOT email, user id, fingerprint, a hash, or the private turn path.
 * Bun's Darwin backend maps service/name to generic-password service/account.
 * No keychain discovery, mutation, API-key conversion, or authentication probe belongs here.
 */
const KEYCHAIN_SERVICE = 'freebuff-cli';
// The OS may show its own access prompt. Give the user time to approve it;
// cancellation and a hard deadline still kill the narrowly addressed request.
export const FREEBUFF_KEYCHAIN_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const UNSUPPORTED =
  'Freebuff CLI keychain references are detected, but this host keychain is not supported. ' +
  'Use a Freebuff CLI-owned plaintext login profile, or sign in with the real CLI in a dedicated isolated Linux runtime profile; do not use a Codebuff SDK key.';
const INVALID =
  'Freebuff CLI credentials are missing, malformed, or unsafe. Open Freebuff and sign in again in the selected profile.';
const KEYCHAIN_FAILED =
  'Freebuff CLI keychain access failed or timed out. Unlock the macOS login keychain, allow access to the Freebuff CLI item if prompted, and retry; otherwise open Freebuff and sign in again.';

export type FreebuffCredentialStatus =
  | { kind: 'missing' | 'invalid'; supported: false; reason: string }
  | {
      kind: 'plaintext' | 'keychain';
      supported: boolean;
      fingerprintId: string;
      reason?: string;
    };

type CredentialRecord = Record<string, unknown> & { authToken?: string; tokenStore?: 'keychain' };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_TOKEN_BYTES &&
    !/[\s\x00-\x1f\x7f]/u.test(value)
  );
}

function credentialPath(profileDir: string): string {
  if (!isAbsolute(profileDir) || /[\x00-\x1f\x7f]/u.test(profileDir)) throw new Error(INVALID);
  // Deliberately do NOT realpath or case-fold: the CLI uses path.join, not realpath.
  return join(profileDir, 'credentials.json');
}

function readRecord(profileDir: string): CredentialRecord {
  const path = credentialPath(profileDir);
  if (!lstatSync(profileDir).isDirectory()) throw new Error(INVALID);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_CREDENTIAL_BYTES ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    )
      throw new Error(INVALID);
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    try {
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_CREDENTIAL_BYTES) throw new Error(INVALID);
      const data: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (!record(data) || !record(data.default)) throw new Error(INVALID);
      const value = data.default;
      // Never accept user-supplied service/account descriptors or unknown storage schemes.
      if (value.tokenStore !== undefined && value.tokenStore !== 'keychain')
        throw new Error(INVALID);
      if (value.authToken !== undefined && !validToken(value.authToken)) throw new Error(INVALID);
      if (!value.authToken && value.tokenStore !== 'keychain') throw new Error(INVALID);
      for (const key of ['id', 'email', 'fingerprintId', 'fingerprintHash']) {
        if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(INVALID);
      }
      if (value.name != null && typeof value.name !== 'string') throw new Error(INVALID);
      if (
        value.credits !== undefined &&
        (typeof value.credits !== 'number' || !Number.isFinite(value.credits))
      )
        throw new Error(INVALID);
      // Current keychain schema requires email; older portable records only required a fingerprint.
      if (!value.authToken && typeof value.email !== 'string') throw new Error(INVALID);
      return value as CredentialRecord;
    } finally {
      buffer.fill(0);
    }
  } finally {
    closeSync(fd);
  }
}

/** Reads local file metadata/legacy material only; NEVER resolves an OS secret. */
export function inspectFreebuffCredentials(
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): FreebuffCredentialStatus {
  try {
    const value = readRecord(profileDir);
    const kind = value.authToken ? 'plaintext' : 'keychain';
    const supported = kind === 'plaintext' || platform === 'darwin';
    return {
      kind,
      supported,
      fingerprintId: typeof value.fingerprintId === 'string' ? value.fingerprintId : '',
      ...(!supported ? { reason: UNSUPPORTED } : {}),
    };
  } catch (error) {
    return {
      kind: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'invalid',
      supported: false,
      reason: INVALID,
    };
  }
}

/** Legacy-only compatibility reader. A keychain marker NEVER causes a secret lookup here. */
export function readFreebuffPlaintextCredentials(profileDir: string): {
  authToken: string;
  fingerprintId: string;
} | null {
  try {
    const value = readRecord(profileDir);
    if (!value.authToken || typeof value.fingerprintId !== 'string' || !value.fingerprintId)
      return null;
    return { authToken: value.authToken, fingerprintId: value.fingerprintId };
  } catch {
    return null;
  }
}

/** Injection is only for synthetic tests; production callers omit the second argument. */
export interface FreebuffCredentialDependencies {
  platform: NodeJS.Platform;
  execFile: (
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
  ) => unknown;
}

function readKeychainToken(
  profileDir: string,
  dependencies: FreebuffCredentialDependencies,
  signal?: AbortSignal,
): Promise<string> {
  if (dependencies.platform !== 'darwin') return Promise.reject(new Error(UNSUPPORTED));
  // Both selectors are derived here, never taken from credential JSON or caller-supplied references.
  const account = credentialPath(profileDir);
  return new Promise((resolve, reject) => {
    try {
      dependencies.execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
        {
          encoding: 'utf8',
          timeout: FREEBUFF_KEYCHAIN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_TOKEN_BYTES + 2,
          shell: false,
          windowsHide: true,
          cwd: '/',
          // Do not inherit DYLD_*, provider credentials, or executable search paths.
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
          signal,
        },
        (error, stdout) => {
          // Child-process errors may contain secret stdout/stderr. Never forward or log them.
          if (error || signal?.aborted) return reject(new Error(KEYCHAIN_FAILED));
          const raw = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
          const token = raw.replace(/\r?\n$/, '');
          if (Buffer.isBuffer(stdout)) stdout.fill(0);
          if (!validToken(token)) return reject(new Error(KEYCHAIN_FAILED));
          resolve(token);
        },
      );
    } catch {
      reject(new Error(KEYCHAIN_FAILED));
    }
  });
}

function privateDirectory(path: string, create: boolean): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('unsafe private directory');
}

/**
 * Provider-only runtime pathway. Call before starting the isolated CLI, inside its cleanup try/finally.
 * runHome MUST be an existing private (0700), caller-owned, per-turn directory. The target file must
 * not already exist. Returns no secret; caller removes the entire turn root after runtime teardown.
 * Only the default CLI auth fields are transported, not other accounts/BYOK credentials.
 */
export async function materializeFreebuffCredentials(
  options: { profileDir: string; runHome: string; signal?: AbortSignal },
  dependencies: FreebuffCredentialDependencies = { platform: process.platform, execFile },
): Promise<{ credentialsPath: string; storage: 'plaintext' | 'keychain' }> {
  let value: CredentialRecord;
  try {
    value = readRecord(options.profileDir);
  } catch {
    throw new Error(INVALID);
  }
  const storage = value.authToken ? 'plaintext' : 'keychain';
  if (storage === 'keychain' && dependencies.platform !== 'darwin') throw new Error(UNSUPPORTED);
  const target = join(options.runHome, '.config', 'manicode', 'credentials.json');
  let fd: number;
  try {
    if (!isAbsolute(options.runHome) || normalize(options.runHome) !== options.runHome)
      throw new Error();
    privateDirectory(options.runHome, false);
    const sourceRoot = realpathSync(options.profileDir);
    const targetRoot = realpathSync(options.runHome);
    if (
      sourceRoot === targetRoot ||
      targetRoot.startsWith(sourceRoot + sep) ||
      sourceRoot.startsWith(targetRoot + sep)
    )
      throw new Error();
    privateDirectory(join(options.runHome, '.config'), true);
    privateDirectory(join(options.runHome, '.config', 'manicode'), true);
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error('Freebuff requires a fresh private per-turn HOME to stage CLI credentials.');
  }
  let completed = false;
  try {
    if (options.signal?.aborted) throw new Error('Freebuff credential staging was cancelled.');
    const authToken =
      value.authToken ??
      (await readKeychainToken(options.profileDir, dependencies, options.signal));
    if (options.signal?.aborted) throw new Error('Freebuff credential staging was cancelled.');
    const staged: Record<string, unknown> = { authToken };
    for (const key of ['id', 'name', 'email', 'fingerprintId', 'fingerprintHash', 'credits']) {
      if (value[key] !== undefined) staged[key] = value[key];
    }
    // No tokenStore: the isolated Linux CLI must use this private portable token, not the host keychain.
    try {
      writeFileSync(fd, JSON.stringify({ default: staged }), { encoding: 'utf8' });
    } catch {
      throw new Error('Freebuff could not stage private CLI credentials.');
    }
    completed = true;
    return { credentialsPath: target, storage };
  } finally {
    closeSync(fd);
    if (!completed) {
      try {
        unlinkSync(target);
      } catch {
        /* Provider finally also removes the turn root. */
      }
    }
  }
}
