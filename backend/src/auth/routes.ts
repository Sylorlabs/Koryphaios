// Authentication routes - Login, logout, token refresh

import { getTokenService } from './token-service';
import { getSessionStore } from './session-store';
import { LoginCredentials, AuthError } from './types';
import { authLog } from '../logger';
import { getClientIp, getUserAgent } from './middleware';

// Simple in-memory user store (in production, use a real database)
// Passwords should be hashed with bcrypt/argon2
const USERS = new Map<string, { name: string; password: string; role: 'user' | 'admin' }>();

// Initialize default admin user if not exists
export function initializeDefaultUser(): void {
  if (!USERS.has('admin')) {
    const defaultPassword = process.env.KORYPHAIOS_DEFAULT_PASSWORD || 'changeme';
    USERS.set('admin', {
      name: 'Administrator',
      password: defaultPassword, // In production, hash this!
      role: 'admin',
    });
    authLog.warn(
      { username: 'admin' },
      'Created default admin user. Change the password immediately!',
    );
  }
}

// Validate credentials (in production, use bcrypt.compare)
async function validateCredentials(creds: LoginCredentials): Promise<{
  valid: boolean;
  user?: { id: string; name: string; role: 'user' | 'admin' };
}> {
  const user = USERS.get(creds.username);
  if (!user) {
    return { valid: false };
  }

  // In production: const match = await bcrypt.compare(creds.password, user.password);
  const match = creds.password === user.password;

  if (!match) {
    return { valid: false };
  }

  return {
    valid: true,
    user: {
      id: creds.username,
      name: user.name,
      role: user.role,
    },
  };
}

/**
 * POST /api/auth/login
 * Authenticate user and return tokens
 */
export async function handleLogin(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as LoginCredentials;

    if (!body.username || !body.password) {
      return new Response(JSON.stringify({ ok: false, error: 'Username and password required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const validation = await validateCredentials(body);

    if (!validation.valid) {
      authLog.warn({ username: body.username }, 'Failed login attempt');
      return new Response(JSON.stringify({ ok: false, error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = validation.user!;
    const tokenService = getTokenService();
    const sessionStore = getSessionStore();

    // Create session
    const now = Date.now();
    const refreshExpiry = (tokenService as any).config?.refreshTokenExpiry || 604800;

    const session = await sessionStore.create({
      userId: user.id,
      userName: user.name,
      createdAt: now,
      expiresAt: now + refreshExpiry * 1000,
      lastActivityAt: now,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    // Generate tokens
    const tokens = tokenService.generateTokenPair(user.id, user.name, user.role, session.id);

    authLog.info({ userId: user.id, sessionId: session.id }, 'User logged in');

    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
        },
        ...tokens,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          // Set refresh token as httpOnly cookie
          'Set-Cookie': `refresh_token=${tokens.refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${refreshExpiry}`,
        },
      },
    );
  } catch (error: any) {
    authLog.error({ error: error.message }, 'Login error');
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/auth/logout
 * Revoke current session
 */
export async function handleLogout(req: Request): Promise<Response> {
  try {
    // Extract token to get session ID
    const authHeader = req.headers.get('authorization');
    let sessionId: string | null = null;

    if (authHeader) {
      const token = authHeader.split(' ')[1];
      if (token) {
        const tokenService = getTokenService();
        try {
          const context = tokenService.validateAccessToken(token);
          sessionId = context.sessionId;
        } catch {
          // Token invalid/expired, still allow logout
        }
      }
    }

    if (sessionId) {
      const sessionStore = getSessionStore();
      await sessionStore.delete(sessionId);
      authLog.info({ sessionId }, 'Session revoked');
    }

    return new Response(JSON.stringify({ ok: true, message: 'Logged out successfully' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Clear refresh cookie
        'Set-Cookie': `refresh_token=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=0`,
      },
    });
  } catch (error: any) {
    authLog.error({ error: error.message }, 'Logout error');
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/auth/refresh
 * Refresh access token using refresh token
 */
export async function handleRefresh(req: Request): Promise<Response> {
  try {
    // Get refresh token from cookie or body
    const cookieHeader = req.headers.get('cookie');
    let refreshToken: string | null = null;

    if (cookieHeader) {
      const match = cookieHeader.match(/refresh_token=([^;]+)/);
      if (match) {
        refreshToken = match[1];
      }
    }

    if (!refreshToken) {
      const body = await req.json().catch(() => ({}));
      refreshToken = body.refreshToken;
    }

    if (!refreshToken) {
      return new Response(JSON.stringify({ ok: false, error: 'Refresh token required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const tokenService = getTokenService();
    const sessionStore = getSessionStore();

    // Validate refresh token
    const { userId, sessionId } = tokenService.validateRefreshToken(refreshToken);

    // Verify session still exists
    const session = await sessionStore.get(sessionId);
    if (!session) {
      return new Response(JSON.stringify({ ok: false, error: 'Session expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate new tokens
    const tokens = tokenService.generateTokenPair(
      userId,
      session.userName,
      'user', // Could look up from user store
      sessionId,
    );

    // Update session expiry
    const refreshExpiry = (tokenService as any).config?.refreshTokenExpiry || 604800;
    await sessionStore.update(sessionId, {
      expiresAt: Date.now() + refreshExpiry * 1000,
    });

    authLog.debug({ userId, sessionId }, 'Tokens refreshed');

    return new Response(
      JSON.stringify({
        ok: true,
        ...tokens,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `refresh_token=${tokens.refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=${refreshExpiry}`,
        },
      },
    );
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      return new Response(JSON.stringify({ ok: false, error: 'Refresh token expired' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    authLog.error({ error: error.message }, 'Token refresh error');
    return new Response(JSON.stringify({ ok: false, error: 'Invalid refresh token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GET /api/auth/me
 * Get current user info
 */
export async function handleGetMe(
  req: Request,
  auth: { user?: { id: string; name: string; role: string } },
): Promise<Response> {
  if (!auth.user) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      user: auth.user,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * POST /api/auth/change-password
 * Change user password
 */
export async function changePassword(
  req: Request,
  auth: { user?: { id: string } },
): Promise<Response> {
  return handleChangePassword(req, auth);
}

export async function handleChangePassword(
  req: Request,
  auth: { user?: { id: string } },
): Promise<Response> {
  if (!auth.user) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = (await req.json()) as { currentPassword: string; newPassword: string };

    if (!body.currentPassword || !body.newPassword) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Current and new password required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (body.newPassword.length < 8) {
      return new Response(
        JSON.stringify({ ok: false, error: 'New password must be at least 8 characters' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const user = USERS.get(auth.user.id);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify current password (in production: bcrypt.compare)
    if (user.password !== body.currentPassword) {
      return new Response(JSON.stringify({ ok: false, error: 'Current password incorrect' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update password (in production: bcrypt.hash)
    user.password = body.newPassword;

    authLog.info({ userId: auth.user.id }, 'Password changed');

    return new Response(JSON.stringify({ ok: true, message: 'Password changed successfully' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    authLog.error({ error: error.message }, 'Password change error');
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * GET /api/auth/sessions
 * List active sessions for current user
 */
export async function handleListSessions(
  req: Request,
  auth: { user?: { id: string } },
): Promise<Response> {
  if (!auth.user) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const sessionStore = getSessionStore();
    const sessions = await sessionStore.getByUserId(auth.user.id);

    return new Response(
      JSON.stringify({
        ok: true,
        sessions: sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
          expiresAt: s.expiresAt,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    authLog.error({ error: error.message }, 'List sessions error');
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session
 */
export async function handleRevokeSession(
  req: Request,
  auth: { user?: { id: string; role: string } },
  sessionId: string,
): Promise<Response> {
  if (!auth.user) {
    return new Response(JSON.stringify({ ok: false, error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const sessionStore = getSessionStore();
    const session = await sessionStore.get(sessionId);

    if (!session) {
      return new Response(JSON.stringify({ ok: false, error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Users can only revoke their own sessions, unless admin
    if (session.userId !== auth.user.id && auth.user.role !== 'admin') {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await sessionStore.delete(sessionId);

    authLog.info({ sessionId, revokedBy: auth.user.id }, 'Session revoked');

    return new Response(JSON.stringify({ ok: true, message: 'Session revoked' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    authLog.error({ error: error.message }, 'Revoke session error');
    return new Response(JSON.stringify({ ok: false, error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
