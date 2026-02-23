// Crypto module exports

export { EnvelopeEncryption, createEnvelopeEncryption } from './envelope';
export type {
  Envelope,
  KMSProvider,
  EnvelopeConfig,
  DecryptResult,
  CryptoAuditLog,
} from './types';

// Per-user encryption
export { PerUserKeyDerivation, createPerUserEncryption } from './per-user';
export type { PerUserEncryptionConfig } from './per-user';

// Re-export all providers from providers/index
export * from './providers';
export {
  LocalKMSProvider,
  AWSKMSProvider,
  VaultKMSProvider,
  AzureKMSProvider,
  GCPKMSProvider,
} from './providers';

export type { LocalKMSConfig } from './providers/local';
export type { AWSKMSConfig } from './providers/aws-kms';
export type { VaultKMSConfig } from './providers/vault';
export type { AzureKMSConfig } from './providers/azure-kv';
export type { GCPKMSConfig } from './providers/gcp-kms';

// Import types for the factory function
import type { KMSProvider } from './types';
import { LocalKMSProvider } from './providers/local';
import { AWSKMSProvider } from './providers/aws-kms';
import { VaultKMSProvider } from './providers/vault';
import { AzureKMSProvider } from './providers/azure-kv';
import { GCPKMSProvider } from './providers/gcp-kms';
import { serverLog } from '../logger';

export interface KMSProviderConfig {
  type: 'local' | 'aws-kms' | 'vault' | 'azure-kv' | 'gcp-kms';
  // Provider-specific config
  config: Record<string, any>;
}

/**
 * Factory function to create KMS provider from configuration
 */
export function createKMSProvider(providerConfig: KMSProviderConfig): KMSProvider {
  switch (providerConfig.type) {
    case 'local':
      return new LocalKMSProvider({
        dataDir: providerConfig.config.dataDir || '.koryphaios',
        passphrase: providerConfig.config.passphrase,
        suppressWarning: providerConfig.config.suppressWarning,
      });
    
    case 'aws-kms':
      return new AWSKMSProvider({
        region: providerConfig.config.region,
        keyId: providerConfig.config.keyId,
        accessKeyId: providerConfig.config.accessKeyId,
        secretAccessKey: providerConfig.config.secretAccessKey,
        sessionToken: providerConfig.config.sessionToken,
        endpoint: providerConfig.config.endpoint,
      });
    
    case 'vault':
      return new VaultKMSProvider({
        address: providerConfig.config.address,
        keyName: providerConfig.config.keyName,
        authMethod: providerConfig.config.authMethod,
        authConfig: providerConfig.config.authConfig,
        namespace: providerConfig.config.namespace,
        mountPath: providerConfig.config.mountPath,
        skipTlsVerify: providerConfig.config.skipTlsVerify,
        caCert: providerConfig.config.caCert,
      });
    
    case 'azure-kv':
      return new AzureKMSProvider({
        vaultName: providerConfig.config.vaultName,
        keyName: providerConfig.config.keyName,
        tenantId: providerConfig.config.tenantId,
        clientId: providerConfig.config.clientId,
        clientSecret: providerConfig.config.clientSecret,
      });
    
    case 'gcp-kms':
      return new GCPKMSProvider({
        projectId: providerConfig.config.projectId,
        location: providerConfig.config.location,
        keyRing: providerConfig.config.keyRing,
        keyName: providerConfig.config.keyName,
        authMethod: providerConfig.config.authMethod,
        serviceAccountKey: providerConfig.config.serviceAccountKey,
      });
    
    default:
      throw new Error(`Unknown KMS provider type: ${(providerConfig as any).type}`);
  }
}

/**
 * Create KMS provider from environment variables
 * Uses appropriate provider based on KORYPHAIOS_KMS_PROVIDER
 */
export function createKMSProviderFromEnv(): KMSProvider {
  const provider = process.env.KORYPHAIOS_KMS_PROVIDER || 'local';
  
  switch (provider) {
    case 'local':
      serverLog.info('Using Local KMS provider (development only)');
      return new LocalKMSProvider({
        dataDir: process.env.KORYPHAIOS_DATA_DIR || '.koryphaios',
        passphrase: process.env.KORYPHAIOS_KMS_PASSPHRASE,
        suppressWarning: process.env.NODE_ENV === 'development',
      });
    
    case 'aws-kms':
      serverLog.info('Using AWS KMS provider');
      return new AWSKMSProvider({
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
        keyId: process.env.KORYPHAIOS_KMS_KEY_ID!,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      });
    
    case 'vault':
      serverLog.info('Using HashiCorp Vault provider');
      return new VaultKMSProvider({
        address: process.env.VAULT_ADDR!,
        keyName: process.env.KORYPHAIOS_KMS_KEY_NAME!,
        authMethod: (process.env.VAULT_AUTH_METHOD as any) || 'token',
        authConfig: parseVaultAuthConfig(),
        namespace: process.env.VAULT_NAMESPACE,
      });
    
    case 'azure-kv':
      serverLog.info('Using Azure Key Vault provider');
      return new AzureKMSProvider({
        vaultName: process.env.KORYPHAIOS_KMS_VAULT_NAME!,
        keyName: process.env.KORYPHAIOS_KMS_KEY_NAME!,
        tenantId: process.env.AZURE_TENANT_ID!,
        clientId: process.env.AZURE_CLIENT_ID!,
        clientSecret: process.env.AZURE_CLIENT_SECRET!,
      });
    
    case 'gcp-kms':
      serverLog.info('Using GCP KMS provider');
      return new GCPKMSProvider({
        projectId: process.env.GCP_PROJECT_ID!,
        location: process.env.KORYPHAIOS_KMS_LOCATION!,
        keyRing: process.env.KORYPHAIOS_KMS_KEY_RING!,
        keyName: process.env.KORYPHAIOS_KMS_KEY_NAME!,
        authMethod: process.env.GCP_SERVICE_ACCOUNT_KEY ? 'serviceAccount' : 'default',
        serviceAccountKey: process.env.GCP_SERVICE_ACCOUNT_KEY,
      });
    
    default:
      throw new Error(`Unknown KMS provider: ${provider}`);
  }
}

function parseVaultAuthConfig(): { token: string } | { roleId: string; secretId: string } | { role: string } {
  const method = process.env.VAULT_AUTH_METHOD || 'token';
  
  switch (method) {
    case 'token':
      return { token: process.env.VAULT_TOKEN! };
    case 'approle':
      return {
        roleId: process.env.VAULT_ROLE_ID!,
        secretId: process.env.VAULT_SECRET_ID!,
      };
    case 'kubernetes':
      return {
        role: process.env.VAULT_K8S_ROLE!,
      };
    case 'aws':
      return {
        role: process.env.VAULT_AWS_ROLE!,
      };
    default:
      return { token: process.env.VAULT_TOKEN! };
  }
}
