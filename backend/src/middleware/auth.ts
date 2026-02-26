// Authentication middleware for Koryphaios
// Supports local no-auth mode for development and token auth mode for hardened deployments.

import type { User } from "../auth/types";
import {
  getOrCreateLocalUser,
  verifyAccessToken,
  getUserById,
} from "../auth";
import { authLog } from "../logger";

export interface AuthenticatedRequest {
  user: User;
  token: string;
}

export const SESSION_COOKIE_NAME = "koryphaios_session";
export const REFRESH_COOKIE_NAME = "koryphaios_refresh";

type AuthMode = "local" | "token";

function getAuthMode(): AuthMode {
  const configured = process.env.KORYPHAIOS_AUTH_MODE?.toLowerCase();
  if (configured === "local" || configured === "token") return configured;
  return process.env.NODE_ENV === "production" ? "token" : "local";
}

function parseCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;

  const parts = raw.split(";").map((p) => p.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx) !== name) continue;
    const value = part.slice(idx + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function getRequestToken(req: Request): string | null {
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  return extractSessionToken(req);
}

/**
 * Require authentication for a route handler.
 * Defaults to token auth in production and local user mode in development.
 */
export async function requireAuth(req: Request): Promise<AuthenticatedRequest | { error: Response }> {
  const mode = getAuthMode();

  if (mode === "token") {
    const token = getRequestToken(req);
    if (!token) {
      return {
        error: new Response(
          JSON.stringify({ ok: false, error: "Authentication required" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    const payload = verifyAccessToken(token);
    if (!payload) {
      return {
        error: new Response(
          JSON.stringify({ ok: false, error: "Invalid or expired token" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    const user = getUserById(payload.sub);
    if (!user) {
      return {
        error: new Response(
          JSON.stringify({ ok: false, error: "User not found" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    return { user, token };
  }

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
 * Require admin privileges.
 */
export async function requireAdmin(req: Request): Promise<AuthenticatedRequest | { error: Response }> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth;
  if (!auth.user.isAdmin) {
    return {
      error: new Response(
        JSON.stringify({ ok: false, error: "Admin access required" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
    };
  }
  return auth;
}

/**
 * Optional authentication.
 */
export async function optionalAuth(req: Request): Promise<AuthenticatedRequest | null> {
  if (getAuthMode() === "token") {
    const token = getRequestToken(req);
    if (!token) return null;
    const payload = verifyAccessToken(token);
    if (!payload) return null;
    const user = getUserById(payload.sub);
    if (!user) return null;
    return { user, token };
  }

  try {
    const user = await getOrCreateLocalUser();
    return { user, token: "" };
  } catch {
    return null;
  }
}

// Retained for WebSocket upgrade compatibility
export async function getUserIdFromToken(token: string): Promise<string | null> {
  if (getAuthMode() === "local") {
    try {
      const user = await getOrCreateLocalUser();
      return user.id;
    } catch {
      return null;
    }
  }

  const payload = verifyAccessToken(token);
  return payload?.sub ?? null;
}

export function extractSessionToken(req: Request): string | null {
  return parseCookie(req, SESSION_COOKIE_NAME);
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

/** @deprecated Use getOrCreateLocalUser directly in local mode */
