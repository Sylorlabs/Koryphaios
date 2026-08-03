import { describe, expect, test } from 'bun:test';
import type { UserCredential } from '../../../services';
import { configuredAccounts, summarizeProviderBalances, withDetectedCliAccounts } from '../billing';
import { codexAttributionNote, codexSessionAttribution } from '../../../billing/cli-usage';

function credential(overrides: Partial<UserCredential>): UserCredential {
  return {
    id: 'credential-1',
    userId: 'local-user',
    provider: 'codex',
    encryptedValue: 'redacted',
    type: 'authToken',
    isActive: true,
    createdAt: 100,
    ...overrides,
  };
}

describe('billing configured accounts', () => {
  test('quarantines a profile that shares another Codex profile session history', () => {
    const attribution = codexSessionAttribution([
      { id: 'plus', label: 'codex', profileDir: '/profiles/plus' },
      { id: 'pro', label: 'codex 2', profileDir: '/profiles/pro' },
    ], (profileDir) => profileDir === '/profiles/pro' ? '/sessions/shared' : '/sessions/shared');
    expect(attribution.get('plus')).toBeUndefined();
    expect(attribution.get('pro')).toBe('Shares local session history with codex');
  });

  test('quarantines a session root whose reported plan conflicts with its login profile', () => {
    expect(codexAttributionNote(undefined, 'plus', 'pro')).toBe(
      'Session history reports a PRO plan, but this profile is PLUS',
    );
  });

  test('uses successful live provider probes for the balance headline', () => {
    expect(summarizeProviderBalances([
      { provider: 'openrouter', availableUsd: 12.345, fetchedAt: 1 },
      { provider: 'deepseek', availableUsd: null, fetchedAt: 1 },
      { provider: 'moonshot', availableUsd: 3.21, fetchedAt: 1 },
    ])).toEqual({ availableCents: 1556, providers: ['openrouter', 'moonshot'] });
  });

  test('does not invent a balance when every probe is unavailable', () => {
    expect(summarizeProviderBalances([
      { provider: 'openrouter', availableUsd: null, fetchedAt: 1 },
    ])).toEqual({ availableCents: null, providers: [] });
  });

  test('groups multiple credential fields into one labeled subscription account', () => {
    const metadata = JSON.stringify({ accountId: 'account-1', label: 'Work Codex' });
    const accounts = configuredAccounts([
      credential({ id: 'token', metadata, lastUsedAt: 250 }),
      credential({ id: 'endpoint', type: 'baseUrl', metadata, createdAt: 50 }),
    ]);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: 'account-1',
      provider: 'codex',
      label: 'Work Codex',
      subscription: true,
      usageAttribution: 'provider',
      createdAt: 50,
      lastUsedAt: 250,
    });
    expect(accounts[0]?.credentialTypes).toEqual(['authToken', 'baseUrl']);
  });

  test('keeps accounts separate and excludes inactive credentials', () => {
    const accounts = configuredAccounts([
      credential({ id: 'one', provider: 'openai', type: 'apiKey' }),
      credential({ id: 'two', provider: 'openai', type: 'apiKey' }),
      credential({ id: 'gone', provider: 'claude', isActive: false }),
    ]);

    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.provider === 'openai')).toBe(true);
    expect(accounts.every((account) => account.subscription === false)).toBe(true);
  });

  test('shows autodetected CLI profiles only when multiple identities make them relevant', () => {
    const detected = (id: string, email: string) => ({
      id,
      provider: 'codex',
      label: email,
      email,
      plan: 'plus',
      profileDir: `/tmp/${id}`,
      authFile: `/tmp/${id}/auth.json`,
      command: 'codex',
      commandArgs: [],
      health: 'ready' as const,
      expiresAt: Date.now() + 1000,
      source: 'cli-autodetect' as const,
    });
    expect(withDetectedCliAccounts([], [detected('one', 'one@example.com')])).toEqual([]);
    const accounts = withDetectedCliAccounts([], [
      detected('one', 'one@example.com'),
      detected('two', 'two@example.com'),
    ]);
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.email)).toEqual(['one@example.com', 'two@example.com']);
    expect(accounts.every((account) => account.credentialTypes[0] === 'cliProfile')).toBe(true);
  });
});
