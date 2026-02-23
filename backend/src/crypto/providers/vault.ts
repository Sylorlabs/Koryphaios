// HashiCorp Vault KMS Provider
// Uses Vault's Transit secrets engine for envelope encryption

import { serverLog } from '../../logger';
import type { KMSProvider } from '../types';

export interface VaultKMSConfig {
  /** Vault server URL (e.g., https://vault.example.com:8200) */
  address: string;
  /** Transit key name */
  keyName: string;
  /** 
   * Authentication method
   * - 'token': Direct token (development)
   * - 'approle': AppRole (production)
   * - 'kubernetes': Kubernetes service account
   * - 'aws': AWS IAM
   */
  authMethod: 'token' | 'approle' | 'kubernetes' | 'aws';
  /** Auth credentials (method-specific) */
  authConfig: VaultAuthConfig;
  /** Vault namespace (for Vault Enterprise) */
  namespace?: string;
  /** Transit engine mount path */
  mountPath?: string;
  /** Skip TLS verification (development only - NOT RECOMMENDED) */
  skipTlsVerify?: boolean;
  /** Custom CA certificate for TLS */
  caCert?: string;
}

type VaultAuthConfig =
  | { token: string }
  | { roleId: string; secretId: string }
  | { role: string; jwt?: string } // Kubernetes
  | { role: string; mount?: string }; // AWS IAM

/**
 * HashiCorp Vault KMS Provider
 * 
 * Uses Vault's Transit secrets engine for key management.
 * Vault handles encryption/decryption and key rotation.
 * 
 * Setup:
 * 1. Enable Transit engine: vault secrets enable transit
 * 2. Create key: vault write -f transit/keys/:name
 * 3. Configure ACL policy for the app
 * 4. Set up authentication (AppRole recommended for production)
 * 
 * Features:
 * - Automatic key rotation (configurable interval)
 * - Key versioning with automatic upgrade
 * - Detailed audit logging
 * - Multiple authentication methods
 * - HSM integration (Vault Enterprise)
 */
export class VaultKMSProvider implements KMSProvider {
  readonly name = 'vault';
  private config: VaultKMSConfig;
  private token: string | null = null;
  private keyVersion: number = 1;

  constructor(config: VaultKMSConfig) {
    this.config = config;
    this.config.mountPath = config.mountPath || 'transit';
  }

  async initialize(): Promise<void> {
    try {
      // Authenticate with Vault
      await this.authenticate();

      // Verify key exists and get current version
      await this.refreshKeyInfo();

      serverLog.info({ 
        address: this.config.address, 
        keyName: this.config.keyName,
        version: this.keyVersion 
      }, 'HashiCorp Vault KMS initialized');
    } catch (error: any) {
      serverLog.error({ error, address: this.config.address }, 'Failed to initialize Vault KMS');
      throw new Error(`Vault KMS initialization failed: ${error.message}`);
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.token) {
      throw new Error('Vault not authenticated');
    }

    try {
      // Vault Transit generates data keys
      const url = `${this.config.address}/v1/${this.config.mountPath}/datakey/plaintext/${this.config.keyName}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
          ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
        },
        body: JSON.stringify({
          bits: 256,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Vault API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      // plaintext is base64-encoded DEK
      const plaintext = Buffer.from(data.data.plaintext, 'base64');
      // ciphertext is the encrypted DEK (includes key version)
      const encrypted = data.data.ciphertext;

      return { plaintext, encrypted };
    } catch (error: any) {
      serverLog.error({ error }, 'Vault generate data key failed');
      throw new Error(`Failed to generate data key: ${error.message}`);
    }
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.token) {
      throw new Error('Vault not authenticated');
    }

    try {
      // Vault Transit decrypts the data key
      const url = `${this.config.address}/v1/${this.config.mountPath}/decrypt/${this.config.keyName}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
          ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
        },
        body: JSON.stringify({
          ciphertext: encryptedDek,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Vault API error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      // plaintext is base64-encoded DEK
      return Buffer.from(data.data.plaintext, 'base64');
    } catch (error: any) {
      serverLog.error({ error }, 'Vault decrypt failed');
      throw new Error(`Failed to decrypt data key: ${error.message}`);
    }
  }

  async getKekMetadata(): Promise<{ id: string; version: number }> {
    return {
      id: `${this.config.address}/${this.config.mountPath}/${this.config.keyName}`,
      version: this.keyVersion,
    };
  }

  async rotateKey(): Promise<boolean> {
    if (!this.token) {
      throw new Error('Vault not authenticated');
    }

    try {
      // Rotate the transit key
      const url = `${this.config.address}/v1/${this.config.mountPath}/keys/${this.config.keyName}/rotate`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Vault rotation error: ${response.status} ${error}`);
      }

      await this.refreshKeyInfo();
      
      serverLog.info({ 
        keyName: this.config.keyName, 
        newVersion: this.keyVersion 
      }, 'Vault key rotated');

      return true;
    } catch (error: any) {
      serverLog.error({ error }, 'Vault key rotation failed');
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.token) {
      return false;
    }

    try {
      const url = `${this.config.address}/v1/sys/health`;
      
      const response = await fetch(url, {
        headers: {
          'X-Vault-Token': this.token,
          ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
        },
      });

      // Vault returns 200 for initialized, unsealed, and active
      // 429 for unsealed and standby
      // 472 for data recovery mode replication secondary
      // 473 for performance standby
      return response.ok || response.status === 429 || response.status === 473;
    } catch {
      return false;
    }
  }

  private async authenticate(): Promise<void> {
    switch (this.config.authMethod) {
      case 'token':
        await this.authToken();
        break;
      case 'approle':
        await this.authAppRole();
        break;
      case 'kubernetes':
        await this.authKubernetes();
        break;
      case 'aws':
        await this.authAWS();
        break;
      default:
        throw new Error(`Unknown auth method: ${this.config.authMethod}`);
    }
  }

  private async authToken(): Promise<void> {
    const config = this.config.authConfig as { token: string };
    this.token = config.token;
    
    // Verify token works
    const url = `${this.config.address}/v1/auth/token/lookup-self`;
    
    const response = await fetch(url, {
      headers: {
        'X-Vault-Token': this.token,
        ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
      },
    });

    if (!response.ok) {
      throw new Error('Invalid Vault token');
    }
  }

  private async authAppRole(): Promise<void> {
    const config = this.config.authConfig as { roleId: string; secretId: string };
    
    const url = `${this.config.address}/v1/auth/approle/login`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
      },
      body: JSON.stringify({
        role_id: config.roleId,
        secret_id: config.secretId,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`AppRole auth failed: ${error}`);
    }

    const data = await response.json();
    this.token = data.auth.client_token;
  }

  private async authKubernetes(): Promise<void> {
    const config = this.config.authConfig as { role: string; jwt?: string };
    
    // Get JWT from service account if not provided
    let jwt = config.jwt;
    if (!jwt) {
      try {
        const { readFileSync } = await import('node:fs');
        jwt = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
      } catch {
        throw new Error('Kubernetes JWT not provided and not running in pod');
      }
    }
    
    const url = `${this.config.address}/v1/auth/kubernetes/login`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
      },
      body: JSON.stringify({
        role: config.role,
        jwt,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kubernetes auth failed: ${error}`);
    }

    const data = await response.json();
    this.token = data.auth.client_token;
  }

  private async authAWS(): Promise<void> {
    const config = this.config.authConfig as { role: string; mount?: string };
    const mount = config.mount || 'aws';
    
    // AWS IAM auth requires AWS SDK for signing
    // Install: npm install @aws-sdk/client-sts
    throw new Error(
      'AWS IAM auth requires @aws-sdk/client-sts. ' +
      'Install it with: npm install @aws-sdk/client-sts'
    );
  }

  private async refreshKeyInfo(): Promise<void> {
    if (!this.token) {
      throw new Error('Vault not authenticated');
    }

    const url = `${this.config.address}/v1/${this.config.mountPath}/keys/${this.config.keyName}`;
    
    const response = await fetch(url, {
      headers: {
        'X-Vault-Token': this.token,
        ...(this.config.namespace && { 'X-Vault-Namespace': this.config.namespace }),
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get key info: ${error}`);
    }

    const data = await response.json();
    this.keyVersion = data.data.latest_version;
  }
}
