/**
 * API Key Authentication Integration Tests
 * 
 * Tests the complete API key lifecycle:
 * - Key generation
 * - Key validation
 * - Scope checking
 * - Revocation
 * - Expiration
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { createApiKeyService, ApiKeyService } from '../../src/apikeys/service';
import { initDb, getDb } from '../../src/db/sqlite';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('API Key Authentication', () => {
  let service: ApiKeyService;
  let testDir: string;
  let userId: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `koryphaios-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    initDb(testDir);
    service = createApiKeyService();
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    userId = `test_user_${Date.now()}`;
  });

  describe('create', () => {
    it('should create an API key with plaintext', async () => {
      const result = await service.create({
        userId,
        name: 'Test Key',
        scopes: ['read', 'write'],
      });

      expect(result.id).toBeDefined();
      expect(result.plaintextKey).toStartWith('kor_');
      expect(result.plaintextKey.length).toBeGreaterThan(20);
      expect(result.prefix).toBe(result.plaintextKey.slice(0, 8));
      expect(result.name).toBe('Test Key');
      expect(result.scopes).toEqual(['read', 'write']);
      expect(result.isActive).toBe(true);
    });

    it('should create key with expiration', async () => {
      const result = await service.create({
        userId,
        name: 'Expiring Key',
        expiresInDays: 30,
      });

      expect(result.expiresAt).toBeDefined();
      expect(result.expiresAt!).toBeGreaterThan(Date.now());
      expect(result.expiresAt!).toBeLessThan(Date.now() + 31 * 24 * 60 * 60 * 1000);
    });

    it('should create key with custom rate limit tier', async () => {
      const result = await service.create({
        userId,
        name: 'Premium Key',
        rateLimitTier: 'premium',
      });

      expect(result.rateLimitTier).toBe('premium');
    });
  });

  describe('validate', () => {
    it('should validate a valid key', async () => {
      const created = await service.create({
        userId,
        name: 'Valid Key',
      });

      const result = await service.validate(created.plaintextKey);

      expect(result.valid).toBe(true);
      expect(result.key).toBeDefined();
      expect(result.key!.id).toBe(created.id);
    });

    it('should reject invalid key format', async () => {
      const result = await service.validate('invalid_key');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid key format');
    });

    it('should reject non-existent key', async () => {
      const result = await service.validate('kor_' + 'a'.repeat(48));

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });

    it('should reject expired key', async () => {
      const created = await service.create({
        userId,
        name: 'Expired Key',
        expiresInDays: -1, // Already expired
      });

      const result = await service.validate(created.plaintextKey);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('API key expired');
    });

    it('should reject revoked key', async () => {
      const created = await service.create({
        userId,
        name: 'Revoked Key',
      });

      await service.revoke(userId, created.id);

      const result = await service.validate(created.plaintextKey);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });
  });

  describe('scopes', () => {
    it('should check read scope', async () => {
      const created = await service.create({
        userId,
        name: 'Read Only',
        scopes: ['read'],
      });

      expect(service.hasScope(created, 'read')).toBe(true);
      expect(service.hasScope(created, 'write')).toBe(false);
      expect(service.hasScope(created, 'admin')).toBe(false);
    });

    it('should check write scope (implies read)', async () => {
      const created = await service.create({
        userId,
        name: 'Write Key',
        scopes: ['write'],
      });

      expect(service.hasScope(created, 'read')).toBe(true); // write implies read
      expect(service.hasScope(created, 'write')).toBe(true);
      expect(service.hasScope(created, 'admin')).toBe(false);
    });

    it('should check admin scope (implies all)', async () => {
      const created = await service.create({
        userId,
        name: 'Admin Key',
        scopes: ['admin'],
      });

      expect(service.hasScope(created, 'read')).toBe(true);
      expect(service.hasScope(created, 'write')).toBe(true);
      expect(service.hasScope(created, 'admin')).toBe(true);
      expect(service.hasScope(created, 'custom:action')).toBe(true);
    });

    it('should check wildcard scopes', async () => {
      const created = await service.create({
        userId,
        name: 'Provider Key',
        scopes: ['provider:*'],
      });

      expect(service.hasScope(created, 'provider:openai')).toBe(true);
      expect(service.hasScope(created, 'provider:anthropic')).toBe(true);
      expect(service.hasScope(created, 'read')).toBe(false);
    });
  });

  describe('revoke', () => {
    it('should revoke a key', async () => {
      const created = await service.create({
        userId,
        name: 'To Revoke',
      });

      const result = await service.revoke(userId, created.id);

      expect(result).toBe(true);

      const key = await service.get(userId, created.id);
      expect(key!.isActive).toBe(false);
    });

    it('should return false for non-existent key', async () => {
      const result = await service.revoke(userId, 'non_existent');
      expect(result).toBe(false);
    });

    it('should not allow revoking other user\'s key', async () => {
      const created = await service.create({
        userId,
        name: 'Protected',
      });

      const result = await service.revoke('other_user', created.id);
      expect(result).toBe(false);
    });
  });

  describe('listForUser', () => {
    it('should list only user\'s keys', async () => {
      const otherUserId = `other_${Date.now()}`;
      
      await service.create({ userId, name: 'Key 1' });
      await service.create({ userId, name: 'Key 2' });
      await service.create({ userId: otherUserId, name: 'Other Key' });

      const keys = await service.listForUser(userId);

      expect(keys.length).toBe(2);
      expect(keys.every(k => k.userId === userId)).toBe(true);
    });

    it('should not include hashedKey in list', async () => {
      await service.create({ userId, name: 'Test' });

      const keys = await service.listForUser(userId);

      expect('hashedKey' in keys[0]).toBe(false);
    });
  });

  describe('usage tracking', () => {
    it('should track key usage', async () => {
      const created = await service.create({
        userId,
        name: 'Tracked Key',
      });

      expect(created.usageCount).toBe(0);
      expect(created.lastUsedAt).toBeNull();

      await service.validate(created.plaintextKey);

      const key = await service.get(userId, created.id);
      expect(key!.usageCount).toBe(1);
      expect(key!.lastUsedAt).not.toBeNull();
    });
  });
});
