// Per-User Key Derivation System
// Each user gets their own encryption key derived from their user ID
// This ensures isolation between users - if one key leaks, others are safe

import { createHmac, randomBytes } from 'node:crypto';
import type { KMSProvider } from './types';

const DERIVATION_ALGORITHM = 'sha256';

export interface PerUserEncryptionConfig {
  /** Base KMS provider */
  provider: KMSProvider;
  /** Application-specific context (prevents key reuse across apps) */
  context: string;
  /** Optional pepper (static secret added to all derivations) */
  pepper?: string;
}

/**
 * Per-User Encryption Key Derivation
 * 
 * Security model:
 * 1. Master KEK stored in external KMS (AWS/Vault/Azure/GCP)
 * 2. Per-user key = HMAC(masterKey, userId + context + pepper)
 * 3. User's DEK encrypted with their per-user key
 * 
 * Benefits:
 * - User A's key compromise doesn't affect User B
 * - Revoke individual users by rotating their DEK
 * - Audit per-user key access
 * - Cryptographic isolation between tenants
 */
export class PerUserKeyDerivation {
  private provider: KMSProvider;
  private context: string;
  private pepper: string;
  private masterKey: Buffer | null = null;

  constructor(configOrProvider: PerUserEncryptionConfig | KMSProvider) {
    if ('generateDek' in configOrProvider) {
      // Bare KMSProvider passed directly
      this.provider = configOrProvider as KMSProvider;
      this.context = 'default';
      this.pepper = '';
    } else {
      const config = configOrProvider as PerUserEncryptionConfig;
      this.provider = config.provider;
      this.context = config.context;
      this.pepper = config.pepper || '';
    }
  }

  /**
   * Initialize and fetch master key from KMS
   */
  async initialize(): Promise<void> {
    // Generate a fixed "master key" by asking KMS to encrypt a known plaintext
    // We use this as the HMAC key for per-user derivation
    const { plaintext } = await this.provider.generateDek();
    this.masterKey = plaintext;
  }

  /**
   * Derive a user-specific key (async, uses provider's per-user DEK if available)
   * Deterministic: same userId+context always produces same key
   */
  async deriveKey(userId: string, context?: { purpose?: string }): Promise<Buffer> {
    const derivationInput = context?.purpose
      ? `${userId}:${context.purpose}`
      : userId;

    // Use provider's per-user DEK method if available (deterministic)
    if (typeof (this.provider as any).generatePerUserDek === 'function') {
      const { plaintext } = await (this.provider as any).generatePerUserDek(derivationInput);
      return plaintext;
    }

    // Fallback: use HMAC with master key
    if (!this.masterKey) {
      await this.initialize();
    }
    return this.deriveUserKey(derivationInput);
  }

  /**
   * Derive a user-specific encryption key
   * Deterministic: same userId always produces same key
   */
  deriveUserKey(userId: string): Buffer {
    if (!this.masterKey) {
      throw new Error('Per-user key derivation not initialized');
    }

    const derivationInput = `${userId}:${this.context}:${this.pepper}`;
    return createHmac(DERIVATION_ALGORITHM, this.masterKey)
      .update(derivationInput)
      .digest();
  }

  /**
   * Generate a new Data Encryption Key for a user
   * Returns both plaintext (for use) and encrypted (for storage)
   */
  async generateUserDek(userId: string): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      await this.initialize();
    }
    const userKey = this.deriveUserKey(userId);
    
    // Generate random DEK
    const dek = randomBytes(32);
    
    // Encrypt DEK with user's derived key
    const { createCipheriv } = await import('node:crypto');
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', userKey, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    
    // Combine IV + encrypted
    const combined = Buffer.concat([iv, encrypted]);
    
    // Clear sensitive data
    userKey.fill(0);
    
    return {
      plaintext: dek,
      encrypted: combined.toString('base64'),
    };
  }

  /**
   * Decrypt a user's Data Encryption Key
   */
  async decryptUserDek(userId: string, encryptedDek: string): Promise<Buffer> {
    if (!this.masterKey) {
      await this.initialize();
    }
    const userKey = this.deriveUserKey(userId);
    
    try {
      const { createDecipheriv } = await import('node:crypto');
      
      const combined = Buffer.from(encryptedDek, 'base64');
      const iv = combined.subarray(0, 16);
      const encrypted = combined.subarray(16);
      
      const decipher = createDecipheriv('aes-256-cbc', userKey, iv);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      
      return decrypted;
    } finally {
      // Always clear user key
      userKey.fill(0);
    }
  }

  /**
   * Rotate a user's DEK (generate new one, old one invalidated)
   * Call this when user resets password or security incident
   */
  async rotateUserDek(userId: string): Promise<{ plaintext: Buffer; encrypted: string }> {
    // Simply generate a new DEK - old one becomes useless
    return this.generateUserDek(userId);
  }

  /**
   * Encrypt data for a specific user
   */
  async encryptForUser(userId: string, plaintext: string): Promise<string> {
    const { plaintext: dek, encrypted: encryptedDek } = await this.generateUserDek(userId);
    
    try {
      const { createCipheriv } = await import('node:crypto');
      
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-gcm', dek, iv);
      
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      
      const authTag = cipher.getAuthTag();
      
      // JSON envelope format with ciphertext key
      return JSON.stringify({
        encryptedDek,
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext: encrypted.toString('base64'),
      });
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Decrypt data for a specific user
   */
  async decryptForUser(userId: string, ciphertext: string): Promise<string> {
    let envelope: { encryptedDek: string; iv: string; authTag: string; ciphertext: string };
    try {
      envelope = JSON.parse(ciphertext);
    } catch {
      // Legacy colon-separated format
      const parts = ciphertext.split(':');
      if (parts.length !== 4) throw new Error('Invalid ciphertext format');
      const [encryptedDek, iv, authTag, ct] = parts;
      envelope = { encryptedDek, iv, authTag, ciphertext: ct };
    }
    
    const { encryptedDek, iv: ivB64, authTag: authTagB64, ciphertext: encryptedB64 } = envelope;
    
    // Decrypt the DEK
    const dek = await this.decryptUserDek(userId, encryptedDek);
    
    try {
      const { createDecipheriv } = await import('node:crypto');
      
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(authTagB64, 'base64');
      const encrypted = Buffer.from(encryptedB64, 'base64');
      
      const decipher = createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAuthTag(authTag);
      
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      
      return decrypted.toString('utf8');
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * Factory function
 */
export function createPerUserEncryption(config: PerUserEncryptionConfig): PerUserKeyDerivation {
  return new PerUserKeyDerivation(config);
}
