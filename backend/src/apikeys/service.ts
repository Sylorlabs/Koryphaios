/**
 * API Key Service
 */

import crypto from 'crypto';
import { db, apiKeys } from '../db';
import { serverLog } from '../logger';
import { createAuditLogService } from '../services/audit';
import { eq, and, desc, sql } from 'drizzle-orm';

const KEY_PREFIX = 'kor_';
const KEY_LENGTH = 48;

export type ApiKeyScope = 'read' | 'write' | 'admin' | 'provider:*' | string;

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
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
  plaintextKey: string;
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
  private audit = createAuditLogService();

  async create(input: any): Promise<ApiKeyWithPlaintext> {
    const plaintextKey = `${KEY_PREFIX}${crypto.randomBytes(KEY_LENGTH).toString('base64url')}`;
    const prefix = plaintextKey.slice(0, 8);
    const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');
    const now = new Date();
    const id = `key_${crypto.randomBytes(12).toString('base64url')}`;

    const [row] = await db
      .insert(apiKeys)
      .values({
        id,
        userId: input.userId,
        name: input.name,
        prefix,
        hashedKey,
        scopes: JSON.stringify(input.scopes || ['read']),
        rateLimitTier: input.rateLimitTier || 'free',
        expiresAt: input.expiresInDays
          ? new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000)
          : null,
        createdAt: now,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      })
      .returning();

    await this.audit.log({
      userId: input.userId,
      action: 'api_key_create',
      success: true,
      timestamp: now.getTime(),
    });
    return { ...this.rowToApiKey(row), plaintextKey };
  }

  async validate(plaintextKey: string): Promise<{ valid: boolean; key?: ApiKey; error?: string }> {
    if (!plaintextKey.startsWith(KEY_PREFIX)) return { valid: false, error: 'Invalid key format' };
    const prefix = plaintextKey.slice(0, 8);
    const hashedKey = crypto.createHash('sha256').update(plaintextKey).digest('hex');

    const rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, prefix), eq(apiKeys.isActive, 1)));
    for (const row of rows) {
      if (crypto.timingSafeEqual(Buffer.from(row.hashedKey), Buffer.from(hashedKey))) {
        if (row.expiresAt && row.expiresAt.getTime() < Date.now())
          return { valid: false, error: 'API key expired' };
        await db
          .update(apiKeys)
          .set({ usageCount: sql`${apiKeys.usageCount} + 1`, lastUsedAt: new Date() })
          .where(eq(apiKeys.id, row.id));
        return { valid: true, key: this.rowToApiKey(row) };
      }
    }
    return { valid: false, error: 'Invalid API key' };
  }

  async listForUser(userId: string): Promise<ApiKey[]> {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(this.rowToApiKey);
  }

  hasScope(apiKey: ApiKey, requiredScope: ApiKeyScope): boolean {
    if (apiKey.scopes.includes('admin')) return true;
    if (apiKey.scopes.includes(requiredScope)) return true;
    if (requiredScope.includes(':')) {
      const [provider] = requiredScope.split(':');
      if (apiKey.scopes.includes(`${provider}:*`)) return true;
    }
    return false;
  }

  private rowToApiKey(row: any): ApiKey {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      prefix: row.prefix,
      hashedKey: row.hashedKey,
      scopes: JSON.parse(row.scopes),
      rateLimitTier: row.rateLimitTier,
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
      usageCount: row.usageCount,
      isActive: row.isActive === 1,
      createdAt: row.createdAt.getTime(),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}

let instance: ApiKeyService | null = null;
export function createApiKeyService(): ApiKeyService {
  if (!instance) instance = new ApiKeyService();
  return instance;
}
export function getApiKeyService(): ApiKeyService {
  return createApiKeyService();
}
