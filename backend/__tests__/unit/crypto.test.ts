/**
 * Unit Tests: Cryptographic Functions
 */

import { describe, it, expect } from 'bun:test';
import crypto from 'crypto';

describe('Cryptographic Utilities', () => {
  describe('Key Derivation', () => {
    it('should derive consistent keys from same input', () => {
      const masterKey = crypto.randomBytes(32);
      const userId = 'user_123';
      
      const key1 = crypto.createHmac('sha256', masterKey).update(userId).digest();
      const key2 = crypto.createHmac('sha256', masterKey).update(userId).digest();
      
      expect(key1.toString('hex')).toBe(key2.toString('hex'));
    });
    
    it('should derive different keys for different users', () => {
      const masterKey = crypto.randomBytes(32);
      
      const key1 = crypto.createHmac('sha256', masterKey).update('user_1').digest();
      const key2 = crypto.createHmac('sha256', masterKey).update('user_2').digest();
      
      expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
    });
    
    it('should derive 32-byte keys', () => {
      const masterKey = crypto.randomBytes(32);
      const userId = 'user_123';
      
      const key = crypto.createHmac('sha256', masterKey).update(userId).digest();
      
      expect(key.length).toBe(32);
    });
  });
  
  describe('AES-256-GCM Encryption', () => {
    it('should encrypt and decrypt data', () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const plaintext = 'Hello, World!';
      
      // Encrypt
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      const authTag = cipher.getAuthTag();
      
      // Decrypt
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      expect(decrypted.toString('utf8')).toBe(plaintext);
    });
    
    it('should fail with wrong auth tag', () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const plaintext = 'Hello, World!';
      
      // Encrypt
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(plaintext, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      // Wrong auth tag
      const wrongAuthTag = crypto.randomBytes(16);
      
      // Decrypt should fail
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(wrongAuthTag);
      
      expect(() => {
        decipher.update(encrypted);
        decipher.final();
      }).toThrow();
    });
    
    it('should encrypt different ciphertexts with different IVs', () => {
      const key = crypto.randomBytes(32);
      const plaintext = 'Hello, World!';
      
      const iv1 = crypto.randomBytes(12);
      const iv2 = crypto.randomBytes(12);
      
      const cipher1 = crypto.createCipheriv('aes-256-gcm', key, iv1);
      const encrypted1 = Buffer.concat([
        cipher1.update(plaintext, 'utf8'),
        cipher1.final(),
      ]);
      
      const cipher2 = crypto.createCipheriv('aes-256-gcm', key, iv2);
      const encrypted2 = Buffer.concat([
        cipher2.update(plaintext, 'utf8'),
        cipher2.final(),
      ]);
      
      expect(encrypted1.toString('hex')).not.toBe(encrypted2.toString('hex'));
    });
  });
  
  describe('SHA-256 Hashing', () => {
    it('should produce consistent hashes', () => {
      const data = 'test data';
      
      const hash1 = crypto.createHash('sha256').update(data).digest('hex');
      const hash2 = crypto.createHash('sha256').update(data).digest('hex');
      
      expect(hash1).toBe(hash2);
    });
    
    it('should produce different hashes for different data', () => {
      const hash1 = crypto.createHash('sha256').update('data1').digest('hex');
      const hash2 = crypto.createHash('sha256').update('data2').digest('hex');
      
      expect(hash1).not.toBe(hash2);
    });
    
    it('should produce 64 character hex strings', () => {
      const hash = crypto.createHash('sha256').update('test').digest('hex');
      
      expect(hash.length).toBe(64);
    });
  });
  
  describe('Timing-Safe Comparison', () => {
    it('should match equal buffers', () => {
      const buf1 = Buffer.from('secret');
      const buf2 = Buffer.from('secret');
      
      expect(crypto.timingSafeEqual(buf1, buf2)).toBe(true);
    });
    
    it('should not match different buffers', () => {
      const buf1 = Buffer.from('secret1');
      const buf2 = Buffer.from('secret2');
      
      expect(crypto.timingSafeEqual(buf1, buf2)).toBe(false);
    });
    
    it('should throw for different length buffers', () => {
      const buf1 = Buffer.from('short');
      const buf2 = Buffer.from('longer string');
      
      expect(() => crypto.timingSafeEqual(buf1, buf2)).toThrow();
    });
  });
});
