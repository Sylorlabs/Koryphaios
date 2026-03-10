// Authentication middleware for Koryphaios
// NOTE: Koryphaios operates WITHOUT user accounts.
// This file is retained for API key authentication (provider credentials) only.

import { authLog } from "../logger";

// Empty interface - no user authentication
export interface AuthenticatedRequest {
  // No user context - Koryphaios doesn't use accounts
}

// Cookie names retained for backward compatibility but not used
export const SESSION_COOKIE_NAME = "koryphaios_session";
export const REFRESH_COOKIE_NAME = "koryphaios_refresh";

/**
 * Extract bearer token from Authorization header
 * Used for provider API key authentication, not user auth
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/**
 * Extract session token from cookie
 * NOTE: Not used - Koryphaios doesn't have user sessions
 */
export function extractSessionToken(req: Request): string | null {
  return null;
}

/**
 * CSRF validation - NO LONGER NEEDED since there are no user sessions
 * This function always returns null (no CSRF error)
 */
export function requireCsrf(_req: Request): Response | null {
  // CSRF protection not needed - no user accounts
  return null;
}

/**
 * getUserIdFromToken - Returns a fixed system ID
 * Since there are no user accounts, all requests use a fixed "system" user ID
 */
export async function getUserIdFromToken(_token: string): Promise<string> {
  return "system";
}

/**
 * requireAuth - NO LONGER NEEDED
 * Koryphaios doesn't require user authentication
 * All endpoints are accessible without user login
 */
export async function requireAuth(_req: Request): Promise<AuthenticatedRequest> {
  return {}; // No auth required
}

/**
 * requireAdmin - NO LONGER NEEDED
 * Koryphaios doesn't have user roles or admin privileges
 */
export async function requireAdmin(_req: Request): Promise<AuthenticatedRequest> {
  return {}; // No admin check needed
}

/**
 * optionalAuth - Returns empty context
 * No user authentication in Koryphaios
 */
export async function optionalAuth(_req: Request): Promise<AuthenticatedRequest | null> {
  return {}; // No user context
}
