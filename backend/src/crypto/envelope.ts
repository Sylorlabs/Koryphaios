// Envelope Encryption Implementation
// Provides secure encryption with external KMS integration

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { serverLog } from '../logger';
import type { Envelope, KMSProvider, DecryptResult, CryptoAuditLog } from './types';

const ENVELOPE_VERSION = 1;
const DATA_ALGORITHM = 'aes-256-gcm';
const DATA_KEY_SIZE = 32; // 256 bits
const NONCE_SIZE = 16; // 128 bits for AES-GCM
const AUTH_TAG_SIZE = 16; // 128 bits

export class EnvelopeEncryption {
  private provider: KMSProvider;
  private auditLogs: CryptoAuditLog[] = [];
  private maxAuditLogs = 1000;

  constructor(provider: KMSProvider) {
    this.provider = provider;
  }

  /**
   * Initialize the encryption system
   */
  async initialize(): Promise<void> {
    const startTime = Date.now();
    try {
      await this.provider.initialize();
      serverLog.info({ provider: this.provider.name }, 'Envelope encryption initialized');
      this.logAudit({
        timestamp: Date.now(),
        operation: 'key-generated',
        kekId: (await this.provider.getKekMetadata()).id,
        kekVersion: (await this.provider.getKekMetadata()).version,
        success: true,
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      serverLog.error({ error, provider: this.provider.name }, 'Failed to initialize envelope encryption');
      throw error;
    }
  }

  /**
   * Encrypt plaintext data using envelope encryption
   * 
   * Process:
   * 1. Generate a random DEK (Data Encryption Key)
   * 2. Encrypt the data with AES-256-GCM using the DEK
   * 3. Encrypt the DEK with the KEK (Key Encryption Key) from KMS
   * 4. Store: encrypted DEK + encrypted data + metadata
   */
  async encrypt(plaintext: string): Promise<Envelope> {
    const startTime = Date.now();
    const kekMeta = await this.provider.getKekMetadata();

    try {
      // Step 1: Generate DEK
      const { plaintext: dek, encrypted: encryptedDek } = await this.provider.generateDek();

      // Step 2: Generate nonce for data encryption
      const nonce = randomBytes(NONCE_SIZE);

      // Step 3: Encrypt data with DEK
      const cipher = createCipheriv(DATA_ALGORITHM, dek, nonce);
      const encryptedData = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      // Combine authTag + encryptedData for storage
      const combinedData = Buffer.concat([authTag, encryptedData]);

      // Step 4: Clear DEK from memory
      dek.fill(0);

      const envelope: Envelope = {
        version: ENVELOPE_VERSION,
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        encryptedDek,
        encryptedData: combinedData.toString('base64'),
        nonce: nonce.toString('base64'),
        algorithm: DATA_ALGORITHM,
        createdAt: Date.now(),
      };

      this.logAudit({
        timestamp: Date.now(),
        operation: 'encrypt',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: true,
        durationMs: Date.now() - startTime,
      });

      return envelope;
    } catch (error: any) {
      this.logAudit({
        timestamp: Date.now(),
        operation: 'encrypt',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: false,
        error: error.message,
        durationMs: Date.now() - startTime,
      });
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt an envelope to get the plaintext
   * 
   * Process:
   * 1. Decrypt the DEK using the KMS
   * 2. Decrypt the data using the DEK
   * 3. Clear DEK from memory
   */
  async decrypt(envelope: Envelope): Promise<DecryptResult> {
    const startTime = Date.now();
    const kekMeta = await this.provider.getKekMetadata();

    try {
      // Step 1: Decrypt the DEK
      const encryptedDek = envelope.encryptedDek;
      const dek = await this.provider.decryptDek(encryptedDek);

      // Step 2: Extract auth tag and encrypted data
      const combinedData = Buffer.from(envelope.encryptedData, 'base64');
      const authTag = combinedData.subarray(0, AUTH_TAG_SIZE);
      const encryptedData = combinedData.subarray(AUTH_TAG_SIZE);

      // Step 3: Decrypt data
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const decipher = createDecipheriv(DATA_ALGORITHM, dek, nonce);
      decipher.setAuthTag(authTag);

      const plaintext = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]).toString('utf8');

      // Step 4: Clear DEK from memory
      dek.fill(0);

      // Check if envelope needs rotation
      const needsRotation = envelope.kekVersion < kekMeta.version;

      this.logAudit({
        timestamp: Date.now(),
        operation: 'decrypt',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: true,
        durationMs: Date.now() - startTime,
      });

      return {
        data: plaintext,
        needsRotation,
        metadata: {
          kekVersion: envelope.kekVersion,
          createdAt: envelope.createdAt,
          algorithm: envelope.algorithm,
        },
      };
    } catch (error: any) {
      this.logAudit({
        timestamp: Date.now(),
        operation: 'decrypt',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: false,
        error: error.message,
        durationMs: Date.now() - startTime,
      });
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * Re-encrypt data with the current KEK version
   * Use this when needsRotation is true from decrypt()
   */
  async rotate(envelope: Envelope): Promise<Envelope> {
    const startTime = Date.now();
    const kekMeta = await this.provider.getKekMetadata();

    try {
      // Decrypt with old envelope
      const { data } = await this.decrypt(envelope);
      
      // Re-encrypt with new KEK
      const newEnvelope = await this.encrypt(data);

      this.logAudit({
        timestamp: Date.now(),
        operation: 'rotate',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: true,
        durationMs: Date.now() - startTime,
      });

      return newEnvelope;
    } catch (error: any) {
      this.logAudit({
        timestamp: Date.now(),
        operation: 'rotate',
        kekId: kekMeta.id,
        kekVersion: kekMeta.version,
        success: false,
        error: error.message,
        durationMs: Date.now() - startTime,
      });
      throw new Error(`Rotation failed: ${error.message}`);
    }
  }

  /**
   * Serialize envelope to string for storage
   */
  serialize(envelope: Envelope): string {
    return JSON.stringify(envelope);
  }

  /**
   * Parse envelope from string
   */
  parse(serialized: string): Envelope {
    try {
      const envelope = JSON.parse(serialized) as Envelope;
      
      // Validate envelope structure
      if (envelope.version !== ENVELOPE_VERSION) {
        throw new Error(`Unsupported envelope version: ${envelope.version}`);
      }
      if (!envelope.encryptedDek || !envelope.encryptedData) {
        throw new Error('Invalid envelope: missing encrypted fields');
      }
      
      return envelope;
    } catch (error: any) {
      throw new Error(`Failed to parse envelope: ${error.message}`);
    }
  }

  /**
   * Get recent audit logs
   */
  getAuditLogs(): CryptoAuditLog[] {
    return [...this.auditLogs];
  }

  /**
   * Check if provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.provider.healthCheck();
    } catch {
      return false;
    }
  }

  private logAudit(entry: CryptoAuditLog): void {
    this.auditLogs.push(entry);
    
    // Keep only recent logs
    if (this.auditLogs.length > this.maxAuditLogs) {
      this.auditLogs = this.auditLogs.slice(-this.maxAuditLogs);
    }

    // Log failures at warn level
    if (!entry.success) {
      serverLog.warn({ entry }, 'Crypto operation failed');
    }
  }
}

/**
 * Create envelope encryption instance from configuration
 */
export async function createEnvelopeEncryption(
  provider: KMSProvider
): Promise<EnvelopeEncryption> {
  const encryption = new EnvelopeEncryption(provider);
  await encryption.initialize();
  return encryption;
}
