// Authentication routes for Koryphaios

import type { APIResponse } from "@koryphaios/shared";
import {
  createUser,
  authenticateUser,
  createAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  changePassword,
  getUserById,
  revokeAllUserTokens,
} from "../auth";
import { requireAuth, SESSION_COOKIE_NAME, REFRESH_COOKIE_NAME } from "../middleware";
import { authLog } from "../logger";
import { sanitizeString } from "../security";
import { getAllowRegistration } from "../config-schema";

const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 128;
const ACCESS_TOKEN_MAX_AGE_SEC = 15 * 60; // 15 minutes

function isSecureRequest(req: Request): boolean {
  try {
    const url = new URL(req.url);
    if (url.protocol === "https:") return true;
  } catch {
    // ignore
  }
  return req.headers.get("x-forwarded-proto") === "https";
}

function buildSessionCookie(accessToken: string, req: Request): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(accessToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ACCESS_TOKEN_MAX_AGE_SEC}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days

function getCookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  const parts = raw.split(";").map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value) || null;
      } catch {
        return value || null;
      }
    }
  }
  return null;
}

function buildRefreshCookie(refreshToken: string, req: Request): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${REFRESH_MAX_AGE_SEC}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function buildClearRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

async function parseBody(req: Request): Promise<{ ok: true; data: any } | { ok: false; res: Response }> {
  try {
    const data = await req.json();
    return { ok: true, data };
  } catch {
    return { ok: false, res: json({ ok: false, error: "Invalid or missing JSON body" }, 400) };
  }
}

/**
 * Handle POST /api/auth/register
 */
export async function handleRegister(req: Request): Promise<Response> {
  if (!getAllowRegistration()) {
    return json({ ok: false, error: "Registration is disabled" }, 403);
  }
  try {
    const parsed = await parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const username = sanitizeString(body.username, MAX_USERNAME_LENGTH);
    const password = sanitizeString(body.password, MAX_PASSWORD_LENGTH);
    
    if (!username || !password) {
      return json({ ok: false, error: "Username and password are required" }, 400);
    }
    
    const result = await createUser(username, password);
    
    if ("error" in result) {
      return json({ ok: false, error: result.error }, 400);
    }
    
    authLog.info({ userId: result.id, username }, "User registered");
    
    return json({
      ok: true,
      data: {
        user: {
          id: result.id,
          username: result.username,
          isAdmin: result.isAdmin,
          createdAt: result.createdAt,
        },
      },
    }, 201);
  } catch (err: any) {
    authLog.error({ err }, "Registration error");
    return json({ ok: false, error: "Registration failed" }, 500);
  }
}

/**
 * Handle POST /api/auth/login
 */
export async function handleLogin(req: Request): Promise<Response> {
  try {
    const parsed = await parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const username = sanitizeString(body.username, MAX_USERNAME_LENGTH);
    const password = sanitizeString(body.password, MAX_PASSWORD_LENGTH);
    
    if (!username || !password) {
      return json({ ok: false, error: "Username and password are required" }, 400);
    }
    
    const user = await authenticateUser(username, password);
    
    if (!user) {
      // Add artificial delay to prevent timing attacks
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      return json({ ok: false, error: "Invalid username or password" }, 401);
    }
    
    // Create tokens
    const accessToken = createAccessToken({
      sub: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      jti: crypto.randomUUID(),
    });
    
    const refreshToken = await createRefreshToken(user.id);
    
    authLog.info({ userId: user.id }, "User logged in");

    const res = json({
      ok: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresIn: ACCESS_TOKEN_MAX_AGE_SEC,
      },
    });
    res.headers.append("Set-Cookie", buildSessionCookie(accessToken, req));
    res.headers.append("Set-Cookie", buildRefreshCookie(refreshToken, req));
    return res;
  } catch (err: any) {
    authLog.error({ err }, "Login error");
    return json({ ok: false, error: "Login failed" }, 500);
  }
}

/**
 * Handle POST /api/auth/refresh
 * Accepts refresh token from cookie (koryphaios_refresh) or body (for programmatic clients).
 */
export async function handleRefresh(req: Request): Promise<Response> {
  try {
    let refreshToken = getCookieValue(req, REFRESH_COOKIE_NAME);
    if (!refreshToken) {
      const parsed = await parseBody(req);
      if (!parsed.ok) return parsed.res;
      refreshToken = sanitizeString(parsed.data?.refreshToken, 256);
    }
    if (!refreshToken) {
      return json({ ok: false, error: "Refresh token is required (cookie or body)" }, 400);
    }

    const tokenData = verifyRefreshToken(refreshToken);
    
    if (!tokenData) {
      return json({ ok: false, error: "Invalid or expired refresh token" }, 401);
    }
    
    const user = getUserById(tokenData.userId);
    if (!user) {
      return json({ ok: false, error: "User not found" }, 401);
    }
    
    // Create new access token
    const accessToken = createAccessToken({
      sub: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      jti: crypto.randomUUID(),
    });
    
    authLog.info({ userId: user.id }, "Token refreshed");

    const newRefreshToken = await createRefreshToken(user.id);
    revokeRefreshToken(refreshToken);

    const res = json({
      ok: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          isAdmin: user.isAdmin,
        },
        expiresIn: ACCESS_TOKEN_MAX_AGE_SEC,
      },
    });
    res.headers.append("Set-Cookie", buildSessionCookie(accessToken, req));
    res.headers.append("Set-Cookie", buildRefreshCookie(newRefreshToken, req));
    return res;
  } catch (err: any) {
    authLog.error({ err }, "Token refresh error");
    return json({ ok: false, error: "Token refresh failed" }, 500);
  }
}

/**
 * Handle POST /api/auth/logout
 * Body is optional (empty body = local logout only; no refresh token to revoke).
 */
export async function handleLogout(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({} as { refreshToken?: string }));
    const refreshToken = sanitizeString(body?.refreshToken, 256);

    if (refreshToken) {
      revokeRefreshToken(refreshToken);
    }

    const res = json({ ok: true });
    res.headers.append("Set-Cookie", buildClearSessionCookie());
    res.headers.append("Set-Cookie", buildClearRefreshCookie());
    return res;
  } catch (err: any) {
    authLog.error({ err }, "Logout error");
    return json({ ok: false, error: "Logout failed" }, 500);
  }
}

/**
 * Handle POST /api/auth/logout-all
 */
export async function handleLogoutAll(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  
  try {
    revokeAllUserTokens(auth.user.id);
    
    authLog.info({ userId: auth.user.id }, "Logged out from all devices");
    return json({ ok: true });
  } catch (err: any) {
    authLog.error({ err, userId: auth.user.id }, "Logout all error");
    return json({ ok: false, error: "Logout failed" }, 500);
  }
}

/**
 * Handle GET /api/auth/me
 */
export async function handleMe(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  
  return json({
    ok: true,
    data: {
      user: {
        id: auth.user.id,
        username: auth.user.username,
        isAdmin: auth.user.isAdmin,
        createdAt: auth.user.createdAt,
      },
    },
  });
}

/**
 * Handle POST /api/auth/change-password
 */
export async function handleChangePassword(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  
  try {
    const parsed = await parseBody(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const oldPassword = sanitizeString(body.oldPassword, MAX_PASSWORD_LENGTH);
    const newPassword = sanitizeString(body.newPassword, MAX_PASSWORD_LENGTH);

    if (!oldPassword || !newPassword) {
      return json({ ok: false, error: "Old and new passwords are required" }, 400);
    }

    const result = await changePassword(auth.user.id, oldPassword, newPassword);
    
    if (!result.success) {
      return json({ ok: false, error: result.error }, 400);
    }
    
    return json({ ok: true, data: { message: "Password changed successfully" } });
  } catch (err: any) {
    authLog.error({ err, userId: auth.user.id }, "Change password error");
    return json({ ok: false, error: "Password change failed" }, 500);
  }
}

// Helper function
function json(data: APIResponse, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
