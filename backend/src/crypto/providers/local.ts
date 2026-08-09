// Local KMS Provider
// WARNING: This is for development only. In production, use a real KMS.
// Stores the master key in a file with strict permissions (0o600)

import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../../logger';
import { ensureSecureDir } from '../../security/fs-permissions';
import type { KMSProvider } from '../types';

const KEY_FILE = '.master-key';
const KEY_SIZE = 32;
const SALT_SIZE = 32;
const GCM_IV_SIZE = 12; // 96 bits — the recommended IV size for AES-GCM
const GCM_TAG_SIZE = 16; // 128-bit auth tag

/** Key file format version. v2 uses AES-256-GCM for the DEK wrap; v1 used
 *  AES-256-CBC (unauthenticated). The loader detects v1 and re-wraps under
 *  GCM on next save. */
const KEY_FILE_VERSION = 2;

interface LocalKeyData {
  /** Salt for key derivation */
  salt: string;
  /** Encrypted master key */
  encryptedKey: string;
  /** Key ID (derived from hash) */
  keyId: string;
  /** Version for rotation tracking */
  version: number;
  /** Key file format version. v1 = AES-256-CBC (legacy), v2 = AES-256-GCM. */
  formatVersion?: number;
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
    // SECURITY: Enforce external KMS in production
    if (process.env.NODE_ENV === 'production' && !this.config.suppressWarning) {
      throw new Error(
        'Local KMS Provider is NOT allowed in production. ' +
          'Please configure an external KMS provider (AWS KMS, Azure Key Vault, ' +
          'HashiCorp Vault, GCP KMS, or Cloudflare KMS) by setting KORYPHAIOS_KMS_PROVIDER. ' +
          'Set suppressWarning: true ONLY if you understand the security implications.',
      );
    }

    // SECURITY: Require a passphrase. The empty-passphrase fallback stored
    // the master key "encrypted" with scryptSync('', salt) — anyone with
    // file read access had both the ciphertext and the key. Now we fail
    // closed unless KORYPHAIOS_KMS_PASSPHRASE is set OR the user explicitly
    // opts into the insecure mode with KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS=1
    // (documented as "your keys are plaintext on disk").
    if (!this.config.passphrase && process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS !== '1') {
      throw new Error(
        'Local KMS requires a passphrase. Set KORYPHAIOS_KMS_PASSPHRASE in your ' +
          'environment (e.g. in ~/.config/koryphaios/secrets.env), or set ' +
          'KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS=1 to acknowledge that the master ' +
          'key will be stored with weak protection. For production, use an ' +
          'external KMS provider (KORYPHAIOS_KMS_PROVIDER=aws-kms|vault|...).',
      );
    }

    // Ensure data directory exists and is tightened to 0o700 (heals existing
    // dirs created by older builds with a looser umask).
    ensureSecureDir(this.config.dataDir);

    if (existsSync(this.keyFilePath)) {
      await this.loadMasterKey();
    } else {
      await this.generateMasterKey();
    }

    serverLog.info(
      { keyId: this.keyData?.keyId, version: this.keyData?.version, formatVersion: this.keyData?.formatVersion ?? 1 },
      'Local KMS initialized',
    );
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      await this.initialize();
    }
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }
    const masterKey = this.masterKey;

    // Generate random DEK
    const dek = randomBytes(KEY_SIZE);

    // Encrypt DEK with master key using AES-256-GCM (authenticated).
    // The auth tag protects against tampering — CBC had no integrity
    // guarantee, so a modified encrypted-DEK blob would fail on decrypt
    // but with no way to detect corruption vs. attack.
    const iv = randomBytes(GCM_IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine IV + authTag + encrypted DEK
    const combined = Buffer.concat([iv, authTag, encrypted]);

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

    // GCM format: IV (12) + authTag (16) + ciphertext
    // Legacy CBC format: IV (16) + ciphertext (no auth tag)
    // Detect by length: GCM has at least 12+16=28 bytes of header; CBC has 16.
    // We try GCM first; if the auth tag verification fails AND the blob looks
    // like legacy CBC, fall back to CBC for backward compatibility.
    if (combined.length >= GCM_IV_SIZE + GCM_TAG_SIZE) {
      try {
        const iv = combined.subarray(0, GCM_IV_SIZE);
        const authTag = combined.subarray(GCM_IV_SIZE, GCM_IV_SIZE + GCM_TAG_SIZE);
        const encrypted = combined.subarray(GCM_IV_SIZE + GCM_TAG_SIZE);
        const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch (gcmErr) {
        // Fall through to legacy CBC attempt for old envelopes.
        serverLog.debug(
          { err: gcmErr instanceof Error ? gcmErr.message : String(gcmErr) },
          'GCM DEK decrypt failed; trying legacy CBC format',
        );
      }
    }

    // Legacy CBC format (v1 key files and old envelopes).
    const iv = combined.subarray(0, 16);
    const encrypted = combined.subarray(16);
    const decipher = createDecipheriv('aes-256-cbc', this.masterKey, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    serverLog.warn('Decrypted DEK using legacy CBC format — re-encrypt to migrate to GCM.');
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

    serverLog.info(
      { keyId: this.keyData.keyId, version: this.keyData.version },
      'Master key rotated',
    );

    return true;
  }

  async healthCheck(): Promise<boolean> {
    return this.masterKey !== null && this.keyData !== null;
  }

  supportsPerUserKeys(): boolean {
    return true;
  }

  async generatePerUserDek(
    derivationInput: string,
  ): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.masterKey) {
      await this.initialize();
    }
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }
    const masterKey = this.masterKey;
    const { createHmac, randomBytes, createCipheriv } = await import('node:crypto');
    // Derive a deterministic user key from master key + derivationInput
    const userKey = createHmac('sha256', masterKey).update(derivationInput).digest();
    // Encrypt the derived key for storage using AES-256-GCM (authenticated).
    // The auth tag protects against tampering — the old CBC path had no
    // integrity guarantee.
    const iv = randomBytes(GCM_IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    const enc = Buffer.concat([cipher.update(userKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encrypted = Buffer.concat([iv, authTag, enc]).toString('base64');
    return { plaintext: userKey, encrypted };
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
      formatVersion: KEY_FILE_VERSION,
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
      const formatVersion = this.keyData.formatVersion ?? 1;

      // Derive the key-encryption key from the passphrase (or empty string
      // in insecure mode, which is now gated by KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS).
      const passphrase = this.config.passphrase ?? '';
      const salt = Buffer.from(this.keyData.salt, 'base64');
      const kek = scryptSync(passphrase, salt, KEY_SIZE);

      if (formatVersion >= 2) {
        // GCM format: IV (12) + authTag (16) + ciphertext
        const iv = encryptedKey.subarray(0, GCM_IV_SIZE);
        const authTag = encryptedKey.subarray(GCM_IV_SIZE, GCM_IV_SIZE + GCM_TAG_SIZE);
        const encrypted = encryptedKey.subarray(GCM_IV_SIZE + GCM_TAG_SIZE);
        const decipher = createDecipheriv('aes-256-gcm', kek, iv);
        decipher.setAuthTag(authTag);
        this.masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } else {
        // Legacy v1 CBC format — decrypt, then re-save under GCM.
        const iv = encryptedKey.subarray(0, 16);
        const encrypted = encryptedKey.subarray(16);
        const decipher = createDecipheriv('aes-256-cbc', kek, iv);
        this.masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        serverLog.warn(
          'Loaded master key from v1 (CBC) key file — re-saving under GCM (v2).',
        );
        // Re-wrap under GCM and bump formatVersion.
        this.keyData.formatVersion = KEY_FILE_VERSION;
        await this.saveMasterKey(this.masterKey);
      }

      kek.fill(0);

      serverLog.info(
        { keyId: this.keyData.keyId, version: this.keyData.version, formatVersion: this.keyData.formatVersion },
        'Master key loaded',
      );
    } catch (error: unknown) {
      throw new Error(`Failed to load master key: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveMasterKey(masterKey: Buffer): Promise<void> {
    if (!this.keyData) {
      throw new Error('Key data not initialized');
    }

    // Derive the key-encryption key from the passphrase (or empty string
    // in insecure mode).
    const passphrase = this.config.passphrase ?? '';
    const salt = Buffer.from(this.keyData.salt, 'base64');
    const kek = scryptSync(passphrase, salt, KEY_SIZE);

    // Encrypt the master key with AES-256-GCM (authenticated).
    const iv = randomBytes(GCM_IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Combine IV + authTag + encrypted master key
    const encryptedKey = Buffer.concat([iv, authTag, encrypted]);

    kek.fill(0);

    this.keyData.encryptedKey = encryptedKey.toString('base64');
    this.keyData.formatVersion = KEY_FILE_VERSION;

    // Write with strict permissions
    writeFileSync(this.keyFilePath, JSON.stringify(this.keyData, null, 2), { mode: 0o600 });
  }
}
