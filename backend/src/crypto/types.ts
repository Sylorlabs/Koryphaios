// Crypto types for envelope encryption

/**
 * Encrypted data envelope structure
 * This is what gets stored in the database
 */
export interface Envelope {
  /** Version of the envelope format */
  version: number;
  /** ID of the KEK used to encrypt the DEK */
  kekId: string;
  /** Version of the KEK (for rotation tracking) */
  kekVersion: number;
  /** The encrypted Data Encryption Key (base64) */
  encryptedDek: string;
  /** The encrypted data (base64) */
  encryptedData: string;
  /** Nonce/IV used for data encryption (base64) */
  nonce: string;
  /** Algorithm used for data encryption */
  algorithm: string;
  /** Timestamp when this envelope was created */
  createdAt: number;
}

/**
 * KMS Provider interface
 * All KMS implementations must conform to this
 */
export interface KMSProvider {
  readonly name: string;
  
  /** Initialize the provider */
  initialize(): Promise<void>;
  
  /** 
   * Generate a new Data Encryption Key
   * Returns the plaintext DEK and the encrypted DEK
   */
  generateDek(): Promise<{ plaintext: Buffer; encrypted: string }>;
  
  /**
   * Decrypt a DEK using the KEK
   */
  decryptDek(encryptedDek: string): Promise<Buffer>;
  
  /**
   * Get the current KEK ID and version
   */
  getKekMetadata(): Promise<{ id: string; version: number }>;
  
  /**
   * Rotate the KEK (if supported)
   * Returns true if rotation was performed
   */
  rotateKey?(): Promise<boolean>;
  
  /** Check if provider is healthy */
  healthCheck(): Promise<boolean>;
}

/**
 * Configuration for envelope encryption
 */
export interface EnvelopeConfig {
  /** KMS provider to use */
  provider: 'local' | 'aws-kms' | 'vault' | 'azure-kv' | 'gcp-kms';
  /** Provider-specific settings */
  providerConfig: Record<string, string>;
  /** How often to auto-rotate DEKs (in days) */
  dekRotationDays: number;
  /** Whether to warn about local provider in production */
  warnLocalInProduction: boolean;
}

/**
 * Result of a decryption operation
 */
export interface DecryptResult {
  data: string;
  /** Whether the envelope needs re-encryption (old key version) */
  needsRotation: boolean;
  /** Metadata about the envelope */
  metadata: {
    kekVersion: number;
    createdAt: number;
    algorithm: string;
  };
}

/**
 * Audit log entry for crypto operations
 */
export interface CryptoAuditLog {
  timestamp: number;
  operation: 'encrypt' | 'decrypt' | 'rotate' | 'key-generated';
  kekId: string;
  kekVersion: number;
  success: boolean;
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
}
