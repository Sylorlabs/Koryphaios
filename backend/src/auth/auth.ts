// Real Authentication System for Koryphaios
// JWT-based auth with refresh tokens and proper password hashing

import { randomBytes, createHmac } from "node:crypto";
import { getDb } from "../db/sqlite";
import { authLog } from "../logger";
import type { User, JWTPayload } from "./types";

const ACCESS_TOKEN_EXPIRY_SEC = 15 * 60;
const REFRESH_TOKEN_EXPIRY_SEC = 7 * 24 * 60 * 60;

/** Lazy JWT secret: required in production (min 32 chars), random fallback only in development. */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!secret || typeof secret !== "string" || secret.trim().length < 32) {
      throw new Error(
        "JWT_SECRET must be set in production (min 32 characters). Set it in .env or environment."
      );
    }
    return secret.trim();
  }
  return secret?.trim() && secret.length >= 32 ? secret.trim() : randomBytes(64).toString("hex");
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
 * Create JWT token (access token)
 */
export function createAccessToken(payload: Omit<JWTPayload, "iat" | "exp">): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + ACCESS_TOKEN_EXPIRY_SEC,
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
 * Verify JWT token
 */
export function verifyAccessToken(token: string): JWTPayload | null {
  try {
    const [headerB64, payloadB64, signature] = token.split(".");
    if (!headerB64 || !payloadB64 || !signature) return null;
    
    // Verify signature
    const expectedSignature = createHmac("sha256", getJwtSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (signature !== expectedSignature) return null;
    
    // Parse payload
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as JWTPayload;
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    
    return payload;
  } catch (err) {
    authLog.debug({ err }, "JWT verification failed");
    return null;
  }
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
 * Verify and consume a refresh token
 */
export function verifyRefreshToken(token: string): { userId: string } | null {
  const db = getDb();
  
  // Get token record
  const row = db.query(
    `SELECT user_id, expires_at, revoked FROM refresh_tokens WHERE token = ?`
  ).get(token) as any;
  
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at < Date.now()) return null;
  
  return { userId: row.user_id };
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
 * Revoke all refresh tokens for a user
 */
export function revokeAllUserTokens(userId: string): void {
  const db = getDb();
  db.run(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`, [userId]);
  authLog.info({ userId }, "All refresh tokens revoked for user");
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
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters" };
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
  ).get(username) as any;
  
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
  ).get(LOCAL_USERNAME) as any;
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
  ).get(GUEST_USERNAME) as any;
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
      ).get(GUEST_USERNAME) as any;
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
  ).get(id) as any;
  
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
  if (newPassword.length < 8) {
    return { success: false, error: "Password must be at least 8 characters" };
  }
  
  const db = getDb();
  
  const row = db.query(`SELECT password_hash FROM users WHERE id = ?`).get(userId) as any;
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
