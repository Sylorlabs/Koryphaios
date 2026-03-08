// SECURE Authentication System for Koryphaios
// JWT-based auth with refresh token rotation, Redis blacklisting, and proper security
//
// SECURITY IMPROVEMENTS:
// - No random secret fallback — JWT_SECRET required in all environments
// - Token blacklist via Redis for immediate revocation
// - Refresh token rotation (issue new token on each use)
// - JTI (token ID) for individual token tracking
// - Prepared for RS256 migration (key rotation infrastructure)

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/sqlite";
import { authLog } from "../logger";
import { getRedisClient } from "../redis";
import type { User, JWTPayload } from "./types";

const ACCESS_TOKEN_EXPIRY_SEC = 15 * 60;
const REFRESH_TOKEN_EXPIRY_SEC = 7 * 24 * 60 * 60;
const BLACKLIST_TTL_SEC = REFRESH_TOKEN_EXPIRY_SEC + 60; // Keep slightly longer than refresh token

/**
 * SECURE JWT Secret: Required in ALL environments (min 64 characters)
 * No fallback — fail fast if misconfigured
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;

  if (!secret || typeof secret !== "string") {
    throw new Error(
      "JWT_SECRET must be set in environment (min 64 characters). " +
      "Set it in .env or environment. This is required in ALL environments, not just production."
    );
  }

  const trimmed = secret.trim();

  if (trimmed.length < 64) {
    throw new Error(
      `JWT_SECRET must be at least 64 characters (current: ${trimmed.length}). ` +
      "Use: openssl rand -hex 32 to generate a secure secret."
    );
  }

  return trimmed;
}

/**
 * Generate a unique token ID for revocation tracking
 */
function generateJti(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Add a token to the Redis blacklist for revocation
 */
async function blacklistToken(jti: string, exp: number): Promise<void> {
  try {
    const redis = getRedisClient();
    const ttl = exp - Math.floor(Date.now() / 1000);

    if (ttl > 0) {
      await redis.set(`blacklist:${jti}`, "1", "EX", ttl);
      authLog.info({ jti, ttl }, "Token added to blacklist");
    }
  } catch (err) {
    // Log but don't fail — if Redis is down, tokens will expire naturally
    authLog.error({ err, jti }, "Failed to blacklist token in Redis");
  }
}

/**
 * Check if a token is blacklisted
 */
async function isTokenBlacklisted(jti: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.get(`blacklist:${jti}`);
    return result !== null;
  } catch (err) {
    authLog.error({ err, jti }, "Failed to check token blacklist");
    // Fail open — if Redis is down, allow token (will expire naturally)
    return false;
  }
}

/**
 * Hash a password using Argon2id (memory-hard, GPU-resistant)
 */
export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65536, // 64 MB
    timeCost: 3,
  });
}

/**
 * Verify a password against its hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return await Bun.password.verify(password, hash);
}

/**
 * Generate a secure random token
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString("base64url");
}

/**
 * Create JWT token (access token) with JTI for revocation
 */
export function createAccessToken(payload: Omit<JWTPayload, "iat" | "exp" | "jti">): string {
  const now = Math.floor(Date.now() / 1000);
  const jti = generateJti();

  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + ACCESS_TOKEN_EXPIRY_SEC,
    jti,
  };

  const secret = getJwtSecret();
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify JWT token with blacklist checking
 */
export async function verifyAccessToken(token: string): Promise<JWTPayload | null> {
  try {
    const [headerB64, payloadB64, signature] = token.split(".");
    if (!headerB64 || !payloadB64 || !signature) return null;

    // Verify signature
    const expectedSignature = createHmac("sha256", getJwtSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const sigBuf = Buffer.from(signature, 'base64url');
    const expectedBuf = Buffer.from(expectedSignature, 'base64url');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      authLog.warn({ tokenPrefix: token.slice(0, 20) }, "JWT signature verification failed");
      return null;
    }

    // Parse payload
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as JWTPayload;
    const now = Math.floor(Date.now() / 1000);

    // Check expiration
    if (payload.exp < now) {
      authLog.debug({ jti: payload.jti }, "JWT token expired");
      return null;
    }

    // Check blacklist
    if (payload.jti && await isTokenBlacklisted(payload.jti)) {
      authLog.warn({ jti: payload.jti }, "JWT token is blacklisted");
      return null;
    }

    return payload;
  } catch (err) {
    authLog.debug({ err }, "JWT verification failed");
    return null;
  }
}

/**
 * Revoke an access token immediately (add to blacklist)
 */
export async function revokeAccessToken(jti: string, exp: number): Promise<void> {
  await blacklistToken(jti, exp);
  authLog.info({ jti }, "Access token revoked");
}

/**
 * Create a refresh token and store it in database
 */
export async function createRefreshToken(userId: string): Promise<string> {
  const token = generateToken(32);
  const expiresAt = Date.now() + (REFRESH_TOKEN_EXPIRY_SEC * 1000);

  const db = getDb();
  db.run(
    `INSERT INTO refresh_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    [token, userId, expiresAt, Date.now()]
  );

  return token;
}

/**
 * Verify and consume a refresh token WITH ROTATION
 * Returns the new refresh token if valid
 */
export async function verifyRefreshToken(token: string): Promise<{ userId: string; newToken: string } | null> {
  const db = getDb();

  // Atomic token rotation: SELECT + revoke in a single transaction to prevent
  // race conditions where two concurrent requests reuse the same token.
  const row = db.transaction(() => {
    const found = db.query(
      `SELECT user_id, expires_at, revoked FROM refresh_tokens WHERE token = ?`
    ).get(token) as { user_id: string; expires_at: number; revoked: number } | null;

    if (!found || found.revoked || found.expires_at < Date.now()) {
      return null;
    }

    db.run(`UPDATE refresh_tokens SET revoked = 1 WHERE token = ?`, [token]);
    return found;
  })();

  if (!row) {
    authLog.warn({ tokenPrefix: token.slice(0, 8) }, "Refresh token invalid, revoked, or expired");
    return null;
  }

  // Issue new refresh token (outside transaction — only one winner reaches here)
  const newToken = await createRefreshToken(row.user_id);

  authLog.info({
    userId: row.user_id,
    oldTokenPrefix: token.slice(0, 8),
    newTokenPrefix: newToken.slice(0, 8)
  }, "Refresh token rotated");

  return { userId: row.user_id, newToken };
}

/**
 * Revoke a refresh token
 */
export function revokeRefreshToken(token: string): void {
  const db = getDb();
  db.run(`UPDATE refresh_tokens SET revoked = 1 WHERE token = ?`, [token]);
  authLog.info({ tokenPrefix: token.slice(0, 8) }, "Refresh token revoked");
}

/**
 * Revoke all refresh tokens for a user (for password changes, security events)
 */
export function revokeAllUserTokens(userId: string): void {
  const db = getDb();
  const result = db.run(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`, [userId]);
  authLog.info({ userId, count: result.changes }, "All refresh tokens revoked for user");
}

/**
 * Revoke all tokens for a user (refresh tokens + blacklist all access tokens)
 * This is a SECURITY EVENT — user must reauthenticate
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  // Revoke all refresh tokens
  revokeAllUserTokens(userId);

  // Note: We can't blacklist existing access tokens without their JTIs
  // For complete session revocation, we'd need to store active JTIs per user
  // This is a future enhancement: add a user_jtis table to track active tokens

  authLog.warn({ userId }, "All user sessions revoked");
}

/**
 * Create a new user
 */
export async function createUser(
  username: string,
  password: string,
  isAdmin: boolean = false
): Promise<User | { error: string }> {
  const db = getDb();

  // Check if username exists
  const existing = db.query(`SELECT id FROM users WHERE username = ?`).get(username);
  if (existing) {
    return { error: "Username already exists" };
  }

  // Validate username
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return { error: "Username must be 3-32 characters, alphanumeric and underscores only" };
  }

  // Validate password
  if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return { error: "Password must be at least 12 characters with uppercase, lowercase, and a digit" };
  }
  if (!/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?`~]/.test(password)) {
    return { error: "Password must contain at least one special character" };
  }

  const id = generateToken(16);
  const passwordHash = await hashPassword(password);
  const now = Date.now();

  try {
    db.run(
      `INSERT INTO users (id, username, password_hash, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, username, passwordHash, isAdmin ? 1 : 0, now, now]
    );

    authLog.info({ userId: id, username }, "User created");

    return {
      id,
      username,
      isAdmin,
      createdAt: now,
      updatedAt: now,
    };
  } catch (err) {
    authLog.error({ err, username }, "Failed to create user");
    return { error: "Failed to create user" };
  }
}

/**
 * Authenticate a user with username and password
 */
export async function authenticateUser(
  username: string,
  password: string
): Promise<User | null> {
  const db = getDb();

  const row = db.query(
    `SELECT id, username, password_hash, is_admin, created_at, updated_at
     FROM users WHERE username = ?`
  ).get(username) as { id: string; username: string; password_hash: string; is_admin: number; created_at: number; updated_at: number } | null;

  if (!row) {
    // Perform dummy hash to prevent timing attacks
    await hashPassword(password);
    return null;
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;

  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GUEST_USERNAME = "guest";
const LOCAL_USERNAME = "local";

/**
 * Get or create the single local user.
 * This is the system user for no-auth deployments — all sessions belong to this user.
 */
export async function getOrCreateLocalUser(): Promise<User> {
  const db = getDb();
  const row = db.query(
    `SELECT id, username, is_admin, created_at, updated_at FROM users WHERE username = ?`
  ).get(LOCAL_USERNAME) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | null;
  if (row) {
    return {
      id: row.id,
      username: row.username,
      isAdmin: !!row.is_admin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  // Create without password — no login required
  const id = "local";
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO users (id, username, password_hash, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, LOCAL_USERNAME, "", 1, now, now]
  );
  authLog.info({ userId: id }, "Local system user created");
  return { id, username: LOCAL_USERNAME, isAdmin: true, createdAt: now, updatedAt: now };
}

/**
 * Get or create the single guest user (no sign-in required).
 * Used when the app allows anonymous access.
 */
export async function getOrCreateGuestUser(): Promise<User> {
  const db = getDb();
  const row = db.query(
    `SELECT id, username, is_admin, created_at, updated_at FROM users WHERE username = ?`
  ).get(GUEST_USERNAME) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | null;
  if (row) {
    return {
      id: row.id,
      username: row.username,
      isAdmin: !!row.is_admin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  const result = await createUser(
    GUEST_USERNAME,
    randomBytes(16).toString("base64url").slice(0, 16),
    false
  );
  if ("error" in result) {
    if (result.error === "Username already exists") {
      const row = db.query(
        `SELECT id, username, is_admin, created_at, updated_at FROM users WHERE username = ?`
      ).get(GUEST_USERNAME) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | null;
      if (row) {
        return { id: row.id, username: row.username, isAdmin: !!row.is_admin, createdAt: row.created_at, updatedAt: row.updated_at };
      }
    }
    authLog.error({ err: result.error }, "Failed to create guest user");
    throw new Error("Guest user not available");
  }
  authLog.info({ userId: result.id }, "Guest user created");
  return result;
}

/**
 * Get user by ID
 */
export function getUserById(id: string): User | null {
  const db = getDb();

  const row = db.query(
    `SELECT id, username, is_admin, created_at, updated_at FROM users WHERE id = ?`
  ).get(id) as { id: string; username: string; is_admin: number; created_at: number; updated_at: number } | null;

  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Change user password
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  if (newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return { success: false, error: "Password must be at least 12 characters with uppercase, lowercase, and a digit" };
  }
  if (!/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?`~]/.test(newPassword)) {
    return { success: false, error: "Password must contain at least one special character" };
  }

  const db = getDb();

  const row = db.query(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as { password_hash: string } | null;
  if (!row) return { success: false, error: "User not found" };

  const valid = await verifyPassword(oldPassword, row.password_hash);
  if (!valid) return { success: false, error: "Invalid current password" };

  const newHash = await hashPassword(newPassword);
  db.run(
    `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
    [newHash, Date.now(), userId]
  );

  // Revoke all refresh tokens for security
  revokeAllUserTokens(userId);

  authLog.info({ userId }, "Password changed");
  return { success: true };
}

/**
 * Clean up expired refresh tokens (call periodically)
 */
export function cleanupExpiredTokens(): number {
  const db = getDb();
  const result = db.run(
    `DELETE FROM refresh_tokens WHERE expires_at < ?`,
    [Date.now()]
  );
  return result.changes;
}

/**
 * Clean up expired blacklist entries from Redis (call periodically)
 */
export async function cleanupBlacklist(): Promise<void> {
  try {
    const redis = getRedisClient();
    // Redis handles expiration automatically via EX
    // This is just a health check function
    const keys = await redis.keys("blacklist:*");
    authLog.debug({ count: keys.length }, "Blacklist entries active");
  } catch (err) {
    authLog.error({ err }, "Failed to check blacklist status");
  }
}
