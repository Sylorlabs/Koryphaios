import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTestEnvironment } from '../../../scripts/test-backend-isolated';

describe('isolated backend test environment', () => {
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
    expect(env.KORYPHAIOS_DATA_DIR).toBe('/isolated/home/.koryphaios');
    expect(env.KORYPHAIOS_SKILLS_HOME).toBe('/isolated/home/.koryphaios/skills');
    expect(env.KORYPHAIOS_WORKFLOWS_HOME).toBe('/isolated/home/.koryphaios/workflows');
    expect(env.PROJECT_ROOT).toBe('/isolated/home/project');
    expect(env.LOG_DIR).toBe('/isolated/home/.koryphaios/logs');
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
