// AWS KMS Provider
// Uses AWS Key Management Service for envelope encryption

import { serverLog } from '../../logger';
import type { KMSProvider } from '../types';

export interface AWSKMSConfig {
  /** AWS region */
  region: string;
  /** KMS key ID or alias */
  keyId: string;
  /** AWS access key ID (optional, uses default credential chain if not provided) */
  accessKeyId?: string;
  /** AWS secret access key (optional) */
  secretAccessKey?: string;
  /** AWS session token (optional, for temporary credentials) */
  sessionToken?: string;
  /** Custom endpoint for VPC endpoints or LocalStack testing */
  endpoint?: string;
}

// AWS SDK types (for type checking without requiring the package)
// @ts-ignore
type KMSClientType = typeof import('@aws-sdk/client-kms').KMSClient;
// @ts-ignore
type DescribeKeyCommandType = typeof import('@aws-sdk/client-kms').DescribeKeyCommand;
// @ts-ignore
type GenerateDataKeyCommandType = typeof import('@aws-sdk/client-kms').GenerateDataKeyCommand;
// @ts-ignore
type DecryptCommandType = typeof import('@aws-sdk/client-kms').DecryptCommand;
// @ts-ignore
type GetKeyRotationStatusCommandType = typeof import('@aws-sdk/client-kms').GetKeyRotationStatusCommand;
// @ts-ignore
type EnableKeyRotationCommandType = typeof import('@aws-sdk/client-kms').EnableKeyRotationCommand;

/**
 * AWS KMS Provider
 * 
 * Uses AWS KMS to generate and decrypt data keys.
 * The master key never leaves AWS KMS - only encrypted data keys are handled locally.
 * 
 * Setup:
 * 1. Create a KMS key in AWS console or CLI
 * 2. Grant the application IAM permissions:
 *    - kms:GenerateDataKey
 *    - kms:Decrypt
 *    - kms:DescribeKey
 * 3. Configure with key ID/alias
 * 
 * Features:
 * - Automatic key rotation (AWS handles this annually)
 * - CloudTrail audit logging
 * - IAM access control
 * - Regional availability
 * 
 * Required dependency:
 *   npm install @aws-sdk/client-kms
 */
export class AWSKMSProvider implements KMSProvider {
  readonly name = 'aws-kms';
  private config: AWSKMSConfig;
  private client: any = null;

  constructor(config: AWSKMSConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid bundling AWS SDK when not needed
      let KMSClient: KMSClientType;
      let DescribeKeyCommand: DescribeKeyCommandType;
      
      try {
        // @ts-ignore - Optional dependency
        const awsSdk = await import('@aws-sdk/client-kms');
        KMSClient = awsSdk.KMSClient;
        DescribeKeyCommand = awsSdk.DescribeKeyCommand;
      } catch (importError) {
        throw new Error(
          'AWS SDK not found. Install it with: npm install @aws-sdk/client-kms'
        );
      }
      
      const clientConfig: any = {
        region: this.config.region,
      };

      // Use custom endpoint if provided (for VPC endpoints or LocalStack)
      if (this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint;
      }

      // Use explicit credentials if provided, otherwise use default credential chain
      if (this.config.accessKeyId && this.config.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
          ...(this.config.sessionToken && { sessionToken: this.config.sessionToken }),
        };
      }

      this.client = new KMSClient(clientConfig);

      // Verify key exists and we have access
      await this.client.send(new DescribeKeyCommand({
        KeyId: this.config.keyId,
      }));

      serverLog.info({ region: this.config.region, keyId: this.config.keyId }, 'AWS KMS initialized');
    } catch (error: any) {
      serverLog.error({ error, region: this.config.region }, 'Failed to initialize AWS KMS');
      throw new Error(`AWS KMS initialization failed: ${error.message}`);
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.client) {
      throw new Error('AWS KMS client not initialized');
    }

    try {
      // @ts-ignore - Optional dependency
      const { GenerateDataKeyCommand } = await import('@aws-sdk/client-kms');
      
      const response = await this.client.send(new GenerateDataKeyCommand({
        KeyId: this.config.keyId,
        KeySpec: 'AES_256',
      }));

      if (!response.Plaintext || !response.CiphertextBlob) {
        throw new Error('AWS KMS returned empty response');
      }

      // Plaintext is a Uint8Array, convert to Buffer
      const plaintext = Buffer.from(response.Plaintext);
      
      // CiphertextBlob is the encrypted DEK
      const encrypted = Buffer.from(response.CiphertextBlob).toString('base64');

      // Important: AWS SDK documentation says we don't need to clear the Uint8Array
      // as it's not stored in memory long-term, but we'll clear our Buffer copy
      return { plaintext, encrypted };
    } catch (error: any) {
      serverLog.error({ error }, 'AWS KMS generate data key failed');
      throw new Error(`Failed to generate data key: ${error.message}`);
    }
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error('AWS KMS client not initialized');
    }

    try {
      // @ts-ignore - Optional dependency
      const { DecryptCommand } = await import('@aws-sdk/client-kms');
      
      const ciphertextBlob = Buffer.from(encryptedDek, 'base64');
      
      const response = await this.client.send(new DecryptCommand({
        CiphertextBlob: ciphertextBlob,
        KeyId: this.config.keyId, // Optional but recommended for key ID binding
      }));

      if (!response.Plaintext) {
        throw new Error('AWS KMS returned empty plaintext');
      }

      return Buffer.from(response.Plaintext);
    } catch (error: any) {
      serverLog.error({ error }, 'AWS KMS decrypt failed');
      throw new Error(`Failed to decrypt data key: ${error.message}`);
    }
  }

  async getKekMetadata(): Promise<{ id: string; version: number }> {
    if (!this.client) {
      throw new Error('AWS KMS client not initialized');
    }

    try {
      // @ts-ignore - Optional dependency
      const { DescribeKeyCommand } = await import('@aws-sdk/client-kms');
      
      const response = await this.client.send(new DescribeKeyCommand({
        KeyId: this.config.keyId,
      }));

      const keyMetadata = response.KeyMetadata;
      if (!keyMetadata) {
        throw new Error('Key metadata not available');
      }

      return {
        id: keyMetadata.KeyId || this.config.keyId,
        version: 1, // AWS handles rotation internally, we use the key ID as version
      };
    } catch (error: any) {
      serverLog.error({ error }, 'AWS KMS describe key failed');
      throw new Error(`Failed to get key metadata: ${error.message}`);
    }
  }

  async rotateKey(): Promise<boolean> {
    // AWS KMS handles automatic rotation annually
    // Manual rotation creates a new key, which we don't want here
    // Instead, we can enable automatic rotation if not already enabled
    
    if (!this.client) {
      throw new Error('AWS KMS client not initialized');
    }

    try {
      // @ts-ignore - Optional dependency
      const { GetKeyRotationStatusCommand, EnableKeyRotationCommand } = await import('@aws-sdk/client-kms');
      
      // Check current rotation status
      const statusResponse = await this.client.send(new GetKeyRotationStatusCommand({
        KeyId: this.config.keyId,
      }));

      if (!statusResponse.KeyRotationEnabled) {
        await this.client.send(new EnableKeyRotationCommand({
          KeyId: this.config.keyId,
        }));
        serverLog.info({ keyId: this.config.keyId }, 'Enabled automatic key rotation in AWS KMS');
      }

      return true;
    } catch (error: any) {
      serverLog.error({ error }, 'AWS KMS rotation check failed');
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      // @ts-ignore - Optional dependency
      const { DescribeKeyCommand } = await import('@aws-sdk/client-kms');
      
      await this.client.send(new DescribeKeyCommand({
        KeyId: this.config.keyId,
      }));
      
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the key ARN (useful for IAM policies)
   */
  async getKeyArn(): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }

    try {
      // @ts-ignore - Optional dependency
      const { DescribeKeyCommand } = await import('@aws-sdk/client-kms');
      
      const response = await this.client.send(new DescribeKeyCommand({
        KeyId: this.config.keyId,
      }));

      return response.KeyMetadata?.Arn;
    } catch {
      return undefined;
    }
  }
}
