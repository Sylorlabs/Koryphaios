// Crypto Module - Bun Native Implementation
// Uses WebCrypto API and Bun.password for optimal performance

export {
  SecureEncryption,
  SecureEncryptionError,
  secureEncryption,
  encryptForStorage,
  decryptFromStorage,
  isEncrypted,
  generateMasterKey,
  hashCredential,
  verifyCredential,
  type EncryptedEnvelope,
} from "./secure-encryption";
