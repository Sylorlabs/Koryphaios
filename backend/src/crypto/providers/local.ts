// Local KMS Provider
// WARNING: This is for development only. In production, use a real KMS.
// Stores the master key in a file with strict permissions (0o600)

import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../../logger';
import type { KMSProvider } from '../types';

const KEY_FILE = '.master-key';
const KEY_SIZE = 32;
const SALT_SIZE = 32;

interface LocalKeyData {
  /** Salt for key derivation */
  salt: string;
  /** Encrypted master key */
  encryptedKey: string;
  /** Key ID (derived from hash) */
  keyId: string;
  /** Version for rotation tracking */
  version: number;
}

export interface LocalKMSConfig {
  /** Directory to store the master key file */
  dataDir: string;
  /** Optional passphrase to protect the master key (HIGHLY RECOMMENDED) */
  passphrase?: string;
  /** Whether to suppress production warning */
  suppressWarning?: boolean;
}

/**
 * Local KMS Provider
 * 
 * ⚠️ SECURITY WARNING ⚠️
 * This provider is for DEVELOPMENT ONLY. It stores the master key on disk.
 * In production, use AWS KMS, HashiCorp Vault, or another external KMS.
 * 
 * How it works:
 * 1. Generates a random master key on first use
 * 2. Encrypts the master key with a passphrase-derived key (if passphrase provided)
 *    or stores it plaintext (if no passphrase - VERY INSECURE)
 * 3. Stores in a file with 0o600 permissions
 * 4. Uses the master key to encrypt/decrypt DEKs
 */
export class LocalKMSProvider implements KMSProvider {
  readonly name = 'local';
  private config: LocalKMSConfig;
  private masterKey: Buffer | null = null;
  private keyData: LocalKeyData | null = null;
  private keyFilePath: string;

  constructor(config: LocalKMSConfig) {
    this.config = config;
    this.keyFilePath = join(config.dataDir, KEY_FILE);
    
    if (!config.suppressWarning) {
      serverLog.warn('╔════════════════════════════════════════════════════════════════╗');
      serverLog.warn('║  SECURITY WARNING: Using Local KMS Provider                   ║');
      serverLog.warn('║  This is NOT suitable for production use!                     ║');
      serverLog.warn('║  The master key is stored on disk.                            ║');
      serverLog.warn('║  Use AWS KMS, HashiCorp Vault, or Azure Key Vault instead.    ║');
      serverLog.warn('╚════════════════════════════════════════════════════════════════╝');
    }
  }

  async initialize(): Promise<void> {
    // Ensure data directory exists
    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });

    if (existsSync(this.keyFilePath)) {
      await this.loadMasterKey();
    } else {
      await this.generateMasterKey();
    }

    serverLog.info({ keyId: this.keyData?.keyId, version: this.keyData?.version }, 'Local KMS initialized');
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    // Generate random DEK
    const dek = randomBytes(KEY_SIZE);
    
    // Encrypt DEK with master key
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    
    // Combine IV + encrypted DEK
    const combined = Buffer.concat([iv, encrypted]);
    
    return {
      plaintext: dek,
      encrypted: combined.toString('base64'),
    };
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    const combined = Buffer.from(encryptedDek, 'base64');
    
    // Extract IV and encrypted data
    const iv = combined.subarray(0, 16);
    const encrypted = combined.subarray(16);
    
    // Decrypt DEK
    const decipher = createDecipheriv('aes-256-cbc', this.masterKey, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    
    return decrypted;
  }

  async getKekMetadata(): Promise<{ id: string; version: number }> {
    if (!this.keyData) {
      throw new Error('Key data not initialized');
    }
    
    return {
      id: this.keyData.keyId,
      version: this.keyData.version,
    };
  }

  async rotateKey(): Promise<boolean> {
    if (!this.keyData || !this.masterKey) {
      throw new Error('Key not initialized');
    }

    serverLog.info('Rotating local master key...');

    // Generate new master key
    const newMasterKey = randomBytes(KEY_SIZE);
    
    // Increment version
    this.keyData.version++;
    
    // Store new key
    await this.saveMasterKey(newMasterKey);
    
    // Clear old key
    this.masterKey.fill(0);
    this.masterKey = newMasterKey;

    serverLog.info({ keyId: this.keyData.keyId, version: this.keyData.version }, 'Master key rotated');
    
    return true;
  }

  async healthCheck(): Promise<boolean> {
    return this.masterKey !== null && this.keyData !== null;
  }

  /**
   * Get the current master key file path (for backup purposes)
   */
  getKeyFilePath(): string {
    return this.keyFilePath;
  }

  private async generateMasterKey(): Promise<void> {
    serverLog.info('Generating new local master key...');

    // Generate random master key
    const masterKey = randomBytes(KEY_SIZE);
    
    // Generate key ID from hash
    const keyId = createHash('sha256').update(masterKey).digest('hex').substring(0, 16);
    
    this.keyData = {
      salt: randomBytes(SALT_SIZE).toString('base64'),
      encryptedKey: '', // Will be set by saveMasterKey
      keyId,
      version: 1,
    };

    await this.saveMasterKey(masterKey);
    this.masterKey = masterKey;

    serverLog.info({ keyId }, 'New master key generated');
    
    if (!this.config.passphrase) {
      serverLog.warn('╔════════════════════════════════════════════════════════════════╗');
      serverLog.warn('║  CRITICAL: No passphrase set for local KMS!                   ║');
      serverLog.warn('║  The master key is stored with weak protection.               ║');
      serverLog.warn('║  Set KORYPHAIOS_KMS_PASSPHRASE environment variable.          ║');
      serverLog.warn('╚════════════════════════════════════════════════════════════════╝');
    }
  }

  private async loadMasterKey(): Promise<void> {
    try {
      const content = readFileSync(this.keyFilePath, 'utf8');
      this.keyData = JSON.parse(content) as LocalKeyData;
      
      const encryptedKey = Buffer.from(this.keyData.encryptedKey, 'base64');
      
      if (this.config.passphrase) {
        // Decrypt with passphrase
        const salt = Buffer.from(this.keyData.salt, 'base64');
        const key = scryptSync(this.config.passphrase, salt, KEY_SIZE);
        
        const iv = encryptedKey.subarray(0, 16);
        const encrypted = encryptedKey.subarray(16);
        
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        this.masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        
        // Clear derived key
        key.fill(0);
      } else {
        // No passphrase - assume direct storage (legacy/insecure mode)
        const iv = encryptedKey.subarray(0, 16);
        const encrypted = encryptedKey.subarray(16);
        
        // For backward compatibility, try to decrypt with empty key
        const key = scryptSync('', Buffer.from(this.keyData.salt, 'base64'), KEY_SIZE);
        
        try {
          const decipher = createDecipheriv('aes-256-cbc', key, iv);
          this.masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        } catch {
          // Try plaintext (very old format)
          this.masterKey = encryptedKey;
        }
        
        key.fill(0);
      }
      
      serverLog.info({ keyId: this.keyData.keyId, version: this.keyData.version }, 'Master key loaded');
    } catch (error: any) {
      throw new Error(`Failed to load master key: ${error.message}`);
    }
  }

  private async saveMasterKey(masterKey: Buffer): Promise<void> {
    if (!this.keyData) {
      throw new Error('Key data not initialized');
    }

    let encryptedKey: Buffer;
    
    if (this.config.passphrase) {
      // Encrypt with passphrase
      const salt = Buffer.from(this.keyData.salt, 'base64');
      const key = scryptSync(this.config.passphrase, salt, KEY_SIZE);
      
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
      
      encryptedKey = Buffer.concat([iv, encrypted]);
      
      // Clear derived key
      key.fill(0);
    } else {
      // Store with empty encryption (insecure but functional)
      const salt = Buffer.from(this.keyData.salt, 'base64');
      const key = scryptSync('', salt, KEY_SIZE);
      
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
      
      encryptedKey = Buffer.concat([iv, encrypted]);
      
      key.fill(0);
    }

    this.keyData.encryptedKey = encryptedKey.toString('base64');
    
    // Write with strict permissions
    writeFileSync(
      this.keyFilePath,
      JSON.stringify(this.keyData, null, 2),
      { mode: 0o600 }
    );
  }
}
