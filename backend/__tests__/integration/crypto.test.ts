/**
 * Encryption Integration Tests
 * 
 * Tests envelope encryption and KMS providers:
 * - Local KMS provider
 * - Age KMS provider
 * - Per-user key derivation
 * - Envelope encryption/decryption
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { LocalKMSProvider, AgeKMSProvider } from '../../src/crypto/providers';
import { EnvelopeEncryption, createEnvelopeEncryption } from '../../src/crypto/envelope';
import { PerUserKeyDerivation } from '../../src/crypto/per-user';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Encryption', () => {
  describe('LocalKMSProvider', () => {
    let provider: LocalKMSProvider;
    let testDir: string;

    beforeAll(() => {
      testDir = join(tmpdir(), `koryphaios-crypto-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      provider = new LocalKMSProvider({
        dataDir: testDir,
        passphrase: 'test-passphrase',
        suppressWarning: true,
      });
    });

    afterAll(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should initialize and generate master key', async () => {
      await provider.initialize();
      expect(await provider.healthCheck()).toBe(true);
    });

    it('should generate DEK', async () => {
      const dek = await provider.generateDek();
      expect(dek.plaintext).toBeInstanceOf(Buffer);
      expect(dek.plaintext.length).toBe(32);
      expect(dek.encrypted).toBeDefined();
    });

    it('should decrypt DEK', async () => {
      const dek = await provider.generateDek();
      const decrypted = await provider.decryptDek(dek.encrypted);
      
      expect(decrypted.toString('hex')).toBe(dek.plaintext.toString('hex'));
    });

    it('should support per-user keys', async () => {
      expect(provider.supportsPerUserKeys()).toBe(true);

      const userId1 = 'user_1';
      const userId2 = 'user_2';

      const dek1 = await provider.generatePerUserDek!(userId1);
      const dek2 = await provider.generatePerUserDek!(userId2);
      const dek1Again = await provider.generatePerUserDek!(userId1);

      // Same user should get same key
      expect(dek1.plaintext.toString('hex')).toBe(dek1Again.plaintext.toString('hex'));

      // Different users should get different keys
      expect(dek1.plaintext.toString('hex')).not.toBe(dek2.plaintext.toString('hex'));
    });
  });

  describe('AgeKMSProvider', () => {
    let provider: AgeKMSProvider;
    let testDir: string;

    beforeAll(() => {
      testDir = join(tmpdir(), `koryphaios-age-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      provider = new AgeKMSProvider({
        dataDir: testDir,
        passphrase: 'test-passphrase',
      });
    });

    afterAll(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should initialize', async () => {
      await provider.initialize();
      expect(await provider.healthCheck()).toBe(true);
    });

    it('should generate and decrypt DEK', async () => {
      const dek = await provider.generateDek();
      const decrypted = await provider.decryptDek(dek.encrypted);
      
      expect(decrypted.toString('hex')).toBe(dek.plaintext.toString('hex'));
    });

    it('should generate per-user DEKs', async () => {
      const dek1 = await provider.generatePerUserDek!('user_1');
      const dek2 = await provider.generatePerUserDek!('user_2');

      expect(dek1.plaintext.toString('hex')).not.toBe(dek2.plaintext.toString('hex'));
    });
  });

  describe('EnvelopeEncryption', () => {
    let encryption: EnvelopeEncryption;
    let testDir: string;

    beforeAll(async () => {
      testDir = join(tmpdir(), `koryphaios-env-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      const provider = new LocalKMSProvider({
        dataDir: testDir,
        suppressWarning: true,
      });
      
      encryption = await createEnvelopeEncryption(provider);
    });

    afterAll(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should encrypt and decrypt data', async () => {
      const plaintext = 'Hello, World! This is a secret.';
      
      const envelope = await encryption.encrypt(plaintext);
      expect(envelope.version).toBe(1);
      expect(envelope.encryptedDek).toBeDefined();
      expect(envelope.encryptedData).toBeDefined();

      const result = await encryption.decrypt(envelope);
      expect(result.data).toBe(plaintext);
      expect(result.needsRotation).toBe(false);
    });

    it('should encrypt large data', async () => {
      const plaintext = 'x'.repeat(10000);
      
      const envelope = await encryption.encrypt(plaintext);
      const result = await encryption.decrypt(envelope);
      
      expect(result.data).toBe(plaintext);
    });

    it('should encrypt unicode data', async () => {
      const plaintext = 'Hello 世界 🌍 émojis!';
      
      const envelope = await encryption.encrypt(plaintext);
      const result = await encryption.decrypt(envelope);
      
      expect(result.data).toBe(plaintext);
    });

    it('should serialize and parse envelope', async () => {
      const plaintext = 'Test data';
      const envelope = await encryption.encrypt(plaintext);
      
      const serialized = encryption.serialize(envelope);
      const parsed = encryption.parse(serialized);
      
      const result = await encryption.decrypt(parsed);
      expect(result.data).toBe(plaintext);
    });

    it('should track audit logs', async () => {
      const plaintext = 'Audit test';
      
      await encryption.encrypt(plaintext);
      await encryption.decrypt(await encryption.encrypt(plaintext));
      
      const logs = encryption.getAuditLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some(l => l.operation === 'encrypt')).toBe(true);
      expect(logs.some(l => l.operation === 'decrypt')).toBe(true);
    });
  });

  describe('PerUserKeyDerivation', () => {
    let keyDerivation: PerUserKeyDerivation;
    let testDir: string;

    beforeAll(async () => {
      testDir = join(tmpdir(), `koryphaios-pukd-test-${Date.now()}`);
      mkdirSync(testDir, { recursive: true });
      
      const provider = new LocalKMSProvider({
        dataDir: testDir,
        suppressWarning: true,
      });
      
      await provider.initialize();
      keyDerivation = new PerUserKeyDerivation(provider);
    });

    afterAll(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    });

    it('should derive user-specific key', async () => {
      const userId = 'test_user_123';
      const key = await keyDerivation.deriveKey(userId);
      
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should derive deterministic keys', async () => {
      const userId = 'deterministic_user';
      
      const key1 = await keyDerivation.deriveKey(userId);
      const key2 = await keyDerivation.deriveKey(userId);
      
      expect(key1.toString('hex')).toBe(key2.toString('hex'));
    });

    it('should derive different keys for different users', async () => {
      const key1 = await keyDerivation.deriveKey('user_a');
      const key2 = await keyDerivation.deriveKey('user_b');
      
      expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
    });

    it('should derive keys with context', async () => {
      const userId = 'context_user';
      
      const key1 = await keyDerivation.deriveKey(userId, { purpose: 'encryption' });
      const key2 = await keyDerivation.deriveKey(userId, { purpose: 'signing' });
      
      expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
    });
  });
});
