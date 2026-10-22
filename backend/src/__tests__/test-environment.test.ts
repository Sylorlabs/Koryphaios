import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { canonicalizePath, directoryLinkType } from '../runtime/platform';
import {
  createIsolatedTestEnvironment,
  parseTestSelection,
} from '../../../scripts/test-backend-isolated';

/** Normalize backslashes to forward slashes so path assertions work on both
 * Windows (where path.join uses \) and POSIX (where it uses /). */
function normalizePath(p: string | undefined): string {
  return (p ?? '').replace(/\\/g, '/');
}

const ASSET_SELECTORS = [
  'BUN_INSTALL_CACHE_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'DEVELOPER_DIR',
] as const;

describe('isolated backend test environment', () => {
  test('propagates explicit asset directories canonically without restoring caller authority', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'kory-test-assets-'));
    try {
      const hostHome = join(fixture, 'host-home');
      const isolatedHome = join(fixture, 'isolated-home');
      const cache = join(hostHome, 'cache with spaces');
      const browsers = join(hostHome, 'browsers');
      const developer = join(hostHome, 'developer');
      for (const dir of [cache, browsers, developer, isolatedHome]) {
        mkdirSync(dir, { recursive: true });
      }
      const developerLink = join(fixture, 'developer-link');
      symlinkSync(developer, developerLink, directoryLinkType());
      const source = {
        HOME: hostHome,
        USERPROFILE: hostHome,
        XDG_CONFIG_HOME: hostHome,
        XDG_DATA_HOME: hostHome,
        XDG_CACHE_HOME: hostHome,
        TMPDIR: hostHome,
        TEMP: hostHome,
        TMP: hostHome,
        BUN_INSTALL_CACHE_DIR: cache,
        PLAYWRIGHT_BROWSERS_PATH: relative(process.cwd(), browsers),
        DEVELOPER_DIR: developerLink,
        OPENAI_API_KEY: 'must-not-cross',
        CLAUDE_CONFIG_DIR: hostHome,
        CODEX_HOME: hostHome,
        GEMINI_DIR: hostHome,
        DEVIN_CONFIG_DIR: hostHome,
        OPENAI_BASE_URL: 'https://paid.example.invalid',
        HTTPS_PROXY: 'https://proxy.example.invalid',
      };
      const original = { ...source };
      const env = createIsolatedTestEnvironment(source, isolatedHome);
      const expectedAssets = {
        BUN_INSTALL_CACHE_DIR: canonicalizePath(cache),
        PLAYWRIGHT_BROWSERS_PATH: canonicalizePath(browsers),
        DEVELOPER_DIR: canonicalizePath(developer),
      };
      for (const name of ASSET_SELECTORS) expect(env[name]).toBe(expectedAssets[name]);
      expect(env.HOME).toBe(isolatedHome);
      expect(env.USERPROFILE).toBe(isolatedHome);
      expect(env.XDG_CONFIG_HOME).toBe(join(isolatedHome, '.config'));
      expect(env.XDG_DATA_HOME).toBe(join(isolatedHome, '.local', 'share'));
      expect(env.XDG_CACHE_HOME).toBe(join(isolatedHome, '.cache'));
      for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
        expect(env[name]).toBe(join(isolatedHome, 'tmp'));
      }
      for (const name of [
        'OPENAI_API_KEY',
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'GEMINI_DIR',
        'DEVIN_CONFIG_DIR',
        'OPENAI_BASE_URL',
        'HTTPS_PROXY',
      ]) {
        expect(env[name]).toBeUndefined();
      }
      expect(source).toEqual(original);

      // The runner changes cwd for its children; relative inputs must already
      // be absolute, and Bun must not reload credentials from a project .env.
      writeFileSync(join(fixture, '.env'), 'OPENAI_API_KEY=must-not-reappear\n');
      const child = spawnSync(
        process.execPath,
        [
          '--no-env-file',
          '-e',
          `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify([
            ...ASSET_SELECTORS,
            'HOME',
            'OPENAI_API_KEY',
            'CODEX_HOME',
            'HTTPS_PROXY',
          ])}.map(name => [name, process.env[name] ?? null]))))`,
        ],
        { cwd: fixture, env, encoding: 'utf8', timeout: 5_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        ...expectedAssets,
        HOME: isolatedHome,
        OPENAI_API_KEY: null,
        CODEX_HOME: null,
        HTTPS_PROXY: null,
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('does not infer asset selectors from caller HOME when unspecified', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'kory-test-no-assets-'));
    try {
      // Even populated host asset locations do not opt the caller in.
      for (const path of [
        '.bun/install/cache',
        '.cache/ms-playwright',
        'Library/Caches/ms-playwright',
      ]) {
        mkdirSync(join(fixture, path), { recursive: true });
      }
      const env = createIsolatedTestEnvironment({ HOME: fixture }, join(fixture, 'isolated-home'));
      for (const name of ASSET_SELECTORS) expect(env[name]).toBeUndefined();
      expect(env.HOME).toBe(join(fixture, 'isolated-home'));
      expect(env.XDG_CACHE_HOME).toBe(join(fixture, 'isolated-home', '.cache'));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('ignores undefined and inherited asset selectors', () => {
    const source: NodeJS.ProcessEnv = Object.create({
      BUN_INSTALL_CACHE_DIR: process.cwd(),
      DEVELOPER_DIR: process.cwd(),
    });
    source.PLAYWRIGHT_BROWSERS_PATH = undefined;
    const env = createIsolatedTestEnvironment(source, '/isolated/home');
    for (const name of ASSET_SELECTORS) expect(env[name]).toBeUndefined();
  });

  for (const name of ASSET_SELECTORS) {
    test(`${name} rejects missing and malformed directories without creating them`, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'kory-test-invalid-assets-'));
      try {
        const missing = join(fixture, 'missing');
        const file = join(fixture, 'file');
        const dangling = join(fixture, 'dangling');
        writeFileSync(file, 'not a directory');
        symlinkSync(missing, dangling, directoryLinkType());
        for (const value of [
          '',
          '   ',
          '\t',
          `${fixture}\0suffix`,
          `${fixture}\n`,
          missing,
          file,
          dangling,
        ]) {
          expect(() =>
            createIsolatedTestEnvironment({ [name]: value }, join(fixture, 'home')),
          ).toThrow(`${name} must name an existing directory`);
        }
        expect(existsSync(missing)).toBe(false);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }

  test('rejects Playwright hermetic sentinel 0 rather than resolving it as a path', () => {
    expect(() =>
      createIsolatedTestEnvironment({ PLAYWRIGHT_BROWSERS_PATH: '0' }, '/isolated/home'),
    ).toThrow('PLAYWRIGHT_BROWSERS_PATH=0 (hermetic mode) is not supported');
  });

  test('focused selection preserves Bun flags and deduplicates explicit files', () => {
    const root = join(import.meta.dir, '../../..');
    const path = 'backend/src/__tests__/test-environment.test.ts';
    const selection = parseTestSelection(
      ['--file', path, '--file', path, '--test-name-pattern', 'boundary'],
      root,
    );
    expect(selection.files).toHaveLength(1);
    expect(selection.files[0]).toBe(join(root, path));
    expect(selection.runnerArguments).toEqual(['--test-name-pattern', 'boundary']);
    expect(() => parseTestSelection(['--file'], root)).toThrow('requires');
    expect(() => parseTestSelection(['--file', '../outside.test.ts'], root)).toThrow(
      'inside backend',
    );
    expect(() => parseTestSelection(['--file', 'backend/package.json'], root)).toThrow(
      'inside backend',
    );
  });
  test('strips ambient provider authority and account locations from the default core gate', () => {
    const env = createIsolatedTestEnvironment(
      {
        PATH: '/test/bin',
        HOME: '/real/home',
        OPENAI_API_KEY: 'must-not-cross',
        ANTHROPIC_AUTH_TOKEN: 'must-not-cross',
        AWS_ACCESS_KEY_ID: 'must-not-cross',
        AWS_SECRET_ACCESS_KEY: 'must-not-cross',
        AWS_PROFILE: 'production',
        AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/production',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/real/aws-token',
        AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/credentials',
        GOOGLE_APPLICATION_CREDENTIALS: '/real/credentials.json',
        AZURE_CLIENT_SECRET: 'must-not-cross',
        AZURE_FEDERATED_TOKEN_FILE: '/real/azure-token',
        OPENAI_BASE_URL: 'https://paid.example.invalid',
        KIMI_CODE_OAUTH_HOST: 'paid.example.invalid',
        KIMI_OAUTH_HOST: 'paid.example.invalid',
        KORY_BACKEND_URL: 'https://backend.example.invalid',
        RELAY_URL: 'wss://relay.example.invalid',
        TURN_URL: 'turn:turn.example.invalid',
        TURN_CREDENTIAL: 'must-not-cross',
        TURN_USERNAME: 'must-not-cross',
        REDIS_HOST: 'redis.example.invalid',
        REDIS_URL: 'redis://redis.example.invalid',
        HTTPS_PROXY: 'https://proxy.example.invalid',
        KORYPHAIOS_ENCRYPTION_KEY: 'must-not-cross',
        KORYPHAIOS_MASTER_KEY: 'must-not-cross',
        KORYPHAIOS_KMS_VAULT_K8S_JWT: 'must-not-cross',
        KORYPHAIOS_KMS_VAULT_SECRET_ID: 'must-not-cross',
        KORYPHAIOS_SKILLS_HOME: '/real/skills',
        KORYPHAIOS_WORKFLOWS_HOME: '/real/workflows',
        PROJECT_ROOT: '/real/project',
        SESSION_STORE: 'redis',
        LOG_DIR: '/real/logs',
        NODE_OPTIONS: '--require=/real/preload.js',
        KORY_LIVE_PROVIDER_TESTS: '1',
        KORY_LIVE_CLAUDE: '1',
      },
      '/isolated/home',
    );

    expect(env.PATH).toBe('/test/bin');
    expect(env.HOME).toBe('/isolated/home');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_ROLE_ARN).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AZURE_FEDERATED_TOKEN_FILE).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.KIMI_CODE_OAUTH_HOST).toBeUndefined();
    expect(env.KIMI_OAUTH_HOST).toBeUndefined();
    expect(env.KORY_BACKEND_URL).toBeUndefined();
    expect(env.RELAY_URL).toBeUndefined();
    expect(env.TURN_URL).toBeUndefined();
    expect(env.TURN_CREDENTIAL).toBeUndefined();
    expect(env.TURN_USERNAME).toBeUndefined();
    expect(env.REDIS_HOST).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.KORYPHAIOS_ENCRYPTION_KEY).toBeUndefined();
    expect(env.KORYPHAIOS_MASTER_KEY).toBeUndefined();
    expect(env.KORYPHAIOS_KMS_VAULT_K8S_JWT).toBeUndefined();
    expect(env.KORYPHAIOS_KMS_VAULT_SECRET_ID).toBeUndefined();
    expect(env.SESSION_STORE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.KORY_RUN_LIVE_PROVIDER_TESTS).toBe('0');
    expect(env.KORY_LIVE_PROVIDER_TESTS).toBe('0');
    expect(env.KORY_LIVE_CLAUDE).toBe('0');
    expect(env.KORY_DISABLE_CLI_AUTODETECT).toBe('1');
    expect(normalizePath(env.KORYPHAIOS_DATA_DIR)).toBe('/isolated/home/.koryphaios');
    expect(normalizePath(env.KORYPHAIOS_SKILLS_HOME)).toBe('/isolated/home/.koryphaios/skills');
    expect(normalizePath(env.KORYPHAIOS_WORKFLOWS_HOME)).toBe(
      '/isolated/home/.koryphaios/workflows',
    );
    expect(normalizePath(env.PROJECT_ROOT)).toBe('/isolated/home/project');
    expect(normalizePath(env.LOG_DIR)).toBe('/isolated/home/.koryphaios/logs');
    expect(env.SESSION_TOKEN_SECRET).toBe('test_only_not_for_production_aaaaaaaaaa');
  });

  test('preserves provider authority only behind the explicit live-test opt-in', () => {
    const env = createIsolatedTestEnvironment(
      {
        HOME: '/operator/home',
        OPENAI_API_KEY: 'explicit-live-key',
        KORY_RUN_LIVE_PROVIDER_TESTS: '1',
        KORY_LIVE_CLAUDE: '1',
      },
      '/isolated/home',
    );

    expect(env.HOME).toBe('/operator/home');
    expect(env.OPENAI_API_KEY).toBe('explicit-live-key');
    expect(env.KORY_RUN_LIVE_PROVIDER_TESTS).toBe('1');
    expect(env.KORY_LIVE_CLAUDE).toBe('1');
  });

  test('the no-env-file child boundary prevents Bun from reloading project secrets', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'kory-closed-transport-'));
    const isolatedHome = join(fixture, 'home');
    mkdirSync(isolatedHome, { recursive: true });
    writeFileSync(join(fixture, '.env'), 'OPENAI_API_KEY=must-not-reappear\n');

    try {
      const env = createIsolatedTestEnvironment(
        { ...process.env, OPENAI_API_KEY: 'must-not-cross' },
        isolatedHome,
      );
      const child = spawnSync(
        process.execPath,
        [
          '--no-env-file',
          '-e',
          `process.stdout.write(JSON.stringify(process.env.OPENAI_API_KEY ?? null))`,
        ],
        { cwd: fixture, env, encoding: 'utf8', timeout: 5_000 },
      );

      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe('null');
      expect(child.stderr).toBe('');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
