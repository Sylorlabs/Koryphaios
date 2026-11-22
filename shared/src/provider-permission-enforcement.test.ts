import { describe, expect, test } from 'bun:test';
import { providerPermissionEnforcement } from './provider-permission-enforcement';

describe('providerPermissionEnforcement', () => {
  test('API providers are enforced by Kory: every tool call is a Kory tool', () => {
    expect(providerPermissionEnforcement('openai').level).toBe('kory');
    expect(providerPermissionEnforcement('logfare').level).toBe('kory');
  });

  test('verified CLI boundaries and hooks', () => {
    for (const name of ['codex', 'opencode', 'antigravity', 'omnirush', 'freebuff', 'codebuff']) {
      expect(providerPermissionEnforcement(name).level).toBe('kory');
    }
    expect(providerPermissionEnforcement('claude').level).toBe('kory-hooks');
    expect(providerPermissionEnforcement('devin').level).toBe('kory-hooks');
  });

  test('native-policy CLIs say the mode applies to Kory tools only', () => {
    for (const name of ['codebuddy', 'cursor', 'grok', 'gemini-cli']) {
      const result = providerPermissionEnforcement(name);
      expect(result.level).toBe('native');
      expect(result.detail).toContain('Kory tools only');
    }
  });

  test('a known CLI without verified gating is unverified, never enforced', () => {
    const result = providerPermissionEnforcement('kimicode', 'Kimi Code');
    expect(result.level).toBe('unverified');
    expect(result.detail).toContain('Kimi Code');
  });

  test('no provider selected', () => {
    expect(providerPermissionEnforcement('').label).toBe('No model selected');
  });
});
