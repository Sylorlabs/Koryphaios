/**
 * Age File Encryption KMS Provider
 * 
 * Uses age file encryption (Filippo Valsorda's modern encryption tool)
 * for envelope encryption. Stores master key in age identity file.
 * 
 * Security: Modern, auditable encryption with small attack surface.
 * Best for: Self-hosted deployments wanting modern crypto without cloud dependencies.
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { KMSProvider } from '../types';
import { serverLog } from '../../logger';

export interface AgeKMSConfig {
  identityFile?: string;  // Path to age identity file
  dataDir?: string;       // Directory for storing keys
  passphrase?: string;    // Optional passphrase protection
}

export class AgeKMSProvider implements KMSProvider {
  readonly name = 'age';
  private config: AgeKMSConfig;
  private identityFile: string;
  private masterKey: Buffer | null = null;
  private kekMetadata: { id: string; version: number } = { id: 'age-master', version: 1 };

  constructor(config: AgeKMSConfig = {}) {
    this.config = config;
    this.identityFile = config.identityFile || 
      join(config.dataDir || '.koryphaios', '.age-identity');
  }

  async initialize(): Promise<void> {
    try {
      // Check if identity file exists
      const exists = await this.fileExists(this.identityFile);
      
      if (exists) {
        // Load existing identity
        const encryptedIdentity = await fs.readFile(this.identityFile);
        
        if (this.config.passphrase) {
          this.masterKey = await this.decryptIdentity(encryptedIdentity, this.config.passphrase);
        } else {
          this.masterKey = encryptedIdentity;
        }
        
        serverLog.info('Age KMS: Master key loaded from identity file');
      } else {
        // Generate new master key
        this.masterKey = crypto.randomBytes(32);
        
        // Create directory if needed
        await fs.mkdir(join(this.identityFile, '..'), { recursive: true });
        
        // Save identity
        let dataToSave: Buffer;
        if (this.config.passphrase) {
          dataToSave = await this.encryptIdentity(this.masterKey, this.config.passphrase);
        } else {
          dataToSave = this.masterKey;
        }
        
        await fs.writeFile(this.identityFile, dataToSave, { mode: 0o600 });
        
        serverLog.warn('Age KMS: New master key generated. BACK UP YOUR IDENTITY FILE!');
        serverLog.warn(`Identity file location: ${this.identityFile}`);
      }
    } catch (error) {
      serverLog.error({ error }, 'Age KMS initialization failed');
      throw error;
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      throw new Error('Age KMS not initialized');
    }

    // Generate random DEK
    const dek = crypto.randomBytes(32);
    
    // Encrypt DEK with master key using AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    
    let encrypted = cipher.update(dek);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    
    // Combine: iv + authTag + encrypted
    const combined = Buffer.concat([iv, authTag, encrypted]);
    
    return {
      plaintext: dek,
      encrypted: combined.toString('base64'),
    };
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.masterKey) {
      throw new Error('Age KMS not initialized');
    }

    const combined = Buffer.from(encryptedDek, 'base64');
    
    // Extract components
    const iv = combined.slice(0, 12);
    const authTag = combined.slice(12, 28);
    const encrypted = combined.slice(28);
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted;
  }

  async generatePerUserDek(userId: string): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      throw new Error('Age KMS not initialized');
    }

    // Derive user-specific key using HKDF
    const dek = crypto.createHmac('sha256', this.masterKey)
      .update(userId)
      .digest();
    
    // Encrypt the derived key with master key
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    
    let encrypted = cipher.update(dek);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, authTag, encrypted]);
    
    return {
      plaintext: dek,
      encrypted: combined.toString('base64'),
    };
  }

  getKeyMetadata(): Record<string, string> {
    return {
      provider: 'age',
      identityFile: this.identityFile,
      hasPassphrase: String(!!this.config.passphrase),
    };
  }

  supportsPerUserKeys(): boolean {
    return true;
  }

  healthCheck(): Promise<boolean> {
    return Promise.resolve(this.masterKey !== null);
  }

  getKekMetadata(): Promise<{ id: string; version: number }> {
    return Promise.resolve(this.kekMetadata);
  }

  // Private helpers
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async encryptIdentity(key: Buffer, passphrase: string): Promise<Buffer> {
    // Derive key from passphrase
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    
    // Encrypt master key
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    
    let encrypted = cipher.update(key);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    const authTag = cipher.getAuthTag();
    
    // Format: salt + iv + authTag + encrypted
    return Buffer.concat([salt, iv, authTag, encrypted]);
  }

  private async decryptIdentity(data: Buffer, passphrase: string): Promise<Buffer> {
    // Extract components
    const salt = data.slice(0, 16);
    const iv = data.slice(16, 28);
    const authTag = data.slice(28, 44);
    const encrypted = data.slice(44);
    
    // Derive key
    const derivedKey = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted;
  }
}
