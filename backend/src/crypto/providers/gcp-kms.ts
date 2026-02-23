// Google Cloud KMS Provider
// Uses Google Cloud Key Management Service for envelope encryption

import { serverLog } from '../../logger';
import type { KMSProvider } from '../types';

export interface GCPKMSConfig {
  /** GCP project ID */
  projectId: string;
  /** Key ring location (e.g., 'us-central1') */
  location: string;
  /** Key ring name */
  keyRing: string;
  /** Key name */
  keyName: string;
  /** 
   * Authentication method:
   * - 'default': Use Application Default Credentials
   * - 'serviceAccount': Use service account JSON
   */
  authMethod: 'default' | 'serviceAccount';
  /** Service account JSON key (if authMethod is 'serviceAccount') */
  serviceAccountKey?: string;
}

/**
 * Google Cloud KMS Provider
 * 
 * Uses Google Cloud KMS for envelope encryption.
 * Supports software and HSM-backed keys.
 * 
 * Setup:
 * 1. Create key ring: gcloud kms keyrings create my-ring --location=us-central1
 * 2. Create key: gcloud kms keys create my-key --keyring=my-ring --location=us-central1 --purpose=encryption
 * 3. Grant permissions:
 *    - roles/cloudkms.cryptoKeyEncrypterDecrypter
 * 
 * Features:
 * - Automatic key rotation (configurable schedule)
 * - Cloud audit logging
 * - IAM access control
 * - CMEK (Customer-Managed Encryption Keys)
 */
export class GCPKMSProvider implements KMSProvider {
  readonly name = 'gcp-kms';
  private config: GCPKMSConfig;
  private accessToken: string | null = null;
  private keyVersion: string = '';

  constructor(config: GCPKMSConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      // Authenticate
      await this.authenticate();
      
      // Get key info
      await this.refreshKeyInfo();

      serverLog.info({ 
        project: this.config.projectId, 
        keyRing: this.config.keyRing,
        key: this.config.keyName,
        version: this.keyVersion 
      }, 'Google Cloud KMS initialized');
    } catch (error: any) {
      serverLog.error({ error, project: this.config.projectId }, 'Failed to initialize GCP KMS');
      throw new Error(`GCP KMS initialization failed: ${error.message}`);
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.accessToken) {
      throw new Error('GCP KMS not authenticated');
    }

    try {
      // Generate DEK locally (GCP KMS doesn't have a direct data key API like AWS)
      const { randomBytes } = await import('node:crypto');
      const dek = randomBytes(32);

      // Encrypt the DEK using GCP KMS
      const keyName = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
      const url = `https://cloudkms.googleapis.com/v1/${keyName}:encrypt`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plaintext: dek.toString('base64'),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GCP KMS error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      return {
        plaintext: dek,
        encrypted: data.ciphertext, // base64-encoded encrypted key
      };
    } catch (error: any) {
      serverLog.error({ error }, 'GCP KMS encrypt failed');
      throw new Error(`Failed to generate data key: ${error.message}`);
    }
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.accessToken) {
      throw new Error('GCP KMS not authenticated');
    }

    try {
      // Decrypt the DEK using GCP KMS
      const keyName = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
      const url = `https://cloudkms.googleapis.com/v1/${keyName}:decrypt`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ciphertext: encryptedDek,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GCP KMS error: ${response.status} ${error}`);
      }

      const data = await response.json();
      
      return Buffer.from(data.plaintext, 'base64');
    } catch (error: any) {
      serverLog.error({ error }, 'GCP KMS decrypt failed');
      throw new Error(`Failed to decrypt data key: ${error.message}`);
    }
  }

  async getKekMetadata(): Promise<{ id: string; version: number }> {
    const keyId = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
    const versionNum = parseInt(this.keyVersion, 10) || 1;
    
    return {
      id: keyId,
      version: versionNum,
    };
  }

  async rotateKey(): Promise<boolean> {
    // GCP KMS handles rotation via scheduled rotation policy
    // We can manually rotate by creating a new key version
    
    if (!this.accessToken) {
      throw new Error('GCP KMS not authenticated');
    }

    try {
      const keyName = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
      const url = `https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`GCP KMS rotation error: ${response.status} ${error}`);
      }

      await this.refreshKeyInfo();
      
      serverLog.info({ 
        keyName: this.config.keyName, 
        newVersion: this.keyVersion 
      }, 'GCP KMS key rotated');

      return true;
    } catch (error: any) {
      serverLog.error({ error }, 'GCP KMS key rotation failed');
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
    if (this.config.authMethod === 'serviceAccount' && this.config.serviceAccountKey) {
      // Service account JSON authentication
      const serviceAccount = JSON.parse(this.config.serviceAccountKey);
      
      const url = 'https://oauth2.googleapis.com/token';
      
      const jwt = await this.createJWT(serviceAccount);
      
      const params = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
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
        throw new Error(`GCP authentication failed: ${error}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
    } else {
      // Use metadata server (when running on GCP)
      const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
      
      const response = await fetch(url, {
        headers: {
          'Metadata-Flavor': 'Google',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to get access token from metadata server');
      }

      const data = await response.json();
      this.accessToken = data.access_token;
    }
  }

  private async createJWT(serviceAccount: any): Promise<string> {
    const { createSign } = await import('node:crypto');
    
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid: serviceAccount.private_key_id,
    };
    
    const now = Math.floor(Date.now() / 1000);
    const claimSet = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/cloudkms',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const claimSetB64 = Buffer.from(JSON.stringify(claimSet)).toString('base64url');
    const signatureInput = `${headerB64}.${claimSetB64}`;
    
    const signer = createSign('RSA-SHA256');
    signer.update(signatureInput);
    const signature = signer.sign(serviceAccount.private_key, 'base64url');
    
    return `${signatureInput}.${signature}`;
  }

  private async refreshKeyInfo(): Promise<void> {
    if (!this.accessToken) {
      throw new Error('GCP KMS not authenticated');
    }

    // Get the primary key version
    const keyName = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
    const url = `https://cloudkms.googleapis.com/v1/${keyName}?fields=primary.name`;
    
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
    // Extract version number from primary.name (format: .../cryptoKeyVersions/1)
    const match = data.primary?.name?.match(/cryptoKeyVersions\/(\d+)$/);
    this.keyVersion = match ? match[1] : '';
  }
}
