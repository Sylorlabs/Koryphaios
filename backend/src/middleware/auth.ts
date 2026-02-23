// Authentication middleware for Koryphaios
// No account required: requireAuth always returns the local system user.

import type { User } from "../auth/types";
import { getOrCreateLocalUser } from "../auth";
import { authLog } from "../logger";

export interface AuthenticatedRequest {
  user: User;
  token: string;
}

/**
 * Require authentication for a route handler.
 * This app requires no login — always resolves to the local system user.
 */
export async function requireAuth(_req: Request): Promise<AuthenticatedRequest | { error: Response }> {
  try {
    const user = await getOrCreateLocalUser();
    return { user, token: "" };
  } catch (err: any) {
    authLog.error({ err }, "Local user resolution failed");
    return {
      error: new Response(
        JSON.stringify({ ok: false, error: "Service unavailable (local user)" }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      ),
    };
  }
}

/**
 * Require admin privileges — always satisfied since local user is admin.
 */
export async function requireAdmin(req: Request): Promise<AuthenticatedRequest | { error: Response }> {
  return requireAuth(req);
}

/**
 * Optional authentication — returns local user context.
 */
export async function optionalAuth(_req: Request): Promise<AuthenticatedRequest | null> {
  try {
    const user = await getOrCreateLocalUser();
    return { user, token: "" };
  } catch {
    return null;
  }
}

// Retained for WebSocket upgrade compatibility
export async function getUserIdFromToken(_token: string): Promise<string | null> {
  try {
    const user = await getOrCreateLocalUser();
    return user.id;
  } catch {
    return null;
  }
}

export function extractSessionToken(_req: Request): string | null {
  return null;
}

export function extractBearerToken(_req: Request): string | null {
  return null;
}

/** @deprecated Use getOrCreateLocalUser directly */
export const SESSION_COOKIE_NAME = "koryphaios_session";
export const REFRESH_COOKIE_NAME = "koryphaios_refresh";
