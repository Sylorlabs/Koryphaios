/**
 * Crypto module for Koryphaios
 * Provides secure memory management and encryption utilities
 */

export { SecureBuffer, SecureString, SecureKeyStorage, secureKeyStorage } from './secure-memory';
export { secureEncryption } from './secure-encryption';
export { EnvelopeEncryption } from './envelope';
export type { KMSProvider, Envelope, DecryptResult } from './types';
export { LocalKMSProvider } from './providers/local';

import { LocalKMSProvider } from './providers/local';
import { AWSKMSProvider } from './providers/aws-kms';
import { VaultKMSProvider, type VaultAuthConfig } from './providers/vault';
import type { KMSProvider } from './types';

/**
 * Create a KMS provider from environment variables.
 *
 * Provider selection (highest precedence first):
 *   1. KORYPHAIOS_KMS_PROVIDER env var: 'local' | 'aws-kms' | 'vault' |
 *      'gcp-kms' | 'azure-kv' | 'cloudflare'
 *   2. Default: 'local' (with passphrase required — see LocalKMSProvider)
 *
 * Provider-specific config is read from KORYPHAIOS_KMS_* env vars. See
 * docs/configuration.md for the full list per provider.
 *
 * SECURITY: When the backend is bound to a non-loopback host (i.e. exposed
 * beyond the local machine), the local provider is refused unless
 * KORYPHAIOS_ALLOW_LOCAL_KMS=1 is set. This prevents accidental deployment
 * with on-disk key storage.
 */
export function createKMSProviderFromEnv(): KMSProvider {
  const provider = (process.env.KORYPHAIOS_KMS_PROVIDER ?? 'local').toLowerCase();
  const host = process.env.KORYPHAIOS_HOST ?? '127.0.0.1';
  // Loopback detection: 127.0.0.0/8, ::1, localhost. Also treat 0.0.0.0
  // and :: as non-loopback (they bind to all interfaces, including
  // non-loopback) so the local KMS restriction applies.
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host === '::ffff:127.0.0.1';

  if (provider === 'local') {
    if (!isLoopback && process.env.KORYPHAIOS_ALLOW_LOCAL_KMS !== '1') {
      throw new Error(
        'Local KMS provider is not allowed when the backend is bound to a non-loopback ' +
          `host (${host}). Set KORYPHAIOS_KMS_PROVIDER to an external KMS ` +
          '(aws-kms, vault, gcp-kms, azure-kv, or cloudflare), or set ' +
          'KORYPHAIOS_ALLOW_LOCAL_KMS=1 to acknowledge the risk of on-disk key storage.',
      );
    }
    return new LocalKMSProvider({
      dataDir: process.env.KORYPHAIOS_DATA_DIR || '.koryphaios',
      passphrase: process.env.KORYPHAIOS_KMS_PASSPHRASE,
      suppressWarning: process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS === '1',
    });
  }

  if (provider === 'aws-kms') {
    const region = process.env.KORYPHAIOS_KMS_AWS_REGION;
    const keyId = process.env.KORYPHAIOS_KMS_AWS_KEY_ID;
    if (!region || !keyId) {
      throw new Error(
        'AWS KMS provider requires KORYPHAIOS_KMS_AWS_REGION and KORYPHAIOS_KMS_AWS_KEY_ID. ' +
          'See docs/configuration.md.',
      );
    }
    return new AWSKMSProvider({
      region,
      keyId,
      accessKeyId: process.env.KORYPHAIOS_KMS_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.KORYPHAIOS_KMS_AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.KORYPHAIOS_KMS_AWS_SESSION_TOKEN,
      endpoint: process.env.KORYPHAIOS_KMS_AWS_ENDPOINT,
    });
  }

  if (provider === 'vault') {
    const address = process.env.KORYPHAIOS_KMS_VAULT_ADDRESS;
    const keyName = process.env.KORYPHAIOS_KMS_VAULT_KEY_NAME;
    const authMethod = process.env.KORYPHAIOS_KMS_VAULT_AUTH_METHOD ?? 'token';
    if (!address || !keyName) {
      throw new Error(
        'Vault KMS provider requires KORYPHAIOS_KMS_VAULT_ADDRESS and KORYPHAIOS_KMS_VAULT_KEY_NAME. ' +
          'See docs/configuration.md.',
      );
    }
    // Build auth config from env based on the auth method.
    let authConfig: VaultAuthConfig;
    if (authMethod === 'token') {
      const token = process.env.KORYPHAIOS_KMS_VAULT_TOKEN;
      if (!token) throw new Error('Vault token auth requires KORYPHAIOS_KMS_VAULT_TOKEN.');
      authConfig = { token };
    } else if (authMethod === 'approle') {
      const roleId = process.env.KORYPHAIOS_KMS_VAULT_ROLE_ID;
      const secretId = process.env.KORYPHAIOS_KMS_VAULT_SECRET_ID;
      if (!roleId || !secretId) {
        throw new Error('Vault AppRole auth requires KORYPHAIOS_KMS_VAULT_ROLE_ID and KORYPHAIOS_KMS_VAULT_SECRET_ID.');
      }
      authConfig = { roleId, secretId };
    } else if (authMethod === 'kubernetes') {
      const role = process.env.KORYPHAIOS_KMS_VAULT_K8S_ROLE;
      if (!role) throw new Error('Vault Kubernetes auth requires KORYPHAIOS_KMS_VAULT_K8S_ROLE.');
      authConfig = { role, jwt: process.env.KORYPHAIOS_KMS_VAULT_K8S_JWT };
    } else {
      throw new Error(`Unsupported Vault auth method: ${authMethod}. Use token, approle, or kubernetes.`);
    }
    return new VaultKMSProvider({
      address,
      keyName,
      authMethod: authMethod as 'token' | 'approle' | 'kubernetes' | 'aws',
      authConfig,
      namespace: process.env.KORYPHAIOS_KMS_VAULT_NAMESPACE,
      mountPath: process.env.KORYPHAIOS_KMS_VAULT_MOUNT_PATH,
      caCert: process.env.KORYPHAIOS_KMS_VAULT_CA_CERT,
    });
  }

  // gcp-kms, azure-kv, cloudflare providers exist but require SDK setup
  // that varies per deployment. They're wired here so the factory recognizes
  // them; users who need them should follow docs/configuration.md.
  if (provider === 'gcp-kms' || provider === 'azure-kv' || provider === 'cloudflare') {
    throw new Error(
      `KMS provider '${provider}' is recognized but not yet wired into the factory. ` +
        'The provider implementation exists in backend/src/crypto/providers/ but needs ' +
        'env-var mapping. Use aws-kms or vault for now, or contribute the wiring.',
    );
  }

  throw new Error(
    `Unknown KMS provider: '${provider}'. Supported: local, aws-kms, vault, gcp-kms, azure-kv, cloudflare.`,
  );
}
