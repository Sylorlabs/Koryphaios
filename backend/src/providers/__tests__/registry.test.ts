import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Restore an env var to its prior value (or delete it if previously unset). */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

/** A fresh isolated directory path for AWS file-path overrides. */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'kory-aws-test-'));
}

// Provider instantiation involves CLI detection probes that are slow under
// parallel test load.
setDefaultTimeout(30000);
import { ProviderRegistry } from '../registry';
import { ProviderName } from '@koryphaios/shared';
import { PROVIDER_AUTH_MODE } from '../constants';
import type { KoryphaiosConfig } from '@koryphaios/shared';

// These tests assert auth-MODE acceptance (which credentials a provider accepts), not real
// connectivity. setCredentials() now verifies over the network, so stub fetch with a
// provider-shaped, non-empty synthetic model catalog. Restored after this file.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response('{"data":[{"id":"synthetic-chat-model"}]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function minimalConfig(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: 'claude-sonnet-4-5' },
      coder: { model: 'claude-sonnet-4-5' },
      task: { model: 'o4-mini' },
    },
    server: { port: 3000, host: 'localhost' },
    dataDirectory: '.koryphaios-test',
  };
}

describe('ProviderRegistry auth modes', () => {
  test('copilot rejects apiKey input (auth-only)', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.setCredentials('copilot', { apiKey: 'gho_123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('auth only');
  });

  test('kimicode rejects apiKey input (auth-only)', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.setCredentials('kimicode', { apiKey: 'sk-kimi-123' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('auth only');
  });

  test('anthropic accepts authToken without apiKey', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.setCredentials('anthropic', { authToken: 'test-token' });
    expect(result.success).toBe(true);
  });

  test('azure accepts authToken + endpoint + explicit deployment without apiKey', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.setCredentials('azure', {
      authToken: 'azure-token',
      baseUrl: 'https://example.openai.azure.com',
      deployment: 'production-chat',
    });
    expect(result.success).toBe(true);
  });

  test('bedrock requires a credential source (env, AWS files, or explicit keys)', async () => {
    const originalKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const originalCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const originalConfigFile = process.env.AWS_CONFIG_FILE;
    const originalProfile = process.env.AWS_PROFILE;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_PROFILE;
    // Point AWS file lookups at non-existent paths so the scanner cannot
    // pick up a developer's real ~/.aws configuration.
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/credentials';
    process.env.AWS_CONFIG_FILE = '/nonexistent/config';
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const result = await registry.setCredentials('bedrock', {});
      expect(result.success).toBe(false);
      // Two possible code paths produce different phrasing; either is correct.
      expect(result.error).toMatch(/AWS credential|environment credentials/);
    } finally {
      restoreEnv('AWS_ACCESS_KEY_ID', originalKey);
      restoreEnv('AWS_SECRET_ACCESS_KEY', originalSecret);
      restoreEnv('AWS_SHARED_CREDENTIALS_FILE', originalCredsFile);
      restoreEnv('AWS_CONFIG_FILE', originalConfigFile);
      restoreEnv('AWS_PROFILE', originalProfile);
    }
  });

  test('bedrock status advertises API key + auth token input boxes', async () => {
    const originalKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const originalCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const originalConfigFile = process.env.AWS_CONFIG_FILE;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/credentials';
    process.env.AWS_CONFIG_FILE = '/nonexistent/config';
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const status = registry.getStatus().find((p) => p.name === 'bedrock');
      expect(status?.supportsApiKey).toBe(true);
      expect(status?.supportsAuthToken).toBe(true);
      expect(status?.connectionState).toBe('not_configured');
    } finally {
      restoreEnv('AWS_ACCESS_KEY_ID', originalKey);
      restoreEnv('AWS_SECRET_ACCESS_KEY', originalSecret);
      restoreEnv('AWS_SHARED_CREDENTIALS_FILE', originalCredsFile);
      restoreEnv('AWS_CONFIG_FILE', originalConfigFile);
    }
  });

  test('bedrock buildProviderConfig never bakes env AWS credentials into config', async () => {
    const originalKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
    const originalCredsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const originalConfigFile = process.env.AWS_CONFIG_FILE;
    const dir = tmpDir();
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_ENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'env-secret-key';
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'credentials');
    process.env.AWS_CONFIG_FILE = join(dir, 'config');
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const configs = registry.getConfigs();
      // bedrock is disabled by default; even with env keys present the SDK
      // resolves them from the AWS credential chain at runtime, so they must
      // NOT be persisted into Koryphaios config files.
      expect(configs.bedrock?.apiKey).toBeUndefined();
      expect(configs.bedrock?.authToken).toBeUndefined();
    } finally {
      restoreEnv('AWS_ACCESS_KEY_ID', originalKey);
      restoreEnv('AWS_SECRET_ACCESS_KEY', originalSecret);
      restoreEnv('AWS_SHARED_CREDENTIALS_FILE', originalCredsFile);
      restoreEnv('AWS_CONFIG_FILE', originalConfigFile);
    }
  });

  test(
    'is disabled by default even if env API keys present',
    async () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-valid-looking';
      try {
        const registry = new ProviderRegistry(minimalConfig());
        const statuses = registry.getStatus();
        const status = statuses.find((p) => p.name === 'openai');
        // Now defaults to disabled: true
        expect(status?.enabled).toBe(false);
        expect(status?.authenticated).toBe(false);
      } finally {
        if (original === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = original;
        }
      }
    },
    { timeout: 15000 },
  );

  test(
    'can be enabled by calling setCredentials without key if env present',
    async () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-valid-looking';
      try {
        const registry = new ProviderRegistry(minimalConfig());
        const result = await registry.setCredentials('openai', {});
        expect(result.success).toBe(true);
        const statuses = registry.getStatus();
        const status = statuses.find((p) => p.name === 'openai');
        expect(status?.enabled).toBe(true);
        expect(status?.authenticated).toBe(true);
      } finally {
        if (original === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = original;
        }
      }
    },
    { timeout: 15000 },
  );

  test(
    'getStatus returns every runtime provider',
    () => {
      const registry = new ProviderRegistry(minimalConfig());
      const status = registry.getStatus();
      const expectedNames = new Set(Object.keys(PROVIDER_AUTH_MODE));
      const returnedNames = new Set(status.map((s: any) => s.name));
      const missing = [...expectedNames].filter((n) => !returnedNames.has(n));
      const extra = [...returnedNames].filter((n) => !expectedNames.has(n));
      expect(missing, `Missing providers: ${missing.join(', ')}`).toEqual([]);
      expect(extra, `Unexpected providers: ${extra.join(', ')}`).toEqual([]);
      expect(status.length).toBe(expectedNames.size);
    },
    { timeout: 15000 },
  );
});
