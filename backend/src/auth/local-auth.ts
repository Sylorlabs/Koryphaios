// Local Authentication Manager - Zero-Trust Local Architecture
import { timingSafeEqual, randomBytes, createHmac, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from 'fs';
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

export class LocalAuthManager {
  private static readonly TOKEN_DIR = '.koryphaios';
  private static readonly TOKEN_FILE = '.master-auth';

  private masterKey: Buffer;
  private sessions = new Map<string, SessionToken>();
  private config: AuthConfig;
  private initialized = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.masterKey = this.loadOrGenerateMasterKey();
    this.initialized = true;
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60 * 60 * 1000);
    // Don't keep the event loop alive solely for session cleanup. The
    // backend has plenty of other keep-alive handles; this timer should
    // not be the reason `process.exit(0)` hangs in tests or scripted runs.
    this.cleanupTimer.unref?.();
  }

  /** Stop the cleanup timer and clear sensitive material. Call on shutdown. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
    if (this.masterKey) this.masterKey.fill(0);
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

    // Never log key material — even partial bytes. The key file is on disk
    // with 0o600; that's the recovery path, not the log stream.
    serverLog.warn('New auth master key generated and persisted to disk (0o600).');
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

  /**
   * Generate a one-time setup token. Unlike the old deterministic
   * HMAC(masterKey, 'setup') value, this token is random and stored
   * alongside the master key file. It's invalidated after first use so
   * an attacker who reads .master-auth can't reproduce the setup token.
   */
  getSetupToken(): string {
    const tokenDir = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR);
    const tokenPath = join(tokenDir, '.setup-token');
    // If a token already exists and hasn't been used, return it (idempotent
    // within a single setup session). Otherwise generate a new one.
    try {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      if (existing) return existing;
    } catch {
      /* no existing token — generate one */
    }
    const token = randomBytes(24).toString('hex');
    try {
      // Use ensureSecureDir to create the directory with 0o700 so other
      // users can't list it or see that a setup token exists.
      ensureSecureDir(tokenDir);
      writeFileSync(tokenPath, token, { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
    } catch {
      // If we can't persist the token, fall back to an in-memory only
      // token. This is less safe (lost on restart) but better than
      // the deterministic HMAC.
    }
    return token;
  }

  /** Invalidate the setup token after successful first-use. */
  consumeSetupToken(): void {
    const tokenDir = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR);
    const tokenPath = join(tokenDir, '.setup-token');
    try {
      unlinkSync(tokenPath);
    } catch {
      /* already gone or never created */
    }
  }
}

export const localAuth = new LocalAuthManager();
