// Session token authentication
// Simple JWT-like token system for session authentication

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { serverLog } from "./logger";
import { ValidationError } from "./errors";

/**
 * Secret key for signing tokens — REQUIRED in all environments
 * No fallback for security — fail fast if misconfigured
 */
const TOKEN_SECRET = (() => {
  const secret = process.env.SESSION_TOKEN_SECRET;
  if (!secret || typeof secret !== "string") {
    throw new Error(
      "SESSION_TOKEN_SECRET must be set in environment (min 32 characters). " +
      "Use: openssl rand -hex 16 to generate a secure secret."
    );
  }
  if (secret.trim().length < 32) {
    throw new Error(
      `SESSION_TOKEN_SECRET must be at least 32 characters (current: ${secret.trim().length}).`
    );
  }
  return secret.trim();
})();

if (!process.env.SESSION_TOKEN_SECRET) {
  serverLog.warn("SESSION_TOKEN_SECRET not set - this will cause a startup error");
}

/**
 * Token payload structure
 */
interface TokenPayload {
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Generate a session token
 */
export function generateSessionToken(sessionId: string, ttlMs: number = 24 * 60 * 60 * 1000): string {
  const payload: TokenPayload = {
    sessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };

  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", TOKEN_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${signature}`;
}

/**
 * Verify and decode a session token
 */
export function verifySessionToken(token: string): TokenPayload {
  try {
    const [payloadBase64, signature] = token.split(".");
    
    if (!payloadBase64 || !signature) {
      throw new ValidationError("Invalid token format");
    }

    // Verify signature
    const expectedSignature = createHmac("sha256", TOKEN_SECRET)
      .update(payloadBase64)
      .digest("base64url");

    // Timing-safe comparison to prevent timing attacks
    const sigBuf = Buffer.from(signature, "base64url");
    const expectedBuf = Buffer.from(expectedSignature, "base64url");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      throw new ValidationError("Invalid token signature");
    }

    // Decode payload
    const payload: TokenPayload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf-8")
    );

    // Check expiration
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      throw new ValidationError("Token expired");
    }

    return payload;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Token verification failed", { error: String(err) });
  }
}

/**
 * Extract token from request headers
 */
export function extractTokenFromRequest(req: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  // Check X-Session-Token header
  const sessionHeader = req.headers.get("X-Session-Token");
  if (sessionHeader) {
    return sessionHeader;
  }

  return null;
}

export class AuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Middleware to require session token authentication
 * Returns sessionId if valid, throws AuthError if not
 */
export function requireSessionAuth(req: Request): string {
  const token = extractTokenFromRequest(req);
  
  if (!token) {
    throw new AuthError("Missing session token");
  }

  try {
    const payload = verifySessionToken(token);
    return payload.sessionId;
  } catch (err) {
    throw new AuthError("Invalid or expired session token");
  }
}

/**
 * Optional authentication (doesn't throw, returns null if no token)
 */
export function optionalSessionAuth(req: Request): string | null {
  try {
    return requireSessionAuth(req);
  } catch (err) {
    return null;
  }
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
} from "./auth/auth";
