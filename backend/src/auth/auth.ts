// Koryphaios Auth Module
// NOTE: Koryphaios operates WITHOUT user accounts.
// This file is retained for provider credential utilities only.

import { randomBytes } from "node:crypto";
import { authLog } from "../logger";

// ============================================================================
// Token Generation (for provider credentials, NOT user auth)
// ============================================================================

/**
 * Generate a cryptographically random token
 * Used for generating provider API keys or other secure tokens
 */
export function generateToken(length: number = 32): string {
  return randomBytes(length).toString("base64url");
}

// ============================================================================
// Type Exports (for backward compatibility)
// ============================================================================

export type { User, JWTPayload } from "./types";

// ============================================================================
// Deprecated/Removed Functions
// ============================================================================

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function hashPassword(_password: string): Promise<string> {
  throw new Error("User authentication is not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function verifyPassword(_password: string, _hash: string): Promise<boolean> {
  throw new Error("User authentication is not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export function createAccessToken(_payload: unknown): string {
  throw new Error("User authentication is not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function verifyAccessToken(_token: string): Promise<null> {
  return null; // No user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function createRefreshToken(_userId: string): Promise<string> {
  throw new Error("User authentication is not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function verifyRefreshToken(_token: string): Promise<null> {
  return null; // No user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export function revokeRefreshToken(_token: string): void {
  // No-op - no user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export function revokeAllUserTokens(_userId: string): void {
  // No-op - no user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function revokeAllUserSessions(_userId: string): Promise<void> {
  // No-op - no user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function createUser(_username: string, _password: string, _isAdmin?: boolean): Promise<never> {
  throw new Error("User accounts are not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function authenticateUser(_username: string, _password: string): Promise<null> {
  return null; // No user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function getOrCreateLocalUser(): Promise<never> {
  throw new Error("User accounts are not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function getOrCreateGuestUser(): Promise<never> {
  throw new Error("User accounts are not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export function getUserById(_id: string): null {
  return null; // No user auth
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function changePassword(_userId: string, _oldPassword: string, _newPassword: string): Promise<never> {
  throw new Error("User accounts are not supported in Koryphaios");
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export function cleanupExpiredTokens(): number {
  return 0; // No user auth, no tokens to clean up
}

/**
 * @deprecated Koryphaios doesn't use user accounts
 */
export async function cleanupBlacklist(): Promise<void> {
  // No-op - no user auth
}

// JTI tracking, refresh tokens, etc. - all removed
export async function trackActiveJti(): Promise<void> {
  // No-op - no user auth
}

export async function createAccessTokenWithTracking(): Promise<string> {
  throw new Error("User authentication is not supported in Koryphaios");
}

export async function revokeAccessToken(): Promise<void> {
  // No-op - no user auth
}
