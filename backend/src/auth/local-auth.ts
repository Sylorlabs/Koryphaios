// Local Authentication Manager - Zero-Trust Local Architecture
// Provides cryptographic authentication between frontend and backend
// Even though both run locally, we authenticate every request

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
  readonly requireSecureContext: boolean;
}

const DEFAULT_CONFIG: AuthConfig = {
  sessionDurationMs: 24 * 60 * 60 * 1000, // 24 hours
  maxSessions: 10,
  requireSecureContext: true,
};

/**
 * Local authentication manager implementing zero-trust principles
 * for local-first applications. Even local processes must authenticate.
 */
export class LocalAuthManager {
  private static readonly TOKEN_DIR = '.koryphaios';
  private static readonly TOKEN_FILE = '.master-auth';
  private static readonly SESSION_FILE = '.active-sessions';
  
  private masterKey: Buffer;
  private sessions = new Map<string, SessionToken>();
  private config: AuthConfig;
  private initialized = false;
  
  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.masterKey = this.loadOrGenerateMasterKey();
    this.loadSessions();
    this.initialized = true;
    
    // Cleanup expired sessions periodically
    setInterval(() => this.cleanupExpiredSessions(), 60 * 60 * 1000); // Every hour
  }
  
  /**
   * Load existing master key or generate new one
   * Key is stored with 0600 permissions and derived using scrypt
   */
  private loadOrGenerateMasterKey(): Buffer {
    const tokenDir = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR);
    const tokenPath = join(tokenDir, LocalAuthManager.TOKEN_FILE);
    
    if (!existsSync(tokenDir)) {
      mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    }
    
    // Try to load existing key
    if (existsSync(tokenPath)) {
      try {
        const stored = readFileSync(tokenPath, 'utf-8');
        const data = JSON.parse(stored);
        
        if (data.salt && data.key) {
          serverLog.info('Loaded existing authentication key');
          // Re-derive key from stored material
          return scryptSync(
            Buffer.from(data.key, 'base64'),
            Buffer.from(data.salt, 'base64'),
            32,
            { N: 16384, r: 8, p: 1 }
          );
        }
      } catch (err) {
        serverLog.warn({ err }, 'Failed to load existing auth key, generating new one');
      }
    }
    
    // Generate new master key using CSPRNG
    const keyMaterial = randomBytes(64);
    const salt = randomBytes(32);
    
    // Derive master key using scrypt (memory-hard)
    const masterKey = scryptSync(keyMaterial, salt, 32, { N: 16384, r: 8, p: 1 });
    
    // Store key material (not the derived key) with strict permissions
    const keyData = {
      version: 'v1',
      created: Date.now(),
      salt: salt.toString('base64'),
      key: keyMaterial.toString('base64'),
    };
    
    writeFileSync(tokenPath, JSON.stringify(keyData, null, 2), { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    
    serverLog.warn(
      '\n' + '='.repeat(60) + '\n' +
      'SECURITY: New authentication key generated!\n' +
      'Store this in your password manager (one-time display):\n' +
      keyMaterial.slice(0, 16).toString('base64') + '...\n' +
      '='.repeat(60)
    );
    
    return masterKey;
  }
  
  /**
   * Create a new session token
   */
  createSession(permissions: string[] = ['*']): { sessionId: string; signature: string } {
    // Cleanup old sessions if at limit
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
    this.saveSessions();
    
    // Generate HMAC signature for this session
    const signature = this.generateSignature(sessionId);
    
    serverLog.debug({ sessionId: sessionId.slice(0, 8) }, 'Created new auth session');
    
    return { sessionId, signature };
  }
  
  /**
   * Validate an incoming request's authentication
   */
  validateRequest(authHeader: string | null): { valid: boolean; session?: SessionToken; error?: string } {
    if (!authHeader) {
      return { valid: false, error: 'Missing authentication header' };
    }
    
    if (!this.initialized) {
      return { valid: false, error: 'Authentication system not initialized' };
    }
    
    // Parse header: "Bearer <sessionId>:<signature>"
    const match = authHeader.match(/^Bearer\s+([A-Za-z0-9_-]+):([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return { valid: false, error: 'Invalid authentication header format' };
    }
    
    const [, sessionId, providedSig] = match;
    
    // Check session exists and is valid
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { valid: false, error: 'Invalid or expired session' };
    }
    
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      this.saveSessions();
      return { valid: false, error: 'Session expired' };
    }
    
    // Verify HMAC signature (constant-time comparison)
    const expectedSig = this.generateSignature(sessionId);
    const providedBuf = Buffer.from(providedSig, 'base64');
    const expectedBuf = Buffer.from(expectedSig, 'base64');
    
    if (providedBuf.length !== expectedBuf.length) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    if (!timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    return { valid: true, session };
  }
  
  /**
   * Check if session has required permission
   */
  hasPermission(session: SessionToken, permission: string): boolean {
    if (session.permissions.includes('*')) return true;
    if (session.permissions.includes(permission)) return true;
    
    // Check wildcards (e.g., "tools:*" matches "tools:bash")
    for (const perm of session.permissions) {
      if (perm.endsWith(':*')) {
        const prefix = perm.slice(0, -1);
        if (permission.startsWith(prefix)) return true;
      }
    }
    
    return false;
  }
  
  /**
   * Revoke a session
   */
  revokeSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      this.saveSessions();
      serverLog.debug({ sessionId: sessionId.slice(0, 8) }, 'Revoked auth session');
    }
    return deleted;
  }
  
  /**
   * List all active sessions (for admin UI)
   */
  listSessions(): Omit<SessionToken, 'id'>[] {
    return Array.from(this.sessions.values()).map(({ id, ...rest }) => ({
      ...rest,
      id: id.slice(0, 8) + '...', // Truncate for display
    }));
  }
  
  /**
   * Generate HMAC signature for session
   */
  private generateSignature(sessionId: string): string {
    return createHmac('sha256', this.masterKey)
      .update(sessionId)
      .digest('base64url');
  }
  
  /**
   * Load sessions from disk
   */
  private loadSessions(): void {
    const sessionPath = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR, LocalAuthManager.SESSION_FILE);
    
    if (!existsSync(sessionPath)) return;
    
    try {
      const data = readFileSync(sessionPath, 'utf-8');
      const sessions = JSON.parse(data);
      
      for (const [id, session] of Object.entries(sessions)) {
        this.sessions.set(id, session as SessionToken);
      }
      
      serverLog.debug({ count: this.sessions.size }, 'Loaded auth sessions');
    } catch (err) {
      serverLog.warn({ err }, 'Failed to load sessions');
    }
  }
  
  /**
   * Save sessions to disk
   */
  private saveSessions(): void {
    const sessionPath = join(PROJECT_ROOT, LocalAuthManager.TOKEN_DIR, LocalAuthManager.SESSION_FILE);
    
    try {
      const data = Object.fromEntries(this.sessions);
      writeFileSync(sessionPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
      serverLog.error({ err }, 'Failed to save sessions');
    }
  }
  
  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.saveSessions();
      serverLog.debug({ cleaned }, 'Cleaned up expired sessions');
    }
  }
  
  /**
   * Remove oldest session when at limit
   */
  private cleanupOldestSession(): void {
    let oldest: SessionToken | null = null;
    let oldestId = '';
    
    for (const [id, session] of this.sessions) {
      if (!oldest || session.created < oldest.created) {
        oldest = session;
        oldestId = id;
      }
    }
    
    if (oldestId) {
      this.sessions.delete(oldestId);
      serverLog.debug({ sessionId: oldestId.slice(0, 8) }, 'Removed oldest session');
    }
  }
  
  /**
   * Generate a one-time setup token for new installations
   */
  getSetupToken(): string {
    // Return first 16 chars of key hash for verification
    const hash = createHmac('sha256', this.masterKey)
      .update('setup-verification')
      .digest('hex');
    return hash.slice(0, 16);
  }
}

// Export singleton instance
export const localAuth = new LocalAuthManager();
