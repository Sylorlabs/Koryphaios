// Authentication middleware for Koryphaios
// Validates JWT tokens and API keys, extracts user context

import { AuthContext, AuthenticatedRequest, AuthMode } from './types';
export type { AuthContext, AuthenticatedRequest } from './types';
import { getTokenService } from './token-service';
import { getSessionStore } from './session-store';
import { authLog } from '../logger';

// Get auth mode from environment
function getAuthMode(): AuthMode {
  const mode = process.env.KORYPHAIOS_AUTH_MODE as AuthMode | undefined;
  if (!mode) {
    throw new Error(
      "FATAL SECURITY ERROR: KORYPHAIOS_AUTH_MODE is not defined. You must explicitly configure an authentication mode (e.g., 'jwt', 'api-key', or 'none' for local dev only). Failing closed.",
    );
  }
  return mode;
}

/**
 * Extract bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;

  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;

  return token.trim() || null;
}

/**
 * Extract API key from header or query parameter
 */
function extractApiKey(req: Request): string | null {
  // Check header first
  const headerKey = req.headers.get('x-api-key');
  if (headerKey) return headerKey;

  // Check query parameter
  const url = new URL(req.url);
  const queryKey = url.searchParams.get('api_key');
  if (queryKey) return queryKey;

  return null;
}

/**
 * Main authentication middleware
 * Validates tokens/api keys and returns auth context
 */
export async function requireAuth(req: Request): Promise<AuthenticatedRequest> {
  const mode = getAuthMode();

  // No authentication required
  if (mode === 'none') {
    return { sessionId: 'system' };
  }

  // API Key authentication
  if (mode === 'api-key') {
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      authLog.warn({ path: new URL(req.url).pathname }, 'API key missing');
      throw new Error('API key required');
    }

    const tokenService = getTokenService();
    if (!tokenService.validateApiKey(apiKey)) {
      authLog.warn({ path: new URL(req.url).pathname }, 'Invalid API key');
      throw new Error('Invalid API key');
    }

    return {
      user: {
        id: 'api-user',
        name: 'API User',
        role: 'user',
        createdAt: Date.now(),
      },
      sessionId: `api_${Date.now()}`,
    };
  }

  // JWT authentication
  if (mode === 'jwt') {
    const token = extractBearerToken(req);

    if (!token) {
      authLog.warn({ path: new URL(req.url).pathname }, 'Bearer token missing');
      throw new Error('Bearer token required');
    }

    const tokenService = getTokenService();
    const context = tokenService.validateAccessToken(token);

    // Verify session is still active
    const sessionStore = getSessionStore();
    const session = await sessionStore.get(context.sessionId);

    if (!session) {
      authLog.warn({ sessionId: context.sessionId }, 'Session not found');
      throw new Error('Session expired or invalid');
    }

    // Update last activity
    await sessionStore.touch(context.sessionId);

    authLog.debug(
      { userId: context.userId, sessionId: context.sessionId },
      'Authenticated request',
    );

    return {
      user: context.user,
      sessionId: context.sessionId,
    };
  }

  throw new Error(`Unknown auth mode: ${mode}`);
}

/**
 * Optional authentication - doesn't throw if no auth provided
 */
export async function optionalAuth(req: Request): Promise<AuthenticatedRequest | null> {
  try {
    return await requireAuth(req);
  } catch {
    return null;
  }
}

/**
 * Admin-only middleware
 */
export async function requireAdmin(req: Request): Promise<AuthenticatedRequest> {
  const auth = await requireAuth(req);

  if (auth.user?.role !== 'admin') {
    throw new Error('Admin access required');
  }

  return auth;
}

/**
 * Create an auth middleware function for server routes
 * Returns 401 response if authentication fails
 */
export function createAuthMiddleware(
  options: {
    requireAdmin?: boolean;
    optional?: boolean;
  } = {},
) {
  return async (req: Request): Promise<AuthenticatedRequest | Response> => {
    try {
      const auth = options.requireAdmin ? await requireAdmin(req) : await requireAuth(req);
      return auth;
    } catch (error: any) {
      if (options.optional) {
        return { sessionId: 'anonymous' };
      }

      authLog.warn(
        { path: new URL(req.url).pathname, error: error.message },
        'Authentication failed',
      );

      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Authentication required',
          message: error.message,
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': getAuthMode() === 'jwt' ? 'Bearer' : 'ApiKey',
          },
        },
      );
    }
  };
}

/**
 * Extract client IP from request
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

/**
 * Extract user agent from request
 */
export function getUserAgent(req: Request): string | undefined {
  return req.headers.get('user-agent') || undefined;
}
