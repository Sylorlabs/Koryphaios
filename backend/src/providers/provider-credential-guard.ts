export type CredentialIssuer =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'unknown';

export interface ProviderCredentialExpectation {
  provider: string;
  acceptedIssuers: CredentialIssuer[];
}

export interface CredentialMismatch {
  detected: CredentialIssuer;
  expected: CredentialIssuer[];
  message: string;
}

/**
 * Detect credential ownership before attempting provider verification.
 * Provider adapters should fail closed instead of accepting another vendor's
 * key and accidentally displaying the wrong model catalog.
 */
export function detectCredentialIssuer(secret: string): CredentialIssuer {
  const value = secret.trim();
  if (!value) return 'unknown';

  if (/^sk-or-v1-/i.test(value)) return 'openrouter';
  if (/^sk-ant-/i.test(value)) return 'anthropic';
  if (/^sk-(proj-)?[A-Za-z0-9_-]+/i.test(value)) return 'openai';

  return 'unknown';
}

export function assertCredentialOwnership(
  secret: string,
  expectation: ProviderCredentialExpectation,
): CredentialMismatch | null {
  const detected = detectCredentialIssuer(secret);

  if (
    detected !== 'unknown' &&
    !expectation.acceptedIssuers.includes(detected)
  ) {
    return {
      detected,
      expected: expectation.acceptedIssuers,
      message: `Wrong provider credential: detected ${detected} key for ${expectation.provider}.`,
    };
  }

  return null;
}
