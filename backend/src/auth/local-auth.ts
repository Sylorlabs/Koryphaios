// Local Authentication Manager - Local HMAC Authentication
import { timingSafeEqual, randomBytes, createHmac, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';
import { ensureSecureDir } from '../security/fs-permissions';

export interface SessionToken {
  readonly id: string;
  readonly created: number;
  readonly expiresAt: number;
  readonly permissions: string[];
}

export interface AuthConfig {
  readonly sessionDurationMs: number;
  readonly maxSessions: number;
}

const DEFAULT_CONFIG: AuthConfig = {
  sessionDurationMs: 24 * 60 * 60 * 1000,
  maxSessions: 10,
};

/**
 * Local HMAC authentication manager.
 * Trust boundary: anyone with read access to PROJECT_ROOT/.koryphaios/ can forge session tokens.
 */
export class LocalAuthManager {
  private static readonly TOKEN_DIR = '.koryphaios';
  private static readonly TOKEN_FILE = '.master-auth';
  private static readonly SESSION_FILE = '.sessions.json';

  private masterKey: Buffer;
  private sessions = new Map<string, SessionToken>();
  private config: AuthConfig;
  private initialized = false;

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.masterKey = this.loadOrGenerateMasterKey();
    this.loadSessions();
    this.initialized = true;
    setInterval(() => this.cleanupExpiredSessions(), 60 * 60 * 1000);
  }

  private loadOrGenerateMasterKey(): Buffer {
    const tokenDir = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR);
    const tokenPath = join(tokenDir, LocalAuthManager.TOKEN_FILE);

    // Always ensure 0o700, even if the dir already exists from an older build
    // that created it with a looser umask.
    ensureSecureDir(tokenDir);

    if (existsSync(tokenPath)) {
      try {
        const stored = readFileSync(tokenPath, 'utf-8');
        const data = JSON.parse(stored);
        if (data.salt && data.key) {
          return scryptSync(Buffer.from(data.key, 'base64'), Buffer.from(data.salt, 'base64'), 32, {
            N: 16384,
            r: 8,
            p: 1,
          });
        }
      } catch (err) {
        serverLog.warn({ err }, 'Failed to load auth key');
      }
    }

    const keyMaterial = randomBytes(64);
    const salt = randomBytes(32);
    const masterKey = scryptSync(keyMaterial, salt, 32, { N: 16384, r: 8, p: 1 });

    const keyData = {
      version: 'v1',
      created: Date.now(),
      salt: salt.toString('base64'),
      key: keyMaterial.toString('base64'),
    };

    writeFileSync(tokenPath, JSON.stringify(keyData, null, 2), { mode: 0o600 });
    chmodSync(tokenPath, 0o600);

    return masterKey;
  }

  private loadSessions(): void {
    const sessionPath = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR, LocalAuthManager.SESSION_FILE);
    if (!existsSync(sessionPath)) return;
    try {
      const raw = readFileSync(sessionPath, 'utf-8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      const now = Date.now();
      for (const entry of data) {
        if (!entry || typeof entry.id !== 'string') continue;
        if (typeof entry.expiresAt !== 'number' || now > entry.expiresAt) continue;
        this.sessions.set(entry.id, {
          id: entry.id,
          created: entry.created,
          expiresAt: entry.expiresAt,
          permissions: Array.isArray(entry.permissions) ? entry.permissions : [],
        });
      }
    } catch (err) {
      serverLog.warn({ err }, 'Failed to load persisted sessions, starting fresh');
    }
  }

  private persistSessions(): void {
    const sessionPath = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR, LocalAuthManager.SESSION_FILE);
    try {
      const serialized = [...this.sessions.values()].map((s) => ({
        id: s.id,
        created: s.created,
        expiresAt: s.expiresAt,
        permissions: s.permissions,
      }));
      writeFileSync(sessionPath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
      chmodSync(sessionPath, 0o600);
    } catch (err) {
      serverLog.warn({ err }, 'Failed to persist sessions');
    }
  }

  createSession(permissions: string[] = ['*']): { sessionId: string; signature: string; expiresAt: number; permissions: string[] } {
    if (this.sessions.size >= this.config.maxSessions) {
      this.cleanupOldestSession();
    }

    const sessionId = randomBytes(32).toString('base64url');
    const now = Date.now();

    const session: SessionToken = {
      id: sessionId,
      created: now,
      expiresAt: now + this.config.sessionDurationMs,
      permissions,
    };

    this.sessions.set(sessionId, session);
    this.persistSessions();
    const signature = this.generateSignature(sessionId);

    return { sessionId, signature, expiresAt: session.expiresAt, permissions: session.permissions };
  }

  getSessionMetadata(sessionId: string): { expiresAt: number; permissions: string[] } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { expiresAt: session.expiresAt, permissions: session.permissions };
  }

  validateRequest(authHeader: string | null): {
    valid: boolean;
    session?: SessionToken;
    error?: string;
  } {
    if (!authHeader) {
      return { valid: false, error: 'Missing authentication' };
    }

    const match = authHeader.match(/^Bearer\s+([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/);
    if (!match) {
      return { valid: false, error: 'Invalid auth format' };
    }

    const [, sessionId, providedSig] = match;
    const session = this.sessions.get(sessionId);

    if (!session || Date.now() > session.expiresAt) {
      return { valid: false, error: 'Invalid or expired session' };
    }

    const expectedSig = this.generateSignature(sessionId);
    const providedBuf = Buffer.from(providedSig, 'base64url');
    const expectedBuf = Buffer.from(expectedSig, 'base64url');

    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true, session };
  }

  hasPermission(session: SessionToken, permission: string): boolean {
    if (session.permissions.includes('*')) return true;
    if (session.permissions.includes(permission)) return true;
    return false;
  }

  revokeSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) this.persistSessions();
    return deleted;
  }

  private generateSignature(sessionId: string): string {
    return createHmac('sha256', this.masterKey).update(sessionId).digest('base64url');
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persistSessions();
  }

  private cleanupOldestSession(): void {
    let oldestId = '';
    let oldestTime = Infinity;
    for (const [id, session] of this.sessions) {
      if (session.created < oldestTime) {
        oldestTime = session.created;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.sessions.delete(oldestId);
      this.persistSessions();
    }
  }

  getSetupToken(): string {
    return createHmac('sha256', this.masterKey).update('setup').digest('hex').slice(0, 16);
  }
}

export const localAuth = new LocalAuthManager();
