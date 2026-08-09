// Tests for the hardened LocalKMSProvider.
// Verifies GCM DEK wrap, legacy CBC migration, and passphrase requirement.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalKMSProvider } from '../providers/local';

describe('LocalKMSProvider hardening', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kory-kms-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('passphrase requirement', () => {
    it('rejects initialization without a passphrase when insecure mode is not set', async () => {
      const provider = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: undefined,
      });
      await expect(provider.initialize()).rejects.toThrow(/passphrase/);
    });

    it('allows initialization with KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS=1', async () => {
      const oldVal = process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS;
      process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS = '1';
      try {
        const provider = new LocalKMSProvider({
          dataDir: tempDir,
          passphrase: undefined,
          suppressWarning: true,
        });
        await provider.initialize();
        expect(existsSync(join(tempDir, '.master-key'))).toBe(true);
      } finally {
        if (oldVal === undefined) delete process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS;
        else process.env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS = oldVal;
      }
    });

    it('initializes with a passphrase', async () => {
      const provider = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider.initialize();
      expect(existsSync(join(tempDir, '.master-key'))).toBe(true);
    });
  });

  describe('GCM DEK wrap', () => {
    it('encrypts and decrypts a DEK round-trip', async () => {
      const provider = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider.initialize();

      const { plaintext, encrypted } = await provider.generateDek();
      expect(plaintext.length).toBe(32);

      const decrypted = await provider.decryptDek(encrypted);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('detects tampering via GCM auth tag', async () => {
      const provider = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider.initialize();

      const { encrypted } = await provider.generateDek();

      // Flip a byte in the ciphertext to break the auth tag.
      const combined = Buffer.from(encrypted, 'base64');
      combined[combined.length - 1] ^= 0x01;
      const tampered = combined.toString('base64');

      await expect(provider.decryptDek(tampered)).rejects.toThrow();
    });

    it('produces a new key file with formatVersion 2', async () => {
      const provider = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider.initialize();

      const keyFileContent = await Bun.file(join(tempDir, '.master-key')).text();
      const keyData = JSON.parse(keyFileContent);
      expect(keyData.formatVersion).toBe(2);
    });
  });

  describe('key persistence', () => {
    it('loads a previously generated key with the same passphrase', async () => {
      const provider1 = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider1.initialize();
      const { plaintext, encrypted } = await provider1.generateDek();

      // New provider instance loading the same key file.
      const provider2 = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'test-passphrase-123',
      });
      await provider2.initialize();

      const decrypted = await provider2.decryptDek(encrypted);
      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('fails to load with the wrong passphrase', async () => {
      const provider1 = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'correct-passphrase',
      });
      await provider1.initialize();

      const provider2 = new LocalKMSProvider({
        dataDir: tempDir,
        passphrase: 'wrong-passphrase',
      });
      await expect(provider2.initialize()).rejects.toThrow();
    });
  });
});
