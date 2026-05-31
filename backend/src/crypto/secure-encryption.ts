/**
 * Secure Encryption Module
 * Provides encryption/decryption for sensitive data
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { serverLog } from '../logger';

export interface EncryptedEnvelope {
  iv: string;
  salt: string;
  data: string;
  authTag: string;
  version: number;
}

class SecureEncryption {
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly KEY_LENGTH = 32;
  private readonly IV_LENGTH = 16;
  private readonly AUTH_TAG_LENGTH = 16;
  private readonly SALT_LENGTH = 32;
  private readonly CURRENT_VERSION = 1;

  private getMasterKey(): string {
    // In production, this should be retrieved from a secure key management system
    const key = process.env.KORYPHAIOS_ENCRYPTION_KEY;
    if (!key) {
      serverLog.warn('KORYPHAIOS_ENCRYPTION_KEY not set, using fallback');
      return 'fallback-key-do-not-use-in-production';
    }
    return key;
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, this.KEY_LENGTH);
  }

  /**
   * Encrypt data
   */
  async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
    const masterKey = this.getMasterKey();
    const salt = randomBytes(this.SALT_LENGTH);
    const iv = randomBytes(this.IV_LENGTH);
    const key = this.deriveKey(masterKey, salt);

    const cipher = createCipheriv(this.ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      salt: salt.toString('base64'),
      data: encrypted.toString('base64'),
      authTag: authTag.toString('base64'),
      version: this.CURRENT_VERSION,
    };
  }

  /**
   * Decrypt data
   */
  async decrypt(envelope: EncryptedEnvelope): Promise<string> {
    const masterKey = this.getMasterKey();
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const encrypted = Buffer.from(envelope.data, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const key = this.deriveKey(masterKey, salt);

    const decipher = createDecipheriv(this.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * Serialize envelope to string
   */
  serialize(envelope: EncryptedEnvelope): string {
    return JSON.stringify(envelope);
  }

  /**
   * Parse envelope from string
   */
  parse(serialized: string): EncryptedEnvelope {
    return JSON.parse(serialized) as EncryptedEnvelope;
  }
}

export const secureEncryption = new SecureEncryption();
