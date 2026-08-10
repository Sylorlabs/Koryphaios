// User Credentials Service
// Securely stores and manages API keys and tokens

import { serverLog } from '../logger';
import { db, getDb, userCredentials, credentialAuditLog } from '../db';
import { eq, and, desc } from 'drizzle-orm';
import { createAuditLogService } from './audit';
import { encryptForStorage, secureDecrypt } from '../security';

/** Credential record exposed without the encrypted/plaintext value (metadata view). */
export type CredentialMetadataView = Omit<UserCredential, 'encryptedValue' | 'metadata'> & {
  metadata?: Record<string, unknown>;
};

export interface UserCredential {
  id: string;
  userId: string;
  provider: string;
  encryptedValue: string;
  type: 'apiKey' | 'authToken' | 'baseUrl';
  isActive: boolean;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
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
  metadata?: Record<string, unknown>;
}

export interface CredentialWithPlaintext extends UserCredential {
  plaintext: string;
}

/**
 * Historical credential encryption used a repeating XOR key and stored the
 * result as unprefixed base64. It is retained only as a one-way migration
 * reader; new writes must use authenticated envelope encryption.
 */
function decryptLegacyXorCredential(encrypted: string): string {
  if (
    encrypted.length === 0 ||
    encrypted.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)
  ) {
    throw new Error('Legacy credential is not valid canonical base64');
  }

  const masterKey = process.env.KORYPHAIOS_MASTER_KEY || 'dev-key';
  const keyBytes = Buffer.from(masterKey.slice(0, 32), 'utf8');
  const encryptedBytes = Buffer.from(encrypted, 'base64');
  if (encryptedBytes.toString('base64') !== encrypted) {
    throw new Error('Legacy credential is not canonical base64');
  }
  const decrypted = Buffer.alloc(encryptedBytes.length);
  for (let i = 0; i < encryptedBytes.length; i++)
    decrypted[i] = encryptedBytes[i] ^ keyBytes[i % keyBytes.length];

  let plaintext: string;
  try {
    plaintext = new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
  } catch {
    throw new Error('Legacy credential could not be decoded with the configured migration key');
  }
  if (!plaintext || /[\u0000-\u001f\u007f]/.test(plaintext)) {
    throw new Error('Legacy credential failed migration validation');
  }
  return plaintext;
}

export interface CredentialEncryption {
  encrypt(plaintext: string): Promise<string>;
  decryptEnvelope(ciphertext: string): Promise<string>;
}

const authenticatedEnvelopeEncryption: CredentialEncryption = {
  encrypt: encryptForStorage,
  async decryptEnvelope(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith('env:')) {
      throw new Error('Credential is not stored as an authenticated envelope');
    }
    return secureDecrypt(ciphertext);
  },
};

export class UserCredentialsService {
  private schemaReady: Promise<void> | null = null;
  private audit = createAuditLogService();

  constructor(
    private readonly encryption: CredentialEncryption = authenticatedEnvelopeEncryption,
  ) {}

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        const sqlite = getDb();
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS user_credentials (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            encrypted_credential TEXT NOT NULL,
            type TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER,
            expires_at INTEGER,
            metadata TEXT
          );

          CREATE INDEX IF NOT EXISTS idx_user_credentials_user
            ON user_credentials(user_id);
          CREATE INDEX IF NOT EXISTS idx_user_credentials_provider
            ON user_credentials(provider);

          CREATE TABLE IF NOT EXISTS credential_audit_log (
            id TEXT PRIMARY KEY,
            credential_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            ip TEXT,
            user_agent TEXT,
            success INTEGER NOT NULL,
            error TEXT
          );
        `);
      })();
    }
    await this.schemaReady;
  }

  async createCredential(
    input: CreateCredentialInput,
    context?: { ip?: string; userAgent?: string },
  ): Promise<UserCredential> {
    await this.ensureSchema();
    const id = this.generateId();
    const now = new Date();
    try {
      const encryptedValue = await this.encryption.encrypt(input.value);
      if (!encryptedValue.startsWith('env:')) {
        throw new Error('Credential encryption did not produce an authenticated envelope');
      }
      const [row] = await db
        .insert(userCredentials)
        .values({
          id,
          userId: input.userId,
          provider: input.provider,
          encryptedCredential: encryptedValue,
          type: input.type,
          isActive: 1,
          createdAt: now,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        })
        .returning();
      await this.logAccess({
        id: this.generateId(),
        credentialId: id,
        userId: input.userId,
        action: 'created',
        timestamp: now.getTime(),
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: true,
      });
      return this.rowToCredential(row);
    } catch (error: unknown) {
      await this.logAccess({
        id: this.generateId(),
        credentialId: id,
        userId: input.userId,
        action: 'created',
        timestamp: now.getTime(),
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getCredential(
    credentialId: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<CredentialWithPlaintext | null> {
    await this.ensureSchema();
    const now = new Date();
    try {
      const [row] = await db
        .select()
        .from(userCredentials)
        .where(and(eq(userCredentials.id, credentialId), eq(userCredentials.isActive, 1)))
        .limit(1);
      if (!row) return null;
      const credential = this.rowToCredential(row);
      if (credential.expiresAt && credential.expiresAt < now.getTime()) {
        await this.logAccess({
          id: this.generateId(),
          credentialId,
          userId: credential.userId,
          action: 'accessed',
          timestamp: now.getTime(),
          ip: context?.ip,
          userAgent: context?.userAgent,
          success: false,
          error: 'Credential expired',
        });
        throw new Error('Credential expired');
      }
      let plaintext: string;
      let encryptedValue = credential.encryptedValue;
      if (encryptedValue.startsWith('env:')) {
        plaintext = await this.encryption.decryptEnvelope(encryptedValue);
      } else if (encryptedValue.startsWith('enc:')) {
        throw new Error(
          'Unsupported legacy credential format. Re-enter this credential to store it securely.',
        );
      } else {
        // Recover historical unprefixed XOR rows only long enough to replace
        // them in-place with an authenticated envelope. If envelope encryption
        // is unavailable, the update never occurs and plaintext is not returned.
        plaintext = decryptLegacyXorCredential(encryptedValue);
        const migratedValue = await this.encryption.encrypt(plaintext);
        if (!migratedValue.startsWith('env:')) {
          throw new Error('Legacy credential migration did not produce an authenticated envelope');
        }
        const verifiedPlaintext = await this.encryption.decryptEnvelope(migratedValue);
        if (verifiedPlaintext !== plaintext) {
          throw new Error('Legacy credential migration envelope failed round-trip verification');
        }
        encryptedValue = migratedValue;
      }
      await db
        .update(userCredentials)
        .set({ encryptedCredential: encryptedValue, lastUsedAt: now })
        .where(eq(userCredentials.id, credentialId));
      await this.logAccess({
        id: this.generateId(),
        credentialId,
        userId: credential.userId,
        action: 'accessed',
        timestamp: now.getTime(),
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: true,
      });
      return { ...credential, encryptedValue, plaintext };
    } catch (error: unknown) {
      await this.logAccess({
        id: this.generateId(),
        credentialId,
        userId: 'unknown',
        action: 'accessed',
        timestamp: now.getTime(),
        ip: context?.ip,
        userAgent: context?.userAgent,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getUserCredentials(userId: string): Promise<UserCredential[]> {
    await this.ensureSchema();
    const rows = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId))
      .orderBy(desc(userCredentials.createdAt));
    return rows.map((r) => this.rowToCredential(r));
  }

  async revokeCredential(
    credentialId: string,
    context?: { ip?: string; userAgent?: string },
  ): Promise<void> {
    await this.ensureSchema();
    const [row] = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.id, credentialId))
      .limit(1);
    if (!row) throw new Error('Credential not found');
    await db
      .update(userCredentials)
      .set({ isActive: 0 })
      .where(eq(userCredentials.id, credentialId));
    await this.logAccess({
      id: this.generateId(),
      credentialId,
      userId: row.userId,
      action: 'revoked',
      timestamp: Date.now(),
      ip: context?.ip,
      userAgent: context?.userAgent,
      success: true,
    });
  }

  private async logAccess(log: CredentialAuditLog): Promise<void> {
    try {
      await db.insert(credentialAuditLog).values({
        id: log.id,
        credentialId: log.credentialId,
        userId: log.userId,
        action: log.action,
        timestamp: new Date(log.timestamp),
        ip: log.ip || null,
        userAgent: log.userAgent || null,
        success: log.success ? 1 : 0,
        error: log.error || null,
      });
    } catch (error) {
      serverLog.warn(
        { error, credentialId: log.credentialId, action: log.action },
        'Credential audit log unavailable',
      );
    }
  }

  private rowToCredential(row: typeof userCredentials.$inferSelect): UserCredential {
    return {
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      encryptedValue: row.encryptedCredential,
      type: row.type,
      isActive: row.isActive === 1,
      createdAt: row.createdAt.getTime(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : undefined,
      expiresAt: row.expiresAt ? row.expiresAt.getTime() : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private generateId(): string {
    return `cred_${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  async create(input: {
    userId: string;
    provider: string;
    credential: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const res = await this.createCredential({
      userId: input.userId,
      provider: input.provider,
      value: input.credential,
      type: 'apiKey',
      metadata: input.metadata,
    });
    return res.id;
  }
  async get(userId: string, credentialId: string, reason: string): Promise<string | null> {
    const res = await this.getCredential(credentialId).catch(() => null);
    if (!res || res.userId !== userId) return null;
    // Record the access in the audit trail (action/resourceId/reason are queried back).
    await this.audit
      .log({
        userId,
        action: 'credential_access',
        resourceType: 'credential',
        resourceId: credentialId,
        reason,
        success: true,
        timestamp: Date.now(),
      })
      .catch((err: unknown) => {
        // Audit logging is non-critical — credential access still succeeds.
        serverLog.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            credentialId,
            action: 'credential_access',
          },
          'Credential audit log failed (non-critical)',
        );
      });
    return res.plaintext;
  }

  async list(
    userId: string,
    filters?: { provider?: string; isActive?: boolean },
  ): Promise<UserCredential[]> {
    let creds = await this.getUserCredentials(userId);
    if (filters?.provider) creds = creds.filter((c) => c.provider === filters.provider);
    if (filters?.isActive !== undefined)
      creds = creds.filter((c) => c.isActive === filters.isActive);
    return creds;
  }

  /** Fetch a credential's metadata WITHOUT the secret value. Null if missing/not owned/inactive. */
  async getMetadata(userId: string, credentialId: string): Promise<CredentialMetadataView | null> {
    await this.ensureSchema();
    const [row] = await db
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.id, credentialId), eq(userCredentials.isActive, 1)))
      .limit(1);
    if (!row || row.userId !== userId) return null;
    const cred = this.rowToCredential(row);
    // rowToCredential already JSON-parses metadata; strip the encrypted value.
    const { encryptedValue, metadata, ...rest } = cred as UserCredential & {
      metadata?: Record<string, unknown> | string;
    };
    return {
      ...rest,
      metadata: (metadata as Record<string, unknown> | undefined) ?? {},
    };
  }

  /** Update a credential's metadata. Returns false if missing/not owned. */
  async updateMetadata(
    userId: string,
    credentialId: string,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    await this.ensureSchema();
    const [row] = await db
      .select()
      .from(userCredentials)
      .where(and(eq(userCredentials.id, credentialId), eq(userCredentials.isActive, 1)))
      .limit(1);
    if (!row || row.userId !== userId) return false;
    await db
      .update(userCredentials)
      .set({ metadata: JSON.stringify(metadata) })
      .where(eq(userCredentials.id, credentialId));
    return true;
  }

  /** Rotate a credential's encryption: re-encrypt the secret under a fresh record and
   *  retire the old one. Returns the new credential id, or null if missing/not owned. */
  async rotate(userId: string, credentialId: string): Promise<string | null> {
    const existing = await this.getCredential(credentialId).catch(() => null);
    if (!existing || existing.userId !== userId) return null;
    const created = await this.createCredential({
      userId,
      provider: existing.provider,
      value: existing.plaintext,
      type: existing.type,
      expiresAt: existing.expiresAt,
      metadata: existing.metadata
        ? (existing.metadata as unknown as Record<string, unknown>)
        : undefined,
    });
    await this.revokeCredential(credentialId).catch((err: unknown) => {
      // Revocation best-effort — the new credential is already created.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), credentialId },
        'Credential revocation during rotation failed (non-critical, new credential already created)',
      );
    });
    await this.audit
      .log({
        userId,
        action: 'credential_rotate',
        resourceType: 'credential',
        resourceId: credentialId,
        success: true,
        timestamp: Date.now(),
      })
      .catch((err: unknown) => {
        // Audit logging is non-critical — rotation still succeeds.
        serverLog.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            credentialId,
            action: 'credential_rotate',
          },
          'Credential rotate audit log failed (non-critical)',
        );
      });
    return created.id;
  }

  /** Soft-delete a credential. Returns false if missing or not owned by the user. */
  async delete(userId: string, credentialId: string): Promise<boolean> {
    await this.ensureSchema();
    const [row] = await db
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.id, credentialId))
      .limit(1);
    if (!row || row.userId !== userId) return false;
    await this.revokeCredential(credentialId).catch((err: unknown) => {
      // Revocation best-effort — the credential is already soft-deleted in the DB.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), credentialId },
        'Credential revocation during delete failed (non-critical, already soft-deleted)',
      );
    });
    return true;
  }
}

let instance: UserCredentialsService | null = null;
export function createUserCredentialsService(): UserCredentialsService {
  if (!instance) instance = new UserCredentialsService();
  return instance;
}
export function resetCredentialsService(): void {
  instance = null;
}
