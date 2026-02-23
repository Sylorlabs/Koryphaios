// Migration utility for transitioning from old encryption to envelope encryption

import { decryptApiKey, encryptApiKey } from '../security';
import { serverLog } from '../logger';
import { EnvelopeEncryption } from './envelope';
import type { Envelope } from './types';

export interface MigrationResult {
  success: boolean;
  migrated: number;
  failed: number;
  errors: Array<{ key: string; error: string }>;
}

export interface MigratableKey {
  key: string;
  encryptedValue: string;
}

/**
 * Migration utility for envelope encryption
 * 
 * Handles migrating from the old static-seed encryption to the new
 * envelope encryption system. Can be run incrementally or in bulk.
 */
export class EncryptionMigration {
  private encryption: EnvelopeEncryption;

  constructor(encryption: EnvelopeEncryption) {
    this.encryption = encryption;
  }

  /**
   * Migrate a single key value
   * 
   * @param encryptedValue - The old encrypted value (with "enc:" prefix)
   * @returns The new envelope-encrypted value
   */
  async migrateValue(encryptedValue: string): Promise<{ newValue: string; success: boolean; error?: string }> {
    try {
      // Step 1: Decrypt using old method
      const plaintext = decryptApiKey(encryptedValue);
      
      // Step 2: Re-encrypt using envelope encryption
      const envelope = await this.encryption.encrypt(plaintext);
      
      // Step 3: Serialize envelope
      const newValue = `env:${this.encryption.serialize(envelope)}`;
      
      return { newValue, success: true };
    } catch (error: any) {
      return { newValue: encryptedValue, success: false, error: error.message };
    }
  }

  /**
   * Migrate multiple keys in batch
   * 
   * @param keys - Array of keys to migrate
   * @returns Migration result statistics
   */
  async migrateBatch(keys: MigratableKey[]): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      migrated: 0,
      failed: 0,
      errors: [],
    };

    serverLog.info({ count: keys.length }, 'Starting batch migration');

    for (const { key, encryptedValue } of keys) {
      // Skip if already migrated (starts with "env:")
      if (encryptedValue.startsWith('env:')) {
        result.migrated++;
        continue;
      }

      // Skip if not using old encryption (doesn't start with "enc:")
      if (!encryptedValue.startsWith('enc:')) {
        result.migrated++;
        continue;
      }

      const { newValue, success, error } = await this.migrateValue(encryptedValue);

      if (success) {
        result.migrated++;
        serverLog.debug({ key }, 'Migrated key');
      } else {
        result.failed++;
        result.errors.push({ key, error: error || 'Unknown error' });
        serverLog.error({ key, error }, 'Failed to migrate key');
      }
    }

    result.success = result.failed === 0;
    
    serverLog.info({
      total: keys.length,
      migrated: result.migrated,
      failed: result.failed,
    }, 'Batch migration complete');

    return result;
  }

  /**
   * Migrate provider credentials in the database
   * This is a helper for the common case of migrating stored API keys
   */
  async migrateDatabaseCredentials(
    readCredentials: () => Promise<Array<{ provider: string; apiKey?: string; authToken?: string; baseUrl?: string }>>,
    updateCredential: (provider: string, updates: { apiKey?: string; authToken?: string }) => Promise<void>
  ): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      migrated: 0,
      failed: 0,
      errors: [],
    };

    try {
      const credentials = await readCredentials();
      
      for (const cred of credentials) {
        const updates: { apiKey?: string; authToken?: string } = {};

        // Migrate apiKey if present
        if (cred.apiKey && cred.apiKey.startsWith('enc:')) {
          const { newValue, success, error } = await this.migrateValue(cred.apiKey);
          if (success) {
            updates.apiKey = newValue;
          } else {
            result.failed++;
            result.errors.push({ key: `${cred.provider}:apiKey`, error: error || 'Unknown' });
          }
        }

        // Migrate authToken if present
        if (cred.authToken && cred.authToken.startsWith('enc:')) {
          const { newValue, success, error } = await this.migrateValue(cred.authToken);
          if (success) {
            updates.authToken = newValue;
          } else {
            result.failed++;
            result.errors.push({ key: `${cred.provider}:authToken`, error: error || 'Unknown' });
          }
        }

        // Update if there are changes
        if (Object.keys(updates).length > 0) {
          try {
            await updateCredential(cred.provider, updates);
            result.migrated++;
            serverLog.info({ provider: cred.provider }, 'Migrated credentials');
          } catch (error: any) {
            result.failed++;
            result.errors.push({ key: cred.provider, error: error.message });
            serverLog.error({ provider: cred.provider, error: error.message }, 'Failed to update migrated credentials');
          }
        }
      }

      result.success = result.failed === 0;
    } catch (error: any) {
      result.success = false;
      result.errors.push({ key: 'database', error: error.message });
      serverLog.error({ error: error.message }, 'Database migration failed');
    }

    return result;
  }

  /**
   * Verify migration by decrypting a sample of migrated keys
   */
  async verifyMigration(
    keys: Array<{ key: string; encryptedValue: string; expectedPlaintext?: string }>
  ): Promise<{ success: boolean; verified: number; failed: number; errors: string[] }> {
    const result = {
      success: true,
      verified: 0,
      failed: 0,
      errors: [] as string[],
    };

    for (const { key, encryptedValue, expectedPlaintext } of keys) {
      try {
        // Skip non-envelope encrypted values
        if (!encryptedValue.startsWith('env:')) {
          continue;
        }

        // Parse and decrypt
        const envelopeJson = encryptedValue.slice(4); // Remove "env:" prefix
        const envelope = this.encryption.parse(envelopeJson);
        const { data } = await this.encryption.decrypt(envelope);

        // Verify if expected plaintext provided
        if (expectedPlaintext && data !== expectedPlaintext) {
          result.failed++;
          result.errors.push(`${key}: Decrypted value doesn't match expected`);
          continue;
        }

        result.verified++;
      } catch (error: any) {
        result.failed++;
        result.errors.push(`${key}: ${error.message}`);
      }
    }

    result.success = result.failed === 0;
    return result;
  }
}

/**
 * Create migration helper
 */
export function createMigration(encryption: EnvelopeEncryption): EncryptionMigration {
  return new EncryptionMigration(encryption);
}

/**
 * Check if a value is using the new envelope encryption
 */
export function isEnvelopeEncrypted(value: string): boolean {
  return value.startsWith('env:');
}

/**
 * Check if a value is using the old encryption
 */
export function isLegacyEncrypted(value: string): boolean {
  return value.startsWith('enc:');
}

/**
 * Parse an envelope from a stored value (removes "env:" prefix)
 */
export function parseStoredEnvelope(value: string): string {
  if (!value.startsWith('env:')) {
    throw new Error('Value is not envelope encrypted');
  }
  return value.slice(4);
}
