// Secure Encryption Module - Bun Native Implementation
// Uses WebCrypto API (native to Bun) for maximum performance

import { serverLog } from "../logger";

const ENCRYPTION_VERSION = "v2";
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM (recommended)

export interface EncryptedEnvelope {
  version: string;
  ciphertext: string;
  iv: string;
  salt: string;
}

export class SecureEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureEncryptionError";
  }
}

/**
 * Secure encryption using WebCrypto API (native to Bun)
 * 
 * SECURITY REQUIREMENTS:
 * - KORYPHAIOS_MASTER_KEY must be set in production
 * - Minimum 32 characters recommended
 * - Never commit the master key to version control
 */
export class SecureEncryption {
  private masterKey: CryptoKey | null = null;
  private isInitialized = false;

  /**
   * Initialize encryption with master key from environment
   */
  async initialize(): Promise<void> {
    const envKey = process.env.KORYPHAIOS_MASTER_KEY;
    
    if (!envKey) {
      if (process.env.NODE_ENV === "production") {
        throw new SecureEncryptionError(
          "KORYPHAIOS_MASTER_KEY is required in production. " +
          "Set a strong encryption key (32+ characters) in your environment."
        );
      }
      
      // Development fallback - warn but allow startup
      serverLog.warn(
        "KORYPHAIOS_MASTER_KEY not set. Using development fallback. " +
        "DO NOT USE IN PRODUCTION - credentials will not be secure!"
      );
      
      // Generate a random key for this session only
      const tempKey = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
      this.masterKey = await this.importKey(tempKey);
    } else {
      // Derive key from environment variable using Bun's native PBKDF2
      const encoder = new TextEncoder();
      const keyMaterial = encoder.encode(envKey);
      
      // Use WebCrypto's PBKDF2 for key derivation
      const baseKey = await crypto.subtle.importKey(
        "raw",
        keyMaterial,
        { name: "PBKDF2" },
        false,
        ["deriveBits", "deriveKey"]
      );
      
      // Fixed salt for key derivation (OK since master key is secret)
      const salt = new TextEncoder().encode("koryphaios-kdf-salt-v2");
      
      this.masterKey = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt,
          iterations: 100000,
          hash: "SHA-256",
        },
        baseKey,
        { name: ALGORITHM, length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    }
    
    this.isInitialized = true;
  }

  /**
   * Import raw key material as CryptoKey
   */
  private async importKey(keyData: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      keyData.buffer.slice(keyData.byteOffset, keyData.byteOffset + keyData.byteLength) as ArrayBuffer,
      { name: ALGORITHM },
      false,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Ensure encryption is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Encrypt plaintext to envelope using WebCrypto API
   */
  async encrypt(plaintext: string): Promise<EncryptedEnvelope> {
    await this.ensureInitialized();
    
    if (!this.masterKey) {
      throw new SecureEncryptionError("Encryption not initialized");
    }

    // Generate random IV and salt for each encryption using Bun's fast CSPRNG
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);
    
    // Encrypt using WebCrypto API (optimized in Bun)
    const encrypted = await crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv,
      },
      this.masterKey,
      data
    );

    return {
      version: ENCRYPTION_VERSION,
      ciphertext: Buffer.from(encrypted).toString("base64"),
      iv: Buffer.from(iv).toString("base64"),
      salt: Buffer.from(salt).toString("base64"),
    };
  }

  /**
   * Decrypt envelope to plaintext using WebCrypto API
   */
  async decrypt(envelope: EncryptedEnvelope): Promise<string> {
    await this.ensureInitialized();
    
    if (!this.masterKey) {
      throw new SecureEncryptionError("Encryption not initialized");
    }

    // Version check
    if (envelope.version !== ENCRYPTION_VERSION) {
      throw new SecureEncryptionError(
        `Unsupported encryption version: ${envelope.version}. Expected: ${ENCRYPTION_VERSION}`
      );
    }

    try {
      const iv = Buffer.from(envelope.iv, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      
      // Decrypt using WebCrypto API
      const decrypted = await crypto.subtle.decrypt(
        {
          name: ALGORITHM,
          iv,
        },
        this.masterKey,
        ciphertext
      );
      
      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (err) {
      throw new SecureEncryptionError(
        `Decryption failed: ${err instanceof Error ? err.message : "Unknown error"}. ` +
        "This may indicate a corrupted key or wrong master key."
      );
    }
  }

  /**
   * Serialize envelope to storage string
   */
  serialize(envelope: EncryptedEnvelope): string {
    const data = JSON.stringify(envelope);
    return `${ENCRYPTION_VERSION}:${Buffer.from(data).toString("base64")}`;
  }

  /**
   * Parse storage string to envelope
   */
  parse(serialized: string): EncryptedEnvelope {
    if (!serialized.startsWith(`${ENCRYPTION_VERSION}:`)) {
      throw new SecureEncryptionError("Invalid envelope format or version");
    }
    
    const base64Data = serialized.slice(ENCRYPTION_VERSION.length + 1);
    const data = Buffer.from(base64Data, "base64").toString("utf8");
    return JSON.parse(data) as EncryptedEnvelope;
  }

  /**
   * Check if encryption is properly configured
   */
  isSecurelyConfigured(): boolean {
    return !!process.env.KORYPHAIOS_MASTER_KEY;
  }

  /**
   * Get encryption status for health checks
   */
  getStatus(): { initialized: boolean; secure: boolean; version: string } {
    return {
      initialized: this.isInitialized,
      secure: this.isSecurelyConfigured(),
      version: ENCRYPTION_VERSION,
    };
  }
}

// Export singleton instance
export const secureEncryption = new SecureEncryption();

/**
 * Encrypt for storage - convenience function
 */
export async function encryptForStorage(plaintext: string): Promise<string> {
  const envelope = await secureEncryption.encrypt(plaintext);
  return secureEncryption.serialize(envelope);
}

/**
 * Decrypt from storage - convenience function
 */
export async function decryptFromStorage(serialized: string): Promise<string> {
  const envelope = secureEncryption.parse(serialized);
  return secureEncryption.decrypt(envelope);
}

/**
 * Check if a value is encrypted with the new format
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${ENCRYPTION_VERSION}:`);
}

/**
 * Generate a secure master key using Bun's CSPRNG
 */
export function generateMasterKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(key).toString("base64");
}

/**
 * Hash a password/API key for verification using Bun's optimized implementation
 * Uses Argon2id (memory-hard, GPU-resistant)
 */
export async function hashCredential(credential: string): Promise<string> {
  // Bun has native password hashing via Bun.password
  // This uses Argon2id or bcrypt depending on platform
  if (typeof Bun !== "undefined" && Bun.password) {
    return Bun.password.hash(credential, {
      algorithm: "argon2id",
      memoryCost: 65536,  // 64 MB
      timeCost: 3,
      // Note: parallelism is not exposed in Bun's current type definitions
      // but may be supported at runtime. Omitting for type compatibility.
    });
  }
  
  // Fallback for non-Bun environments (shouldn't happen in this codebase)
  throw new SecureEncryptionError("Bun.password not available - ensure running with Bun runtime");
}

/**
 * Verify a credential against a hash
 */
export async function verifyCredential(credential: string, hash: string): Promise<boolean> {
  if (typeof Bun !== "undefined" && Bun.password) {
    return Bun.password.verify(credential, hash);
  }
  
  throw new SecureEncryptionError("Bun.password not available - ensure running with Bun runtime");
}
