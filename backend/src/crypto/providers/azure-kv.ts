// Azure Key Vault Provider
// Uses Azure Key Vault for envelope encryption

import { serverLog } from '../../logger';
import type { KMSProvider } from '../types';

export interface AzureKMSConfig {
  /** Key Vault name (e.g., 'my-keyvault') */
  vaultName: string;
  /** Key name */
  keyName: string;
  /** Azure tenant ID */
  tenantId: string;
  /** Azure client ID (service principal) */
  clientId: string;
  /** Azure client secret */
  clientSecret: string;
  /** Azure cloud environment (optional, defaults to public) */
  cloudEnvironment?: string;
}

/**
 * Azure Key Vault KMS Provider
 * 
 * Uses Azure Key Vault Keys API for envelope encryption.
 * Supports HSM-backed keys (Premium tier).
 * 
 * Setup:
 * 1. Create Azure Key Vault (Standard or Premium for HSM)
 * 2. Create a key: az keyvault key create --name mykey --vault-name myvault
 * 3. Create service principal with permissions:
 *    - keys/get (for key metadata)
 *    - keys/wrapKey (for encrypting DEKs)
 *    - keys/unwrapKey (for decrypting DEKs)
 */
export class AzureKMSProvider implements KMSProvider {
  readonly name = 'azure-kv';
  private config: AzureKMSConfig;
  private accessToken: string | null = null;
  private keyVersion: string = '';
  private keyId: string = '';

  constructor(config: AzureKMSConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      // Get access token
      await this.authenticate();
      
      // Get key info
      await this.refreshKeyInfo();

      serverLog.info({ 
        vault: this.config.vaultName, 
        key: this.config.keyName,
        version: this.keyVersion 
      }, 'Azure Key Vault initialized');
    } catch (error: any) {
      serverLog.error({ error, vault: this.config.vaultName }, 'Failed to initialize Azure Key Vault');
      throw new Error(`Azure Key Vault initialization failed: ${error.message}`);
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.accessToken) {
      throw new Error('Azure Key Vault not authenticated');
    }

    try {
      // Generate DEK locally (Azure Key Vault doesn't have a direct data key API)
      const { randomBytes } = await import('node:crypto');
      const dek = randomBytes(32);

      // Wrap (encrypt) the DEK using Azure Key Vault
      const url = `https://${this.config.vaultName}.vault.azure.net/keys/${this.config.keyName}/${this.keyVersion}/wrapKey?api-version=7.4`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alg: 'RSA-OAEP-256',
          value: dek.toString('base64'),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Azure Key Vault error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      return {
        plaintext: dek,
        encrypted: data.value, // base64-encoded wrapped key
      };
    } catch (error: any) {
      serverLog.error({ error }, 'Azure Key Vault wrap key failed');
      throw new Error(`Failed to generate data key: ${error.message}`);
    }
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.accessToken) {
      throw new Error('Azure Key Vault not authenticated');
    }

    try {
      // Unwrap (decrypt) the DEK using Azure Key Vault
      const url = `https://${this.config.vaultName}.vault.azure.net/keys/${this.config.keyName}/${this.keyVersion}/unwrapKey?api-version=7.4`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alg: 'RSA-OAEP-256',
          value: encryptedDek,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Azure Key Vault error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      return Buffer.from(data.value, 'base64');
    } catch (error: any) {
      serverLog.error({ error }, 'Azure Key Vault unwrap key failed');
      throw new Error(`Failed to decrypt data key: ${error.message}`);
    }
  }

  async getKekMetadata(): Promise<{ id: string; version: number }> {
    // Parse version from keyVersion string (format: timestamp or semantic)
    const versionNum = parseInt(this.keyVersion, 10) || 1;
    
    return {
      id: this.keyId,
      version: versionNum,
    };
  }

  async rotateKey(): Promise<boolean> {
    if (!this.accessToken) {
      throw new Error('Azure Key Vault not authenticated');
    }

    try {
      // Rotate the key
      const url = `https://${this.config.vaultName}.vault.azure.net/keys/${this.config.keyName}/rotate?api-version=7.4`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Azure Key Vault rotation error: ${response.status} ${error}`);
      }

      await this.refreshKeyInfo();
      
      serverLog.info({ 
        keyName: this.config.keyName, 
        newVersion: this.keyVersion 
      }, 'Azure Key Vault key rotated');

      return true;
    } catch (error: any) {
      serverLog.error({ error }, 'Azure Key Vault key rotation failed');
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.accessToken) {
      return false;
    }

    try {
      // Try to get key info
      await this.refreshKeyInfo();
      return true;
    } catch {
      return false;
    }
  }

  private async authenticate(): Promise<void> {
    const url = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://vault.azure.net/.default',
      grant_type: 'client_credentials',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure authentication failed: ${error}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
  }

  private async refreshKeyInfo(): Promise<void> {
    if (!this.accessToken) {
      throw new Error('Azure Key Vault not authenticated');
    }

    const url = `https://${this.config.vaultName}.vault.azure.net/keys/${this.config.keyName}?api-version=7.4`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get key info: ${error}`);
    }

    const data = await response.json();
    this.keyVersion = data.key?.kid?.split('/').pop() || '';
    this.keyId = data.key?.kid || '';
  }
}
