/**
 * Credentials Service Integration Tests
 * 
 * Tests encrypted credential storage:
 * - Store and retrieve credentials
 * - Per-user encryption isolation
 * - Audit logging
 * - Key rotation
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { createUserCredentialsService, UserCredentialsService } from '../../src/services/user-credentials';
import { createAuditLogService } from '../../src/services/audit';
import { initDb, getDb } from '../../src/db/sqlite';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Credentials Service', () => {
  let service: UserCredentialsService;
  let testDir: string;
  let userId: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `koryphaios-creds-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    initDb(testDir);
    service = createUserCredentialsService();
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    userId = `user_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  });

  describe('create', () => {
    it('should store credential and return ID', async () => {
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test123',
        metadata: { name: 'Test Key' },
      });

      expect(id).toBeDefined();
      expect(id).toStartWith('cred_');
    });

    it('should encrypt credential (cannot be read back as plaintext from DB)', async () => {
      const credential = 'sk-secret123';
      
      await service.create({
        userId,
        provider: 'openai',
        credential,
        metadata: {},
      });

      // Direct DB query should show encrypted data
      const db = getDb();
      const row = db.prepare(
        'SELECT encrypted_credential FROM user_credentials WHERE user_id = ?'
      ).get(userId) as any;

      expect(row.encrypted_credential).toBeDefined();
      expect(row.encrypted_credential).not.toContain(credential);
      expect(row.encrypted_credential).toContain('"ciphertext"'); // JSON envelope
    });

    it('should store metadata', async () => {
      const metadata = { name: 'Production Key', env: 'prod' };
      
      const id = await service.create({
        userId,
        provider: 'anthropic',
        credential: 'sk-ant-123',
        metadata,
      });

      const cred = await service.getMetadata(userId, id);
      expect(cred.metadata).toEqual(metadata);
    });
  });

  describe('get', () => {
    it('should retrieve and decrypt credential', async () => {
      const originalCredential = 'sk-test-secret';
      
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: originalCredential,
        metadata: {},
      });

      const decrypted = await service.get(userId, id, 'test_retrieval');
      expect(decrypted).toBe(originalCredential);
    });

    it('should return null for non-existent credential', async () => {
      const result = await service.get(userId, 'non_existent', 'test');
      expect(result).toBeNull();
    });

    it('should not allow accessing other user\'s credential', async () => {
      const otherUserId = `other_${Date.now()}`;
      const credential = 'sk-secret';
      
      const id = await service.create({
        userId,
        provider: 'openai',
        credential,
        metadata: {},
      });

      const result = await service.get(otherUserId, id, 'unauthorized_attempt');
      expect(result).toBeNull();
    });
  });

  describe('getMetadata', () => {
    it('should return metadata without credential', async () => {
      const metadata = { name: 'My Key', note: 'Important' };
      
      const id = await service.create({
        userId,
        provider: 'groq',
        credential: 'gsk-test',
        metadata,
      });

      const cred = await service.getMetadata(userId, id);

      expect(cred.id).toBe(id);
      expect(cred.provider).toBe('groq');
      expect(cred.metadata).toEqual(metadata);
      expect('credential' in cred).toBe(false); // Should not contain credential
    });

    it('should return null for deleted credential', async () => {
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: {},
      });

      await service.delete(userId, id);

      const result = await service.getMetadata(userId, id);
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('should list only user\'s credentials', async () => {
      const otherUserId = `other_${Date.now()}`;
      
      await service.create({ userId, provider: 'openai', credential: 'sk-1', metadata: {} });
      await service.create({ userId, provider: 'anthropic', credential: 'sk-2', metadata: {} });
      await service.create({ userId: otherUserId, provider: 'groq', credential: 'sk-3', metadata: {} });

      const credentials = await service.list(userId);

      expect(credentials.length).toBe(2);
      expect(credentials.every(c => c.userId === userId)).toBe(true);
    });

    it('should filter by provider', async () => {
      await service.create({ userId, provider: 'openai', credential: 'sk-1', metadata: {} });
      await service.create({ userId, provider: 'openai', credential: 'sk-2', metadata: {} });
      await service.create({ userId, provider: 'anthropic', credential: 'sk-3', metadata: {} });

      const openaiCreds = await service.list(userId, { provider: 'openai' });

      expect(openaiCreds.length).toBe(2);
      expect(openaiCreds.every(c => c.provider === 'openai')).toBe(true);
    });

    it('should filter by active status', async () => {
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: {},
      });

      await service.delete(userId, id);

      const activeCreds = await service.list(userId, { isActive: true });
      expect(activeCreds.length).toBe(0);

      const allCreds = await service.list(userId, { isActive: false });
      expect(allCreds.length).toBe(1);
    });
  });

  describe('delete', () => {
    it('should soft delete credential', async () => {
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: {},
      });

      const result = await service.delete(userId, id);
      expect(result).toBe(true);

      // Should not be retrievable
      const cred = await service.get(userId, id, 'test');
      expect(cred).toBeNull();
    });

    it('should return false for non-existent credential', async () => {
      const result = await service.delete(userId, 'non_existent');
      expect(result).toBe(false);
    });

    it('should not allow deleting other user\'s credential', async () => {
      const otherUserId = `other_${Date.now()}`;
      
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: {},
      });

      const result = await service.delete(otherUserId, id);
      expect(result).toBe(false);

      // Credential should still exist
      const cred = await service.get(userId, id, 'test');
      expect(cred).not.toBeNull();
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata', async () => {
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: { name: 'Old Name' },
      });

      const result = await service.updateMetadata(userId, id, { name: 'New Name' });
      expect(result).toBe(true);

      const cred = await service.getMetadata(userId, id);
      expect(cred.metadata.name).toBe('New Name');
    });
  });

  describe('rotate', () => {
    it('should rotate credential encryption', async () => {
      const originalCredential = 'sk-secret123';
      
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: originalCredential,
        metadata: {},
      });

      const newId = await service.rotate(userId, id);

      expect(newId).toBeDefined();
      expect(newId).not.toBe(id);

      // Old credential should be deleted
      const oldCred = await service.get(userId, id, 'test');
      expect(oldCred).toBeNull();

      // New credential should work
      const newCred = await service.get(userId, newId!, 'test');
      expect(newCred).toBe(originalCredential);
    });
  });

  describe('audit logging', () => {
    it('should log credential access', async () => {
      const auditService = createAuditLogService();
      
      const id = await service.create({
        userId,
        provider: 'openai',
        credential: 'sk-test',
        metadata: {},
      });

      // Access the credential
      await service.get(userId, id, 'chat_completion');

      // Check audit log
      const auditTrail = await auditService.getCredentialAccessHistory(id);
      
      expect(auditTrail.length).toBeGreaterThan(0);
      expect(auditTrail[0].action).toBe('credential_access');
      expect(auditTrail[0].resourceId).toBe(id);
      expect(auditTrail[0].reason).toBe('chat_completion');
    });
  });
});
