// Session token authentication
// Simple JWT-like token system for session authentication

import { createHmac, timingSafeEqual } from 'crypto';
import { ValidationError } from './errors';

const SESSION_TOKEN_SECRET = (() => {
  const secret = process.env.SESSION_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_TOKEN_SECRET must be set and contain at least 32 characters.');
  }
  return secret;
})();

export interface SessionTokenPayload {
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
}

/** Legacy session-token API retained for callers that issue scoped session tokens. */
export function generateSessionToken(
  sessionId: string,
  ttlMs: number = 24 * 60 * 60 * 1000,
): string {
  const now = Date.now();
  const payload: SessionTokenPayload = {
    sessionId,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', SESSION_TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string): SessionTokenPayload {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ValidationError('Invalid token format');
    }
    const [encoded, signature] = parts;
    const expected = createHmac('sha256', SESSION_TOKEN_SECRET).update(encoded).digest('base64url');
    const actualBytes = Buffer.from(signature, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw new ValidationError('Invalid token signature');
    }
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionTokenPayload;
    if (!payload.sessionId || !Number.isFinite(payload.createdAt)) {
      throw new ValidationError('Invalid token payload');
    }
    if (payload.expiresAt !== undefined && Date.now() > payload.expiresAt) {
      throw new ValidationError('Token expired');
    }
    return payload;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Token verification failed', { error: String(error) });
  }
}

/** Read credentials from headers only; query-string tokens are intentionally rejected. */
export function extractTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return request.headers.get('X-Session-Token');
}

// Re-export user auth so "from './auth'" gets both session and user auth
export {
  hashPassword,
  verifyPassword,
  generateToken,
  createAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  revokeAllUserSessions,
  createUser,
  authenticateUser,
  getUserById,
  getOrCreateGuestUser,
  getOrCreateLocalUser,
  changePassword,
  cleanupExpiredTokens,
  cleanupBlacklist,
} from './auth/auth';
