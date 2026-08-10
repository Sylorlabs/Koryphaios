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
import type { CredentialEncryption, UserCredentialsService } from '../../services/user-credentials';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const isolatedTestDir = mkdtempSync(join(tmpdir(), 'koryphaios-creds-test-'));
process.env.DATABASE_URL = `sqlite://${join(isolatedTestDir, 'credentials.sqlite')}`;
process.env.KORYPHAIOS_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.KORYPHAIOS_DATA_DIR = join(isolatedTestDir, 'kms');
process.env.KORYPHAIOS_KMS_PASSPHRASE =
  'credential-envelope-test-passphrase-that-is-not-used-outside-this-test';

const { UserCredentialsService } = await import('../user-credentials');
const { createAuditLogService } = await import('../audit');
const { initializeEncryption } = await import('../../security');
const { initDb, getDb, db, users, userCredentials } = await import('../../db');

function legacyXor(plaintext: string, masterKey = 'dev-key'): string {
  const keyBytes = Buffer.from(masterKey.slice(0, 32), 'utf8');
  const plaintextBytes = Buffer.from(plaintext, 'utf8');
  const encrypted = Buffer.alloc(plaintextBytes.length);
  for (let i = 0; i < plaintextBytes.length; i++) {
    encrypted[i] = plaintextBytes[i] ^ keyBytes[i % keyBytes.length];
  }
  return encrypted.toString('base64');
}

describe('Credentials Service', () => {
  let service: UserCredentialsService;
  let testDir: string;
  let userId: string;

  beforeAll(async () => {
    testDir = isolatedTestDir;
    initDb();
    await initializeEncryption();
    service = new UserCredentialsService();
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors in test teardown */
    }
  });

  beforeEach(async () => {
    userId = `user_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await db.insert(users).values({
      id: userId,
      username: userId,
      passwordHash: 'test-only',
    });
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
      const row = db
        .prepare('SELECT encrypted_credential FROM user_credentials WHERE user_id = ?')
        .get(userId) as any;

      expect(row.encrypted_credential).toBeDefined();
      expect(row.encrypted_credential).not.toContain(credential);
      expect(row.encrypted_credential).toStartWith('env:');
      expect(JSON.parse(row.encrypted_credential.slice(4)).algorithm).toBe('aes-256-gcm');
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

    it("should not allow accessing other user's credential", async () => {
      const otherUserId = `other_${Date.now()}`;
      await db.insert(users).values({
        id: otherUserId,
        username: otherUserId,
        passwordHash: 'test-only',
      });
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

    it('migrates a legacy credential written with the historical default key', async () => {
      const credentialId = `legacy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const plaintext = 'sk-legacy-default-key-test';
      const legacyValue = legacyXor(plaintext);
      await db.insert(userCredentials).values({
        id: credentialId,
        userId,
        provider: 'openai',
        encryptedCredential: legacyValue,
        type: 'apiKey',
        isActive: 1,
        createdAt: new Date(),
      });

      const originalMasterKey = process.env.KORYPHAIOS_MASTER_KEY;
      delete process.env.KORYPHAIOS_MASTER_KEY;
      try {
        const result = await service.getCredential(credentialId);
        expect(result?.plaintext).toBe(plaintext);
      } finally {
        process.env.KORYPHAIOS_MASTER_KEY = originalMasterKey;
      }

      const row = getDb()
        .prepare('SELECT encrypted_credential FROM user_credentials WHERE id = ?')
        .get(credentialId) as { encrypted_credential: string };
      expect(row.encrypted_credential).toStartWith('env:');
      expect(row.encrypted_credential).not.toBe(legacyValue);

      const secondRead = await service.getCredential(credentialId);
      expect(secondRead?.plaintext).toBe(plaintext);
    });

    it('fails closed when an authenticated envelope is tampered with', async () => {
      const id = await service.create({
        userId,
        provider: 'anthropic',
        credential: 'sk-ant-tamper-test',
        metadata: {},
      });
      const sqlite = getDb();
      const row = sqlite
        .prepare('SELECT encrypted_credential FROM user_credentials WHERE id = ?')
        .get(id) as { encrypted_credential: string };
      const envelope = JSON.parse(row.encrypted_credential.slice(4));
      const encryptedData = Buffer.from(envelope.encryptedData, 'base64');
      encryptedData[encryptedData.length - 1] ^= 1;
      envelope.encryptedData = encryptedData.toString('base64');
      sqlite
        .prepare('UPDATE user_credentials SET encrypted_credential = ? WHERE id = ?')
        .run(`env:${JSON.stringify(envelope)}`, id);

      await expect(service.getCredential(id)).rejects.toThrow(/Decryption failed/i);
      expect(await service.get(userId, id, 'tamper-test')).toBeNull();
    });

    it('does not return or rewrite a legacy credential when envelope encryption is unavailable', async () => {
      const credentialId = `legacy_unavailable_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const legacyValue = legacyXor('sk-legacy-must-not-leak');
      await db.insert(userCredentials).values({
        id: credentialId,
        userId,
        provider: 'openai',
        encryptedCredential: legacyValue,
        type: 'apiKey',
        isActive: 1,
        createdAt: new Date(),
      });
      const unavailableEncryption: CredentialEncryption = {
        async encrypt() {
          throw new Error('KMS unavailable');
        },
        async decryptEnvelope() {
          throw new Error('KMS unavailable');
        },
      };
      const unavailableService = new UserCredentialsService(unavailableEncryption);

      const originalMasterKey = process.env.KORYPHAIOS_MASTER_KEY;
      delete process.env.KORYPHAIOS_MASTER_KEY;
      try {
        await expect(unavailableService.getCredential(credentialId)).rejects.toThrow(
          'KMS unavailable',
        );
        expect(await unavailableService.get(userId, credentialId, 'unavailable-test')).toBeNull();
      } finally {
        process.env.KORYPHAIOS_MASTER_KEY = originalMasterKey;
      }

      const row = getDb()
        .prepare('SELECT encrypted_credential FROM user_credentials WHERE id = ?')
        .get(credentialId) as { encrypted_credential: string };
      expect(row.encrypted_credential).toBe(legacyValue);
    });

    it('keeps the legacy row recoverable when a new envelope cannot be verified', async () => {
      const credentialId = `legacy_unverified_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const legacyValue = legacyXor('sk-legacy-round-trip-check');
      await db.insert(userCredentials).values({
        id: credentialId,
        userId,
        provider: 'openai',
        encryptedCredential: legacyValue,
        type: 'apiKey',
        isActive: 1,
        createdAt: new Date(),
      });
      const invalidEnvelopeEncryption: CredentialEncryption = {
        async encrypt() {
          return 'env:not-a-readable-envelope';
        },
        async decryptEnvelope() {
          throw new Error('Envelope verification unavailable');
        },
      };
      const migrationService = new UserCredentialsService(invalidEnvelopeEncryption);

      const originalMasterKey = process.env.KORYPHAIOS_MASTER_KEY;
      delete process.env.KORYPHAIOS_MASTER_KEY;
      try {
        await expect(migrationService.getCredential(credentialId)).rejects.toThrow(
          'Envelope verification unavailable',
        );
      } finally {
        process.env.KORYPHAIOS_MASTER_KEY = originalMasterKey;
      }

      const row = getDb()
        .prepare('SELECT encrypted_credential FROM user_credentials WHERE id = ?')
        .get(credentialId) as { encrypted_credential: string };
      expect(row.encrypted_credential).toBe(legacyValue);
    });

    it('does not store a credential when envelope encryption is unavailable', async () => {
      const unavailableEncryption: CredentialEncryption = {
        async encrypt() {
          throw new Error('KMS unavailable');
        },
        async decryptEnvelope() {
          throw new Error('KMS unavailable');
        },
      };
      const unavailableService = new UserCredentialsService(unavailableEncryption);

      await expect(
        unavailableService.create({
          userId,
          provider: 'openai',
          credential: 'sk-never-persisted',
        }),
      ).rejects.toThrow('KMS unavailable');

      const row = getDb()
        .prepare(
          'SELECT COUNT(*) AS count FROM user_credentials WHERE user_id = ? AND provider = ?',
        )
        .get(userId, 'openai') as { count: number };
      expect(row.count).toBe(0);
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
    it("should list only user's credentials", async () => {
      const otherUserId = `other_${Date.now()}`;
      await db.insert(users).values({
        id: otherUserId,
        username: otherUserId,
        passwordHash: 'test-only',
      });

      await service.create({ userId, provider: 'openai', credential: 'sk-1', metadata: {} });
      await service.create({ userId, provider: 'anthropic', credential: 'sk-2', metadata: {} });
      await service.create({
        userId: otherUserId,
        provider: 'groq',
        credential: 'sk-3',
        metadata: {},
      });

      const credentials = await service.list(userId);

      expect(credentials.length).toBe(2);
      expect(credentials.every((c) => c.userId === userId)).toBe(true);
    });

    it('should filter by provider', async () => {
      await service.create({ userId, provider: 'openai', credential: 'sk-1', metadata: {} });
      await service.create({ userId, provider: 'openai', credential: 'sk-2', metadata: {} });
      await service.create({ userId, provider: 'anthropic', credential: 'sk-3', metadata: {} });

      const openaiCreds = await service.list(userId, { provider: 'openai' });

      expect(openaiCreds.length).toBe(2);
      expect(openaiCreds.every((c) => c.provider === 'openai')).toBe(true);
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

    it("should not allow deleting other user's credential", async () => {
      const otherUserId = `other_${Date.now()}`;
      await db.insert(users).values({
        id: otherUserId,
        username: otherUserId,
        passwordHash: 'test-only',
      });

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
