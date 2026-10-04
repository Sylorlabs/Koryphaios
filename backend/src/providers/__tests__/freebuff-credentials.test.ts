import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FREEBUFF_KEYCHAIN_TIMEOUT_MS,
  inspectFreebuffCredentials,
  materializeFreebuffCredentials,
  readFreebuffPlaintextCredentials,
  type FreebuffCredentialDependencies,
} from '../freebuff-credentials';
import {
  detectFreebuffCLILogin,
  discoverFreebuffAccounts,
  readFreebuffAuthToken,
  readFreebuffCredentialsFrom,
} from '../auth-utils';

// All file paths are newly created synthetic profiles. No real OS keychain calls, even on Darwin.
let root: string;
let profileDir: string;
let runHome: string;
let savedHome: string | undefined;
const metadata = {
  email: 'synthetic@example.invalid',
  id: 'synthetic-user',
  name: 'Synthetic',
  fingerprintId: 'synthetic-device',
  fingerprintHash: 'synthetic-hash',
};
const keychain = { default: { ...metadata, tokenStore: 'keychain' } };
const plaintext = { default: { ...metadata, authToken: 'synthetic-token' } };
const source = () => join(profileDir, 'credentials.json');
const target = () => join(runHome, '.config', 'manicode', 'credentials.json');
function put(data: unknown, dir = profileDir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(data), { mode: 0o600 });
}
function deps(
  stdout = 'synthetic-keychain-token\n',
  error: Error | null = null,
  platform: NodeJS.Platform = 'darwin',
) {
  const exec = mock<FreebuffCredentialDependencies['execFile']>(
    (_file, _args, _options, callback) => {
      callback(error, stdout, 'synthetic-stderr-must-not-leak');
    },
  );
  return { platform, execFile: exec };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-freebuff-credentials-'));
  profileDir = join(root, '.config', 'manicode');
  runHome = join(root, 'turn-home');
  mkdirSync(runHome, { mode: 0o700 });
  savedHome = process.env.HOME;
  process.env.HOME = root;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe('Freebuff CLI local setup detection', () => {
  test('recognizes current metadata-only keychain schema without obtaining a token', () => {
    put(keychain);
    expect(inspectFreebuffCredentials(profileDir, 'darwin')).toEqual({
      kind: 'keychain',
      supported: true,
      fingerprintId: metadata.fingerprintId,
    });
    expect(detectFreebuffCLILogin()).toBe(true);
    expect(readFreebuffAuthToken()).toBeNull();
    expect(readFreebuffCredentialsFrom(profileDir)).toBeNull();
    expect(discoverFreebuffAccounts()).toEqual([
      {
        id: `cli:freebuff:${Buffer.from(profileDir).toString('base64url')}`,
        label: 'freebuff',
        profileDir,
        fingerprintId: metadata.fingerprintId,
        authToken: '',
        credentialStorage: 'keychain',
      },
    ]);
  });
  test('legacy plaintext remains portable and backward compatible', () => {
    put({ default: { authToken: 'legacy-token', fingerprintId: 'legacy-device' } });
    expect(inspectFreebuffCredentials(profileDir, 'linux').kind).toBe('plaintext');
    expect(readFreebuffAuthToken()).toBe('legacy-token');
    expect(readFreebuffPlaintextCredentials(profileDir)).toEqual({
      authToken: 'legacy-token',
      fingerprintId: 'legacy-device',
    });
    expect(discoverFreebuffAccounts()[0]?.credentialStorage).toBe('plaintext');
  });
  test.each(['linux', 'win32'] as const)(
    'reports keychain reference with explicit unsupported status on %s',
    (platform) => {
      put(keychain);
      const status = inspectFreebuffCredentials(profileDir, platform);
      expect(status.kind).toBe('keychain');
      expect(status.supported).toBe(false);
      expect(status.reason).toContain('isolated Linux runtime profile');
    },
  );
  test('discovers independent mixed profiles and skips malformed or symlink profiles', () => {
    put(keychain);
    put(plaintext, join(root, '.config', 'manicode-work'));
    put(
      { default: { tokenStore: { service: 'other-service' } } },
      join(root, '.config', 'manicode-bad'),
    );
    symlinkSync(profileDir, join(root, '.config', 'manicode-link'));
    expect(discoverFreebuffAccounts().map((a) => a.label)).toEqual(['freebuff', 'freebuff work']);
  });
  test('does not fabricate credentials from metadata alone', () => {
    put({ default: metadata });
    expect(detectFreebuffCLILogin()).toBe(false);
    expect(discoverFreebuffAccounts()).toEqual([]);
    expect(readFreebuffAuthToken()).toBeNull();
  });
  test('missing and malformed JSON errors expose no source contents', () => {
    expect(inspectFreebuffCredentials(profileDir).kind).toBe('missing');
    put({});
    writeFileSync(source(), '{"SECRET_PARSE_SENTINEL":');
    expect(inspectFreebuffCredentials(profileDir).kind).toBe('invalid');
    expect(JSON.stringify(inspectFreebuffCredentials(profileDir))).not.toContain(
      'SECRET_PARSE_SENTINEL',
    );
  });
});

describe('Freebuff private turn materialization', () => {
  test('addresses only the exact CLI service/source-file account, with bounded and sanitized exec options', async () => {
    put(keychain);
    const before = readFileSync(source());
    const dependencies = deps();
    const result = await materializeFreebuffCredentials({ profileDir, runHome }, dependencies);
    expect(result).toEqual({ credentialsPath: target(), storage: 'keychain' });
    expect(dependencies.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = dependencies.execFile.mock.calls[0]!;
    expect(file).toBe('/usr/bin/security');
    expect(args).toEqual(['find-generic-password', '-s', 'freebuff-cli', '-a', source(), '-w']);
    expect(options).toMatchObject({
      timeout: FREEBUFF_KEYCHAIN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 + 2,
      shell: false,
      cwd: '/',
    });
    expect(options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
    expect(JSON.parse(readFileSync(target(), 'utf8'))).toEqual({
      default: { ...metadata, authToken: 'synthetic-keychain-token' },
    });
    expect(readFileSync(source())).toEqual(before);
    expect(statSync(target()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(target())).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(target()))).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(result)).not.toContain('synthetic-keychain-token');
  });
  test('preserves exact path case/spaces and does not use metadata service/account injection', async () => {
    profileDir = join(root, 'Case Sensitive Profile');
    put({
      default: { ...keychain.default, service: 'other', account: '/unrelated/credentials.json' },
    });
    const dependencies = deps();
    await materializeFreebuffCredentials({ profileDir, runHome }, dependencies);
    expect(dependencies.execFile.mock.calls[0]![1][4]).toBe(source());
    expect(readFileSync(target(), 'utf8')).not.toContain('unrelated');
    expect(readFileSync(target(), 'utf8')).not.toContain('service');
  });
  test('plaintext does not execute keychain helpers on any platform; unrelated credentials are not copied', async () => {
    put({ ...plaintext, chatgptOAuth: { token: 'unrelated' }, other: { authToken: 'other-user' } });
    const dependencies = deps('', null, 'linux');
    await materializeFreebuffCredentials({ profileDir, runHome }, dependencies);
    expect(dependencies.execFile).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(target(), 'utf8'))).toEqual(plaintext);
  });
  test('plaintext wins over a stale keychain marker, exactly like the CLI', async () => {
    put({ default: { ...plaintext.default, tokenStore: 'keychain' } });
    const dependencies = deps();
    await materializeFreebuffCredentials({ profileDir, runHome }, dependencies);
    expect(dependencies.execFile).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(target(), 'utf8'))).toEqual(plaintext);
  });
  test('non-Darwin keychain materialization fails before executing or creating a credential file', async () => {
    put(keychain);
    const dependencies = deps('', null, 'linux');
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('host keychain is not supported');
    expect(dependencies.execFile).not.toHaveBeenCalled();
    expect(existsSync(target())).toBe(false);
  });
  test.each([
    null,
    {},
    [['keychain']],
    { type: 'keychain', service: 'freebuff-cli', account: '/other' },
    'other-service',
  ])('rejects unsupported or forged tokenStore descriptor %#', async (tokenStore) => {
    put({ default: { ...metadata, tokenStore } });
    const dependencies = deps();
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('malformed');
    expect(dependencies.execFile).not.toHaveBeenCalled();
    expect(inspectFreebuffCredentials(profileDir).kind).toBe('invalid');
  });
  test.each(['', '\n', 'two\nlines\n', 'null\x00byte', ' '.repeat(3), 'x'.repeat(16 * 1024 + 1)])(
    'rejects empty, multiline, control-byte or oversized keychain stdout %#',
    async (output) => {
      put(keychain);
      await expect(
        materializeFreebuffCredentials({ profileDir, runHome }, deps(output)),
      ).rejects.toThrow('keychain access failed');
      expect(existsSync(target())).toBe(false);
    },
  );
  test('sanitizes secret-bearing errors including timeout, denied and missing items, without retry/fallback', async () => {
    put(keychain);
    for (const code of ['ETIMEDOUT', 'ENOENT', 44, 36]) {
      const error = Object.assign(new Error('SECRET_STDOUT SECRET_STDERR'), {
        code,
        stdout: 'SECRET_STDOUT',
        stderr: 'SECRET_STDERR',
      });
      const dependencies = deps('SECRET_STDOUT', error);
      const caught = await materializeFreebuffCredentials(
        { profileDir, runHome },
        dependencies,
      ).catch((e) => e as Error);
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toContain('keychain access failed');
      expect(String(caught)).not.toContain('SECRET');
      expect((caught as Error).cause).toBeUndefined();
      expect(dependencies.execFile).toHaveBeenCalledTimes(1);
      expect(existsSync(target())).toBe(false);
      expect(JSON.parse(readFileSync(source(), 'utf8'))).toEqual(keychain);
    }
  });
  test('sanitizes synchronous executor errors', async () => {
    put(keychain);
    const dependencies = deps();
    dependencies.execFile.mockImplementation(() => {
      throw new Error('SECRET');
    });
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('keychain access failed');
    expect(existsSync(target())).toBe(false);
  });
  test('cancellation never writes a token and passes the signal to exec', async () => {
    put(keychain);
    const controller = new AbortController();
    const dependencies = deps();
    dependencies.execFile.mockImplementation((_file, _args, options, callback) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(new Error('SECRET_ABORT_REASON'));
      callback(null, 'synthetic-token\n', '');
    });
    await expect(
      materializeFreebuffCredentials(
        { profileDir, runHome, signal: controller.signal },
        dependencies,
      ),
    ).rejects.toThrow('keychain access failed');
    expect(existsSync(target())).toBe(false);
    dependencies.execFile.mockClear();
    await expect(
      materializeFreebuffCredentials(
        { profileDir, runHome, signal: controller.signal },
        dependencies,
      ),
    ).rejects.toThrow('cancelled');
    expect(dependencies.execFile).not.toHaveBeenCalled();
  });
  test('rejects source symlink and oversized input before retrieval', async () => {
    put(keychain);
    const actual = join(root, 'source-copy');
    writeFileSync(actual, JSON.stringify(keychain));
    rmSync(source());
    symlinkSync(actual, source());
    const dependencies = deps();
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('unsafe');
    rmSync(source());
    writeFileSync(source(), ' '.repeat(256 * 1024 + 1));
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('unsafe');
    expect(dependencies.execFile).not.toHaveBeenCalled();
  });
  test('rejects existing target, hardlink and symlink targets without touching originals', async () => {
    put(plaintext);
    mkdirSync(dirname(target()), { recursive: true, mode: 0o700 });
    const before = readFileSync(source());
    const dependencies = deps();
    for (const kind of ['file', 'symlink', 'hardlink']) {
      if (kind === 'file') writeFileSync(target(), 'sentinel');
      if (kind === 'symlink') symlinkSync(source(), target());
      if (kind === 'hardlink') linkSync(source(), target());
      await expect(
        materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
      ).rejects.toThrow('fresh private');
      expect(readFileSync(source())).toEqual(before);
      rmSync(target());
    }
    expect(dependencies.execFile).not.toHaveBeenCalled();
  });
  test('rejects symlinked config directory and non-private HOME before secret access', async () => {
    put(keychain);
    const dependencies = deps();
    symlinkSync(join(root, '.config'), join(runHome, '.config'));
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('fresh private');
    rmSync(join(runHome, '.config'));
    chmodSync(runHome, 0o755);
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome }, dependencies),
    ).rejects.toThrow('fresh private');
    expect(dependencies.execFile).not.toHaveBeenCalled();
  });
  test('rejects source/destination overlap and relative profile paths', async () => {
    put(keychain);
    const dependencies = deps();
    await expect(
      materializeFreebuffCredentials({ profileDir, runHome: profileDir }, dependencies),
    ).rejects.toThrow('fresh private');
    await expect(
      materializeFreebuffCredentials({ profileDir: '.config/manicode', runHome }, dependencies),
    ).rejects.toThrow('unsafe');
    expect(dependencies.execFile).not.toHaveBeenCalled();
  });
});
