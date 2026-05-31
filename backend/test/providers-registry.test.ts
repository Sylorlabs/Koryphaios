import { describe, test, expect } from 'bun:test';
import { ProviderRegistry } from '../src/providers/registry';
import { ProviderName } from '@koryphaios/shared';
import type { KoryphaiosConfig } from '@koryphaios/shared';

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

  test('azure accepts authToken + endpoint without apiKey', async () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = await registry.setCredentials('azure', {
      authToken: 'azure-token',
      baseUrl: 'https://example.openai.azure.com',
    });
    expect(result.success).toBe(true);
  });

  test('bedrock requires environment auth', async () => {
    const originalKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const result = await registry.setCredentials('bedrock', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('environment credentials');
    } finally {
      if (originalKey !== undefined) process.env.AWS_ACCESS_KEY_ID = originalKey;
      if (originalSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = originalSecret;
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
    'getStatus returns exactly ALL providers (every ProviderName)',
    () => {
      const registry = new ProviderRegistry(minimalConfig());
      const status = registry.getStatus();
      const expectedNames = new Set(Object.values(ProviderName));
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
