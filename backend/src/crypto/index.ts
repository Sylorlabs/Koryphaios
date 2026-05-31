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

/**
 * Create a KMS provider from environment variables
 * Currently only supports local provider
 */
export function createKMSProviderFromEnv(): import('./types').KMSProvider {
  // For now, always use local provider
  // In production, this could check for AWS, GCP, Azure, etc.
  return new LocalKMSProvider({
    dataDir: process.env.KORYPHAIOS_DATA_DIR || '.koryphaios',
  });
}
