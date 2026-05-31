// Authentication module for Koryphaios
// Provides JWT-based authentication and API key support

export type * from './types';
export * from './middleware';
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
} from './types';
export {
  AuthError,
  TokenExpiredError,
  InvalidTokenError,
  InvalidCredentialsError,
  SessionNotFoundError,
} from './types';
export { TokenService, initializeTokenService, getTokenService } from './token-service';
export { initializeSessionStore, getSessionStore, createSessionAuthTable } from './session-store';
export type { SessionStore } from './session-store';
export {
  handleLogin,
  handleLogout,
  handleRefresh,
  handleGetMe,
  handleChangePassword,
  handleListSessions,
  handleRevokeSession,
  initializeDefaultUser,
} from './routes';

import { AuthConfig } from './types';
import { initializeTokenService } from './token-service';
import { initializeSessionStore, createSessionAuthTable } from './session-store';
import { initializeDefaultUser } from './routes';
import { authLog } from '../logger';

/**
 * Initialize the authentication system
 * Must be called before using any auth features
 */
export function initializeAuth(): void {
  const mode = (process.env.KORYPHAIOS_AUTH_MODE as AuthConfig['mode']) || 'none';

  authLog.info({ mode }, 'Initializing authentication');

  if (mode === 'none') {
    authLog.warn('Authentication is DISABLED. All endpoints are publicly accessible.');
    return;
  }

  if (mode === 'api-key') {
    const apiKey = process.env.KORYPHAIOS_API_KEY;
    if (!apiKey) {
      authLog.warn('API key mode enabled but KORYPHAIOS_API_KEY not set. Generating random key.');
      // Generate a random key for this session
      const { TokenService } = require('./token-service');
      const tempKey = TokenService.prototype.generateApiKey();
      process.env.KORYPHAIOS_API_KEY = tempKey;
      authLog.warn(`Temporary API key: ${tempKey}`);
    }

    initializeTokenService({
      mode: 'api-key',
      jwtSecret: '',
      jwtRefreshSecret: '',
      accessTokenExpiry: 0,
      refreshTokenExpiry: 0,
      apiKey: process.env.KORYPHAIOS_API_KEY,
    });

    authLog.info('API key authentication initialized');
    return;
  }

  if (mode === 'jwt') {
    const jwtSecret = process.env.JWT_SECRET;
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret || '';

    if (!jwtSecret) {
      throw new Error(
        'JWT_SECRET environment variable is required when using JWT authentication mode',
      );
    }

    if (jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters for security');
    }

    // Initialize token service
    initializeTokenService({
      mode: 'jwt',
      jwtSecret,
      jwtRefreshSecret,
      accessTokenExpiry: parseInt(process.env.JWT_ACCESS_EXPIRY || '900'), // 15 minutes
      refreshTokenExpiry: parseInt(process.env.JWT_REFRESH_EXPIRY || '604800'), // 7 days
    });

    // Initialize session store
    const useSQLite = process.env.SESSION_STORE === 'sqlite';
    initializeSessionStore(useSQLite);

    // Create database table if using SQLite
    if (useSQLite) {
      createSessionAuthTable();
    }

    // Initialize default admin user
    initializeDefaultUser();

    // Start session cleanup interval
    const cleanupInterval = setInterval(async () => {
      try {
        const { getSessionStore } = require('./session-store');
        const store = getSessionStore();
        const count = await store.deleteExpired();
        if (count > 0) {
          authLog.debug({ count }, 'Cleaned up expired sessions');
        }
      } catch (error) {
        authLog.error({ error }, 'Session cleanup error');
      }
    }, 3600000); // Every hour

    // Ensure cleanup doesn't prevent process exit
    cleanupInterval.unref?.();

    authLog.info('JWT authentication initialized');
    return;
  }

  throw new Error(`Unknown authentication mode: ${mode}`);
}

/**
 * Get current authentication mode
 */
export function getAuthMode(): AuthConfig['mode'] {
  return (process.env.KORYPHAIOS_AUTH_MODE as AuthConfig['mode']) || 'none';
}

/**
 * Check if authentication is enabled
 */
export function isAuthEnabled(): boolean {
  return getAuthMode() !== 'none';
}
