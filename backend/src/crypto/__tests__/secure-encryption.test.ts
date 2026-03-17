// Secure Encryption Tests - Bun Native WebCrypto
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  SecureEncryption,
  SecureEncryptionError,
  encryptForStorage,
  decryptFromStorage,
  isEncrypted,
  generateMasterKey,
  hashCredential,
  verifyCredential,
} from "../secure-encryption";

describe("SecureEncryption (Bun Native)", () => {
  let encryption: SecureEncryption;
  const originalEnv = process.env.KORYPHAIOS_MASTER_KEY;

  beforeEach(() => {
    // Set a test key
    process.env.KORYPHAIOS_MASTER_KEY = "test-master-key-for-encryption-32-chars-long!!";
    encryption = new SecureEncryption();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.KORYPHAIOS_MASTER_KEY = originalEnv;
    } else {
      delete process.env.KORYPHAIOS_MASTER_KEY;
    }
  });

  describe("initialization", () => {
    it("should initialize with environment key", async () => {
      await encryption.initialize();
      expect(encryption.getStatus().initialized).toBe(true);
      expect(encryption.getStatus().secure).toBe(true);
    });

    it("should throw in production without key", async () => {
      delete process.env.KORYPHAIOS_MASTER_KEY;
      const prodEncryption = new SecureEncryption();
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      try {
        expect(async () => {
          await prodEncryption.initialize();
        }).toThrow(SecureEncryptionError);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it("should auto-initialize on first encrypt", async () => {
      const result = await encryption.encrypt("test");
      expect(result).toBeDefined();
      expect(encryption.getStatus().initialized).toBe(true);
    });
  });

  describe("encrypt/decrypt", () => {
    beforeEach(async () => {
      await encryption.initialize();
    });

    it("should encrypt plaintext", async () => {
      const result = await encryption.encrypt("my-api-key-12345");
      
      expect(result.version).toBe("v2");
      expect(result.ciphertext).toBeDefined();
      expect(result.iv).toBeDefined();
      expect(result.salt).toBeDefined();
      expect(result.ciphertext).not.toBe("my-api-key-12345");
    });

    it("should decrypt to original value", async () => {
      const original = "sk-anthropic-api-key-123456789";
      const encrypted = await encryption.encrypt(original);
      const decrypted = await encryption.decrypt(encrypted);
      
      expect(decrypted).toBe(original);
    });

    it("should produce different ciphertexts for same plaintext", async () => {
      const plaintext = "same-text";
      const encrypted1 = await encryption.encrypt(plaintext);
      const encrypted2 = await encryption.encrypt(plaintext);
      
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it("should reject wrong version", async () => {
      const envelope = {
        version: "v1",
        ciphertext: "abc",
        iv: "def",
        salt: "ghi",
      };

      expect(async () => {
        await encryption.decrypt(envelope);
      }).toThrow(SecureEncryptionError);
    });

    it("should handle unicode characters", async () => {
      const original = "🔑 API Key: 日本語テスト 🚀";
      const encrypted = await encryption.encrypt(original);
      const decrypted = await encryption.decrypt(encrypted);
      
      expect(decrypted).toBe(original);
    });

    it("should handle long credentials", async () => {
      const original = "sk-" + "a".repeat(1000);
      const encrypted = await encryption.encrypt(original);
      const decrypted = await encryption.decrypt(encrypted);
      
      expect(decrypted).toBe(original);
    });
  });

  describe("serialization", () => {
    beforeEach(async () => {
      await encryption.initialize();
    });

    it("should serialize to v2 format", async () => {
      const envelope = await encryption.encrypt("test");
      const serialized = encryption.serialize(envelope);
      
      expect(serialized.startsWith("v2:")).toBe(true);
    });

    it("should parse serialized envelope", async () => {
      const original = "test-data";
      const envelope = await encryption.encrypt(original);
      const serialized = encryption.serialize(envelope);
      const parsed = encryption.parse(serialized);
      
      expect(parsed.version).toBe("v2");
      expect(parsed.ciphertext).toBe(envelope.ciphertext);
    });

    it("should reject invalid format", () => {
      expect(() => {
        encryption.parse("invalid-format");
      }).toThrow(SecureEncryptionError);
    });

    it("should reject wrong version prefix", () => {
      expect(() => {
        encryption.parse("v1:abc123");
      }).toThrow(SecureEncryptionError);
    });
  });

  describe("convenience functions", () => {
    it("should encrypt for storage", async () => {
      const result = await encryptForStorage("my-secret");
      expect(result.startsWith("v2:")).toBe(true);
      expect(isEncrypted(result)).toBe(true);
    });

    it("should decrypt from storage", async () => {
      const original = "my-api-key";
      const stored = await encryptForStorage(original);
      const decrypted = await decryptFromStorage(stored);
      
      expect(decrypted).toBe(original);
    });

    it("should detect encrypted values", () => {
      expect(isEncrypted("v2:abc123")).toBe(true);
      expect(isEncrypted("plaintext")).toBe(false);
      expect(isEncrypted("env:old-format")).toBe(false);
    });

    it("should generate master key", () => {
      const key = generateMasterKey();
      expect(key).toBeDefined();
      expect(key.length).toBeGreaterThan(20);
    });
  });

  describe("Bun.password integration", () => {
    it("should hash credential using Bun.password", async () => {
      const credential = "my-password-123";
      const hash = await hashCredential(credential);
      
      expect(hash).toBeDefined();
      expect(hash.startsWith("$argon2id$")).toBe(true);
    });

    it("should verify correct credential", async () => {
      const credential = "my-password-123";
      const hash = await hashCredential(credential);
      
      const isValid = await verifyCredential(credential, hash);
      expect(isValid).toBe(true);
    });

    it("should reject wrong credential", async () => {
      const credential = "my-password-123";
      const hash = await hashCredential(credential);
      
      const isValid = await verifyCredential("wrong-password", hash);
      expect(isValid).toBe(false);
    });

    it("should produce different hashes for same credential", async () => {
      const credential = "my-password";
      const hash1 = await hashCredential(credential);
      const hash2 = await hashCredential(credential);
      
      expect(hash1).not.toBe(hash2); // Different salts
      
      // But both should verify
      expect(await verifyCredential(credential, hash1)).toBe(true);
      expect(await verifyCredential(credential, hash2)).toBe(true);
    });
  });
});
