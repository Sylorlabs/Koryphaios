/**
 * API Key Service
 * 
 * Manages API keys for programmatic access to the model hub.
 * 
 * Security features:
 * - Keys are hashed before storage (only shown once at creation)
 * - Prefix-based key identification for quick lookup
 * - Scoping (read-only, full-access, provider-specific)
 * - Automatic expiration support
 * - Rate limit association
 * - Comprehensive audit logging
 */

import crypto from 'crypto';
import { getDb } from '../db/sqlite';
import { serverLog } from '../logger';
import { createAuditLogService } from '../services/audit';

// API Key prefix for identification
const KEY_PREFIX = 'kor_';
const KEY_LENGTH = 48; // Length of random portion

export type ApiKeyScope = 'read' | 'write' | 'admin' | 'provider:*' | string;

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string; // First 8 chars of key for identification
  hashedKey: string;
  scopes: ApiKeyScope[];
  rateLimitTier: string;
  expiresAt: number | null;
  lastUsedAt: number | null;
  usageCount: number;
  isActive: boolean;
  createdAt: number;
  metadata?: Record<string, any>;
}

export interface ApiKeyWithPlaintext extends ApiKey {
  plaintextKey: string; // Only returned at creation time
}

export interface CreateApiKeyInput {
  userId: string;
  name: string;
  scopes?: ApiKeyScope[];
  rateLimitTier?: string;
  expiresInDays?: number;
  metadata?: Record<string, any>;
}

export interface ApiKeyValidationResult {
  valid: boolean;
  key?: ApiKey;
  error?: string;
}

export class ApiKeyService {
  private db = getDb();
  private audit = createAuditLogService();

  /**
   * Generate a new API key
   * 
   * The plaintext key is ONLY returned at creation time.
   * It is hashed using SHA-256 before storage.
   */
  async create(input: CreateApiKeyInput): Promise<ApiKeyWithPlaintext> {
    const id = this.generateId();
    const plaintextKey = this.generateKey();
    const prefix = plaintextKey.slice(0, 8);
    const hashedKey = this.hashKey(plaintextKey);

    const now = Date.now();
    const expiresAt = input.expiresInDays 
      ? now + (input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const scopes = input.scopes || ['read'];
    const rateLimitTier = input.rateLimitTier || 'free';

    try {
      this.db.prepare(
        `INSERT INTO api_keys 
         (id, user_id, name, prefix, hashed_key, scopes, rate_limit_tier,
          expires_at, last_used_at, usage_count, is_active, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.userId,
        input.name,
        prefix,
        hashedKey,
        JSON.stringify(scopes),
        rateLimitTier,
        expiresAt,
        null,
        0,
        1,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null
      );

      // Audit log
      await this.audit.log({
        userId: input.userId,
        action: 'api_key_create',
        resourceType: 'api_key',
        resourceId: id,
        success: true,
        metadata: { scopes, rateLimitTier, expiresInDays: input.expiresInDays },
        timestamp: now,
      });

      serverLog.info({ userId: input.userId, keyId: id }, 'API key created');

      return {
        id,
        userId: input.userId,
        name: input.name,
        prefix,
        hashedKey,
        scopes,
        rateLimitTier,
        expiresAt,
        lastUsedAt: null,
        usageCount: 0,
        isActive: true,
        createdAt: now,
        metadata: input.metadata,
        plaintextKey,
      };
    } catch (error) {
      serverLog.error({ error, userId: input.userId }, 'Failed to create API key');
      throw error;
    }
  }

  /**
   * Validate an API key
   * 
   * Checks:
   * 1. Key format
   * 2. Hash match
   * 3. Active status
   * 4. Expiration
   * 5. Updates usage stats
   */
  async validate(plaintextKey: string): Promise<ApiKeyValidationResult> {
    // Check format
    if (!plaintextKey.startsWith(KEY_PREFIX)) {
      return { valid: false, error: 'Invalid key format' };
    }

    const prefix = plaintextKey.slice(0, 8);
    const hashedKey = this.hashKey(plaintextKey);

    // Find key by prefix (multiple keys may share prefix, so we check hash)
    const rows = this.db.prepare(
      `SELECT * FROM api_keys WHERE prefix = ? AND is_active = 1`
    ).all(prefix) as any[];

    for (const row of rows) {
      const key = this.rowToApiKey(row);
      
      // Check hash match (timing-safe)
      if (crypto.timingSafeEqual(
        Buffer.from(key.hashedKey),
        Buffer.from(hashedKey)
      )) {
        // Check expiration
        if (key.expiresAt && key.expiresAt < Date.now()) {
          return { valid: false, error: 'API key expired' };
        }

        // Update usage stats
        this.updateUsageStats(key.id);

        return { valid: true, key };
      }
    }

    return { valid: false, error: 'Invalid API key' };
  }

  /**
   * List API keys for a user (without hashed keys)
   */
  async listForUser(userId: string): Promise<Omit<ApiKey, 'hashedKey'>[]> {
    const rows = this.db.prepare(
      `SELECT id, user_id, name, prefix, scopes, rate_limit_tier,
              expires_at, last_used_at, usage_count, is_active, created_at, metadata
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    ).all(userId) as any[];

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      prefix: row.prefix,
      scopes: JSON.parse(row.scopes),
      rateLimitTier: row.rate_limit_tier,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      usageCount: row.usage_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Get a single API key
   */
  async get(userId: string, keyId: string): Promise<ApiKey | null> {
    const row = this.db.prepare(
      `SELECT * FROM api_keys WHERE id = ? AND user_id = ?`
    ).get(keyId, userId) as any;

    if (!row) return null;
    return this.rowToApiKey(row);
  }

  /**
   * Revoke an API key (soft delete)
   */
  async revoke(userId: string, keyId: string): Promise<boolean> {
    const result = this.db.prepare(
      `UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?`
    ).run(keyId, userId);

    if (result.changes > 0) {
      await this.audit.log({
        userId,
        action: 'api_key_revoke',
        resourceType: 'api_key',
        resourceId: keyId,
        success: true,
        timestamp: Date.now(),
      });

      serverLog.info({ userId, keyId }, 'API key revoked');
      return true;
    }

    return false;
  }

  /**
   * Update API key
   */
  async update(
    userId: string,
    keyId: string,
    updates: Partial<Pick<ApiKey, 'name' | 'scopes' | 'rateLimitTier'>>
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }

    if (updates.scopes !== undefined) {
      sets.push('scopes = ?');
      values.push(JSON.stringify(updates.scopes));
    }

    if (updates.rateLimitTier !== undefined) {
      sets.push('rate_limit_tier = ?');
      values.push(updates.rateLimitTier);
    }

    if (sets.length === 0) return false;

    values.push(keyId, userId);

    const result = this.db.prepare(
      `UPDATE api_keys SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
    ).run(...values);

    if (result.changes > 0) {
      await this.audit.log({
        userId,
        action: 'api_key_update',
        resourceType: 'api_key',
        resourceId: keyId,
        success: true,
        metadata: updates,
        timestamp: Date.now(),
      });

      return true;
    }

    return false;
  }

  /**
   * Check if key has required scope
   */
  hasScope(key: ApiKey, requiredScope: ApiKeyScope): boolean {
    // Admin scope grants everything
    if (key.scopes.includes('admin')) return true;

    // Direct match
    if (key.scopes.includes(requiredScope)) return true;

    // Wildcard match (e.g., 'provider:*' matches 'provider:openai')
    const prefix = requiredScope.split(':')[0];
    if (key.scopes.includes(`${prefix}:*`)) return true;

    // Write scope implies read
    if (requiredScope === 'read' && key.scopes.includes('write')) return true;

    return false;
  }

  /**
   * Clean up expired keys
   */
  async cleanupExpired(): Promise<number> {
    const result = this.db.prepare(
      `UPDATE api_keys 
       SET is_active = 0 
       WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < ?`
    ).run(Date.now());

    const count = result.changes;
    if (count > 0) {
      serverLog.info({ count }, 'Expired API keys deactivated');
    }

    return count;
  }

  private generateId(): string {
    return `key_${crypto.randomBytes(12).toString('base64url')}`;
  }

  private generateKey(): string {
    const random = crypto.randomBytes(KEY_LENGTH).toString('base64url');
    return `${KEY_PREFIX}${random}`;
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private updateUsageStats(keyId: string): void {
    try {
      this.db.prepare(
        `UPDATE api_keys 
         SET usage_count = usage_count + 1, last_used_at = ? 
         WHERE id = ?`
      ).run(Date.now(), keyId);
    } catch (error) {
      serverLog.error({ error, keyId }, 'Failed to update API key usage stats');
    }
  }

  private rowToApiKey(row: any): ApiKey {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      prefix: row.prefix,
      hashedKey: row.hashed_key,
      scopes: JSON.parse(row.scopes),
      rateLimitTier: row.rate_limit_tier,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      usageCount: row.usage_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}

// Singleton instance
let apiKeyService: ApiKeyService | null = null;

export function createApiKeyService(): ApiKeyService {
  if (!apiKeyService) {
    apiKeyService = new ApiKeyService();
  }
  return apiKeyService;
}

export function getApiKeyService(): ApiKeyService {
  return createApiKeyService();
}
