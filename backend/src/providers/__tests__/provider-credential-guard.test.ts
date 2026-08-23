import { describe, expect, it } from 'bun:test';
import {
  assertCredentialOwnership,
  detectCredentialIssuer,
} from '../provider-credential-guard';

describe('provider credential ownership', () => {
  it('detects OpenRouter keys', () => {
    expect(detectCredentialIssuer('sk-or-v1-test')).toBe('openrouter');
  });

  it('rejects OpenRouter keys for unrelated providers', () => {
    const result = assertCredentialOwnership('sk-or-v1-test', {
      provider: 'opencode-zen',
      acceptedIssuers: ['openai'],
    });

    expect(result?.detected).toBe('openrouter');
  });

  it('allows matching credential ownership', () => {
    expect(
      assertCredentialOwnership('sk-or-v1-test', {
        provider: 'openrouter',
        acceptedIssuers: ['openrouter'],
      }),
    ).toBeNull();
  });
});
