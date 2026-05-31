// Authentication middleware for Koryphaios
// Re-exports from the auth module for backward compatibility

// Export all types from auth/types
export type {
  AuthMode,
  User,
  AuthContext,
  JWTPayload,
  TokenPair,
  Session,
  LoginCredentials,
  AuthConfig,
  AuthenticatedRequest,
} from '../auth/types';

// Export error classes
export {
  AuthError,
  TokenExpiredError,
  InvalidTokenError,
  InvalidCredentialsError,
  SessionNotFoundError,
} from '../auth/types';

// Export middleware functions
export {
  requireAuth,
  optionalAuth,
  requireAdmin,
  createAuthMiddleware,
  getClientIp,
  getUserAgent,
} from '../auth/middleware';

// Export initialization functions
export { initializeAuth, getAuthMode, isAuthEnabled } from '../auth/index';

// Export token service
export { TokenService, initializeTokenService, getTokenService } from '../auth/token-service';

// Export session store
export type { SessionStore } from '../auth/session-store';
export {
  initializeSessionStore,
  getSessionStore,
  createSessionAuthTable,
} from '../auth/session-store';

// Export route handlers
export {
  handleLogin,
  handleLogout,
  handleRefresh,
  handleGetMe,
  handleChangePassword,
  handleListSessions,
  handleRevokeSession,
  initializeDefaultUser,
} from '../auth/routes';

// Legacy compatibility exports
export const SESSION_COOKIE_NAME = 'koryphaios_session';
export const REFRESH_COOKIE_NAME = 'koryphaios_refresh';

/**
 * Extract bearer token from Authorization header
 * @deprecated Use extractBearerToken from auth module - this is a re-export for compatibility
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}
