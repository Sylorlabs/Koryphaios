// Session token authentication
// Simple JWT-like token system for session authentication

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { serverLog } from "./logger";
import { ValidationError } from "./errors";

/**
 * Secret key for signing tokens (should be in environment in production)
 */
const TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET ?? randomBytes(32).toString("hex");

if (!process.env.SESSION_TOKEN_SECRET) {
  serverLog.warn("SESSION_TOKEN_SECRET not set, using random key (tokens won't persist across restarts)");
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

  // Check query parameter (for WebSocket upgrades)
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam) {
    return tokenParam;
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
