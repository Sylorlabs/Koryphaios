// User Credentials Service
// Securely stores and manages user API keys and tokens
// Uses per-user encryption for isolation

import { serverLog } from '../logger';
import type { PerUserKeyDerivation } from '../crypto/per-user';
import { getDb } from '../db/sqlite';

export interface UserCredential {
  id: string;
  userId: string;
  provider: string;
  /** Encrypted credential value */
  encryptedValue: string;
  /** Type of credential: 'apiKey' | 'authToken' | 'baseUrl' */
  type: 'apiKey' | 'authToken' | 'baseUrl';
  /** Whether this credential is active */
  isActive: boolean;
  /** When the credential was added */
  createdAt: number;
  /** When the credential was last updated */
  updatedAt?: number;
  /** When the credential was last used */
  lastUsedAt?: number;
  /** When the credential expires (optional) */
  expiresAt?: number;
  /** Metadata (key ID, etc.) */
  metadata?: string;
}

export interface CredentialAuditLog {
  id: string;
  credentialId: string;
  userId: string;
  action: 'created' | 'accessed' | 'rotated' | 'revoked' | 'deleted';
  timestamp: number;
  ip?: string;
  userAgent?: string;
  success: boolean;
  error?: string;
}

export interface CreateCredentialInput {
  userId: string;
  provider: string;
  value: string;
  type: 'apiKey' | 'authToken' | 'baseUrl';
  expiresAt?: number;
}

export interface CredentialWithPlaintext extends UserCredential {
  plaintext: string;
}

/**
 * User Credentials Service
 * 
 * Security features:
 * - Per-user encryption isolation
 * - Audit logging of all access
 * - Automatic credential rotation support
 * - Soft delete (revoke) with audit trail
 * - Expiration tracking
 */
export class UserCredentialsService {
  private encryption: PerUserKeyDerivation;
  private db: any;

  constructor(encryption: PerUserKeyDerivation, db: any) {
    this.encryption = encryption;
    this.db = db;
  }

  /**
   * Initialize database tables
   */
  async initialize(): Promise<void> {
    // Create user_credentials table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('apiKey', 'authToken', 'baseUrl')),
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        metadata TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create credential_audit_log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_audit_log (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT,
        success INTEGER NOT NULL,
        error TEXT,
        FOREIGN KEY(credential_id) REFERENCES user_credentials(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_creds_user ON user_credentials(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_creds_provider ON user_credentials(user_id, provider)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_creds_active ON user_credentials(user_id, is_active)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_credential ON credential_audit_log(credential_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user ON credential_audit_log(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON credential_audit_log(timestamp)`);

    serverLog.info('User credentials service initialized');
  }

  /**
   * Store a new credential for a user
   */
  async createCredential(
    input: CreateCredentialInput,
    context?: { ip?: string; userAgent?: string }
  ): Promise<UserCredential> {
    const id = this.generateId();
    const now = Date.now();

    try {
      // Encrypt the credential with per-user encryption
      const encryptedValue = await this.encryption.encryptForUser(input.userId, input.value);

      const credential: UserCredential = {
        id,
        userId: input.userId,
        provider: input.provider,
        encryptedValue,
        type: input.type,
        isActive: true,
        createdAt: now,
        expiresAt: input.expiresAt,
      };

      // Store in database
      this.db.run(
        `INSERT INTO user_credentials 
         (id, user_id, provider, encrypted_value, type, is_active, created_at, expires_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          credential.id,
          credential.userId,
          credential.provider,
          credential.encryptedValue,
          credential.type,
          credential.isActive ? 1 : 0,
          credential.createdAt,
          credential.expiresAt || null,
        ]
      );

      // Audit log
      await this.logAccess({
        id: this.generateId(),
        credentialId: credential.id,
        userId: input.userId,
        action: 'created',
        timestamp: now,
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: true,
      });

      serverLog.info({ userId: input.userId, provider: input.provider }, 'Credential created');
      
      // Return without the value
      return credential;
    } catch (error: any) {
      await this.logAccess({
        id: this.generateId(),
        credentialId: id,
        userId: input.userId,
        action: 'created',
        timestamp: now,
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: false,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Retrieve and decrypt a credential
   * This is the sensitive operation - always logged
   */
  async getCredential(
    credentialId: string,
    context?: { ip?: string; userAgent?: string }
  ): Promise<CredentialWithPlaintext | null> {
    const now = Date.now();

    try {
      // Get from database
      const row = this.db
        .query('SELECT * FROM user_credentials WHERE id = ? AND is_active = 1')
        .get(credentialId) as any;

      if (!row) {
        return null;
      }

      const credential: UserCredential = this.rowToCredential(row);

      // Check expiration
      if (credential.expiresAt && credential.expiresAt < now) {
        await this.logAccess({
          id: this.generateId(),
          credentialId,
          userId: credential.userId,
          action: 'accessed',
          timestamp: now,
          ip: context?.ip,
          userAgent: context?.userAgent,
          success: false,
          error: 'Credential expired',
        });
        throw new Error('Credential has expired');
      }

      // Decrypt the value
      const plaintext = await this.encryption.decryptForUser(
        credential.userId,
        credential.encryptedValue
      );

      // Update last used
      this.db.run(
        'UPDATE user_credentials SET last_used_at = ? WHERE id = ?',
        [now, credentialId]
      );

      // Audit log
      await this.logAccess({
        id: this.generateId(),
        credentialId,
        userId: credential.userId,
        action: 'accessed',
        timestamp: now,
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: true,
      });

      return { ...credential, plaintext };
    } catch (error: any) {
      await this.logAccess({
        id: this.generateId(),
        credentialId,
        userId: 'unknown',
        action: 'accessed',
        timestamp: now,
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: false,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get all credentials for a user (without plaintext)
   */
  async getUserCredentials(userId: string): Promise<UserCredential[]> {
    const rows = this.db
      .query('SELECT * FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as any[];

    return rows.map(this.rowToCredential);
  }

  /**
   * Get active credential for a user + provider
   */
  async getActiveCredential(
    userId: string,
    provider: string
  ): Promise<UserCredential | null> {
    const now = Date.now();
    
    const row = this.db
      .query('SELECT * FROM user_credentials WHERE user_id = ? AND provider = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1')
      .get(userId, provider) as any;

    if (!row) return null;

    const credential = this.rowToCredential(row);

    // Check expiration
    if (credential.expiresAt && credential.expiresAt < now) {
      return null;
    }

    return credential;
  }

  /**
   * Rotate a credential (create new, revoke old)
   */
  async rotateCredential(
    credentialId: string,
    newValue: string,
    context?: { ip?: string; userAgent?: string }
  ): Promise<UserCredential> {
    const oldCred = await this.getCredential(credentialId, context);
    if (!oldCred) {
      throw new Error('Credential not found');
    }

    // Create new credential
    const newCred = await this.createCredential(
      {
        userId: oldCred.userId,
        provider: oldCred.provider,
        value: newValue,
        type: oldCred.type,
      },
      context
    );

    // Revoke old credential
    await this.revokeCredential(credentialId, context);

    // Log rotation
    await this.logAccess({
      id: this.generateId(),
      credentialId: oldCred.id,
      userId: oldCred.userId,
      action: 'rotated',
      timestamp: Date.now(),
      ip: context?.ip,
      userAgent: context?.userAgent,
      success: true,
    });

    return newCred;
  }

  /**
   * Revoke (soft delete) a credential
   */
  async revokeCredential(
    credentialId: string,
    context?: { ip?: string; userAgent?: string }
  ): Promise<void> {
    const row = this.db
      .query('SELECT user_id FROM user_credentials WHERE id = ?')
      .get(credentialId) as any;

    if (!row) {
      throw new Error('Credential not found');
    }

    this.db.run(
      'UPDATE user_credentials SET is_active = 0 WHERE id = ?',
      [credentialId]
    );

    await this.logAccess({
      id: this.generateId(),
      credentialId,
      userId: row.user_id,
      action: 'revoked',
      timestamp: Date.now(),
      ip: context?.ip,
      userAgent: context?.userAgent,
      success: true,
    });

    serverLog.info({ credentialId, userId: row.user_id }, 'Credential revoked');
  }

  /**
   * Get audit log for a credential
   */
  async getCredentialAuditLog(credentialId: string): Promise<CredentialAuditLog[]> {
    const rows = this.db
      .query('SELECT * FROM credential_audit_log WHERE credential_id = ? ORDER BY timestamp DESC')
      .all(credentialId) as any[];

    return rows.map(this.rowToAuditLog);
  }

  /**
   * Get audit log for a user
   */
  async getUserAuditLog(userId: string, limit: number = 100): Promise<CredentialAuditLog[]> {
    const rows = this.db
      .query('SELECT * FROM credential_audit_log WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(userId, limit) as any[];

    return rows.map(this.rowToAuditLog);
  }

  /**
   * Clean up expired credentials (call periodically)
   */
  async cleanupExpiredCredentials(): Promise<number> {
    const now = Date.now();
    
    const result = this.db.run(
      'UPDATE user_credentials SET is_active = 0 WHERE expires_at < ? AND is_active = 1',
      [now]
    );

    if (result.changes > 0) {
      serverLog.info({ count: result.changes }, 'Expired credentials cleaned up');
    }

    return result.changes;
  }

  private async logAccess(log: CredentialAuditLog): Promise<void> {
    this.db.run(
      `INSERT INTO credential_audit_log 
       (id, credential_id, user_id, action, timestamp, ip, user_agent, success, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id,
        log.credentialId,
        log.userId,
        log.action,
        log.timestamp,
        log.ip || null,
        log.userAgent || null,
        log.success ? 1 : 0,
        log.error || null,
      ]
    );
  }

  private rowToCredential(row: any): UserCredential {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      encryptedValue: row.encrypted_value,
      type: row.type,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      metadata: row.metadata,
    };
  }

  private rowToAuditLog(row: any): CredentialAuditLog {
    return {
      id: row.id,
      credentialId: row.credential_id,
      userId: row.user_id,
      action: row.action,
      timestamp: row.timestamp,
      ip: row.ip,
      userAgent: row.user_agent,
      success: row.success === 1,
      error: row.error,
    };
  }

  // Alias methods for API compatibility
  
  /**
   * Alias for createCredential
   */
  async create(input: {
    userId: string;
    provider: string;
    credential: string;
    metadata?: Record<string, any>;
  }): Promise<string> {
    const result = await this.createCredential({
      userId: input.userId,
      provider: input.provider,
      value: input.credential,
      type: 'apiKey',
    });
    return result.id;
  }

  /**
   * Alias for getCredential
   */
  async get(userId: string, credentialId: string, _reason: string): Promise<string | null> {
    const result = await this.getCredential(credentialId);
    if (!result) return null;
    // Verify ownership
    if (result.userId !== userId) return null;
    return result.plaintext;
  }

  /**
   * Get credential metadata (without plaintext)
   */
  async getMetadata(userId: string, credentialId: string): Promise<UserCredential | null> {
    const row = this.db
      .prepare('SELECT * FROM user_credentials WHERE id = ? AND user_id = ?')
      .get(credentialId, userId) as any;
    
    if (!row) return null;
    return this.rowToCredential(row);
  }

  /**
   * Alias for getUserCredentials with filters
   */
  async list(
    userId: string,
    filters?: { provider?: string; isActive?: boolean }
  ): Promise<UserCredential[]> {
    let creds = await this.getUserCredentials(userId);
    
    if (filters?.provider) {
      creds = creds.filter((c: UserCredential) => c.provider === filters.provider);
    }
    
    if (filters?.isActive !== undefined) {
      creds = creds.filter((c: UserCredential) => c.isActive === filters.isActive);
    }
    
    return creds;
  }

  /**
   * Soft delete a credential
   */
  async delete(userId: string, credentialId: string, _reason?: string): Promise<boolean> {
    const cred = await this.getMetadata(userId, credentialId);
    if (!cred) return false;
    
    this.db.prepare(
      'UPDATE user_credentials SET is_active = 0 WHERE id = ?'
    ).run(credentialId);
    
    return true;
  }

  /**
   * Rotate a credential
   */
  async rotate(userId: string, credentialId: string, reason?: string): Promise<string | null> {
    const cred = await this.get(userId, credentialId, reason || 'rotation');
    if (!cred) return null;
    // Verify ownership
    const fullCred = await this.getCredential(credentialId);
    if (!fullCred || fullCred.userId !== userId) return null;
    
    // Rotate with same value (re-encryption)
    const newCred = await this.rotateCredential(credentialId, fullCred.plaintext);
    return newCred.id;
  }

  /**
   * Update credential metadata
   */
  async updateMetadata(
    userId: string,
    credentialId: string,
    metadata: Record<string, any>
  ): Promise<boolean> {
    const cred = await this.getMetadata(userId, credentialId);
    if (!cred) return false;
    
    this.db.prepare(
      'UPDATE user_credentials SET metadata = ? WHERE id = ?'
    ).run(JSON.stringify(metadata), credentialId);
    
    return true;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}

// Singleton instance
let credentialsServiceInstance: UserCredentialsService | null = null;

export function createUserCredentialsService(): UserCredentialsService {
  if (!credentialsServiceInstance) {
    const { PerUserKeyDerivation } = require('../crypto/per-user');
    const { LocalKMSProvider } = require('../crypto/providers');
    const kms = new LocalKMSProvider({ suppressWarning: true });
    const encryption = new PerUserKeyDerivation(kms);
    credentialsServiceInstance = new UserCredentialsService(encryption, getDb());
  }
  return credentialsServiceInstance;
}
