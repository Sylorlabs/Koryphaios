/**
 * Cloudflare Workers KV KMS Provider
 * 
 * Uses Cloudflare Workers KV for key storage and Web Crypto API for encryption.
 * Designed for edge deployments on Cloudflare Workers.
 * 
 * Security: Uses Cloudflare's distributed edge infrastructure.
 * Best for: Edge-deployed applications using Cloudflare Workers.
 */

import type { KMSProvider } from '../types';
import { serverLog } from '../../logger';

export interface CloudflareKMSConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  keyName?: string;
}

interface KVResponse {
  success: boolean;
  errors?: { message: string }[];
  messages?: string[];
  result?: any;
}

export class CloudflareKMSProvider implements KMSProvider {
  readonly name = 'cloudflare-kv';
  private config: CloudflareKMSConfig;
  private baseUrl: string;
  private masterKey: CryptoKey | null = null;
  private localKeyBuffer: Buffer | null = null;
  private kekMetadata: { id: string; version: number } = { id: 'cf-kv-master', version: 1 };

  constructor(config: CloudflareKMSConfig) {
    this.config = {
      keyName: 'koryphaios-master-key',
      ...config,
    };
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}`;
  }

  async initialize(): Promise<void> {
    try {
      // Try to retrieve existing master key
      const existingKey = await this.getFromKV(this.config.keyName!);
      
      if (existingKey) {
        // Import the key
        this.localKeyBuffer = Buffer.from(existingKey, 'base64');
        this.masterKey = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(this.localKeyBuffer),
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        serverLog.info('Cloudflare KMS: Master key loaded from KV');
      } else {
        // Generate new master key
        const newKey = crypto.getRandomValues(new Uint8Array(32));
        this.localKeyBuffer = Buffer.from(newKey);
        
        // Store in KV
        await this.putToKV(
          this.config.keyName!,
          this.localKeyBuffer.toString('base64')
        );
        
        // Import for use
        this.masterKey = await crypto.subtle.importKey(
          'raw',
          newKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        
        serverLog.info('Cloudflare KMS: New master key generated and stored in KV');
      }
    } catch (error) {
      serverLog.error({ error }, 'Cloudflare KMS initialization failed');
      throw error;
    }
  }

  async generateDek(): Promise<{ plaintext: Buffer; encrypted: string }> {
    // Generate a random DEK
    const dek = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    
    // Encrypt DEK with master key using AES-KW (key wrap)
    const encrypted = await this.wrapKey(dek);
    
    return {
      plaintext: dek,
      encrypted: Buffer.from(encrypted).toString('base64'),
    };
  }

  async decryptDek(encryptedDek: string): Promise<Buffer> {
    const encrypted = Buffer.from(encryptedDek, 'base64');
    const decrypted = await this.unwrapKey(encrypted);
    return Buffer.from(decrypted);
  }

  async generatePerUserDek(userId: string): Promise<{ plaintext: Buffer; encrypted: string }> {
    if (!this.localKeyBuffer) {
      throw new Error('Cloudflare KMS not initialized');
    }
    
    // Derive user-specific key using HKDF-like construction
    const encoder = new TextEncoder();
    const userData = encoder.encode(userId);
    
    // Use Web Crypto for key derivation
    const combined = new Uint8Array(this.localKeyBuffer!.length + userData.length);
    combined.set(new Uint8Array(this.localKeyBuffer!), 0);
    combined.set(userData, this.localKeyBuffer!.length);
    const userKey = await crypto.subtle.digest('SHA-256', combined);
    
    const dek = Buffer.from(userKey);
    
    // Encrypt the derived key with master key
    const encrypted = await this.wrapKey(dek);
    
    return {
      plaintext: dek,
      encrypted: Buffer.from(encrypted).toString('base64'),
    };
  }

  getKeyMetadata(): Record<string, string> {
    return {
      provider: 'cloudflare-kv',
      keyName: this.config.keyName!,
      accountId: this.config.accountId,
    };
  }

  supportsPerUserKeys(): boolean {
    return true;
  }

  healthCheck(): Promise<boolean> {
    return Promise.resolve(this.masterKey !== null);
  }

  getKekMetadata(): Promise<{ id: string; version: number }> {
    return Promise.resolve(this.kekMetadata);
  }

  // Private methods for KV operations
  private async getFromKV(key: string): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiToken}`,
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`KV get failed: ${response.statusText}`);
    }

    return response.text();
  }

  private async putToKV(key: string, value: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/values/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.config.apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: value,
    });

    if (!response.ok) {
      throw new Error(`KV put failed: ${response.statusText}`);
    }
  }

  // Web Crypto key wrapping (AES-KW simulation since Workers may not support AES-KW)
  private async wrapKey(key: Buffer): Promise<ArrayBuffer> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    // Generate a random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // Encrypt the key
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.masterKey,
      new Uint8Array(key)
    );

    // Prepend IV to encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    
    return result.buffer;
  }

  private async unwrapKey(wrapped: Buffer): Promise<ArrayBuffer> {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    // Extract IV (first 12 bytes)
    const iv = wrapped.slice(0, 12);
    const encrypted = wrapped.slice(12);

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.masterKey,
      encrypted
    );

    return decrypted;
  }
}
