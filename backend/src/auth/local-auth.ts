// Local Authentication Manager - Zero-Trust Local Architecture
import { timingSafeEqual, randomBytes, createHmac, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { serverLog } from '../logger';
import { PROJECT_ROOT } from '../runtime/paths';

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

export class LocalAuthManager {
  private static readonly TOKEN_DIR = '.koryphaios';
  private static readonly TOKEN_FILE = '.master-auth';

  private masterKey: Buffer;
  private sessions = new Map<string, SessionToken>();
  private config: AuthConfig;
  private initialized = false;

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.masterKey = this.loadOrGenerateMasterKey();
    this.initialized = true;
    setInterval(() => this.cleanupExpiredSessions(), 60 * 60 * 1000);
  }

  private loadOrGenerateMasterKey(): Buffer {
    const tokenDir = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR);
    const tokenPath = join(tokenDir, LocalAuthManager.TOKEN_FILE);

    if (!existsSync(tokenDir)) {
      mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    }

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

    serverLog.warn(
      'New auth key generated! Save: ' + keyMaterial.slice(0, 16).toString('base64') + '...',
    );
    return masterKey;
  }

  createSession(permissions: string[] = ['*']): { sessionId: string; signature: string } {
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
    const signature = this.generateSignature(sessionId);

    return { sessionId, signature };
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
    return this.sessions.delete(sessionId);
  }

  private generateSignature(sessionId: string): string {
    return createHmac('sha256', this.masterKey).update(sessionId).digest('base64url');
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
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
    if (oldestId) this.sessions.delete(oldestId);
  }

  getSetupToken(): string {
    return createHmac('sha256', this.masterKey).update('setup').digest('hex').slice(0, 16);
  }
}

export const localAuth = new LocalAuthManager();
