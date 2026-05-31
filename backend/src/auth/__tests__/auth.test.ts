// Authentication system tests

import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import { TokenService, initializeTokenService, getTokenService } from '../token-service';
import { initializeSessionStore, getSessionStore } from '../session-store';
import { requireAuth } from '../middleware';
import { AuthConfig } from '../types';

// Import initializeAuth separately to avoid circular dependency issues
const initializeAuth = async () => {
  const { initializeAuth: init } = await import('../index');
  return init();
};

// Mock environment
const originalEnv = process.env;

describe('Authentication System', () => {
  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
  });

  describe('TokenService', () => {
    let tokenService: TokenService;

    beforeAll(() => {
      const config: AuthConfig = {
        mode: 'jwt',
        jwtSecret: 'test-secret-32-characters-long!!',
        jwtRefreshSecret: 'test-refresh-secret-32-characters-long!!',
        accessTokenExpiry: 900, // 15 minutes
        refreshTokenExpiry: 604800, // 7 days
      };
      tokenService = new TokenService(config);
    });

    describe('Token Generation', () => {
      it('should generate valid token pair', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        expect(tokens.accessToken).toBeDefined();
        expect(tokens.refreshToken).toBeDefined();
        expect(tokens.expiresIn).toBe(900);
        expect(tokens.accessToken).not.toBe(tokens.refreshToken);
      });

      it('should reject short secrets', () => {
        expect(() => {
          new TokenService({
            mode: 'jwt',
            jwtSecret: 'short',
            jwtRefreshSecret: 'also-short-secret-not-long-enough-for-jwt!!',
            accessTokenExpiry: 900,
            refreshTokenExpiry: 604800,
          });
        }).toThrow();
      });

      it('should reject identical secrets', () => {
        expect(() => {
          new TokenService({
            mode: 'jwt',
            jwtSecret: 'test-secret-32-characters-long!!',
            jwtRefreshSecret: 'test-secret-32-characters-long!!',
            accessTokenExpiry: 900,
            refreshTokenExpiry: 604800,
          });
        }).toThrow();
      });
    });

    describe('Token Validation', () => {
      it('should validate access token', () => {
        const tokens = tokenService.generateTokenPair(
          'user123',
          'Test User',
          'admin',
          'session123',
        );

        const context = tokenService.validateAccessToken(tokens.accessToken);
        expect(context.userId).toBe('user123');
        expect(context.user?.name).toBe('Test User');
        expect(context.user?.role).toBe('admin');
        expect(context.sessionId).toBe('session123');
        expect(context.tokenType).toBe('access');
      });

      it('should validate refresh token', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        const payload = tokenService.validateRefreshToken(tokens.refreshToken);
        expect(payload.userId).toBe('user123');
        expect(payload.sessionId).toBe('session123');
      });

      it('should reject expired token', () => {
        // Create token that expires immediately
        const { sign } = require('jsonwebtoken');
        const expiredToken = sign(
          { sub: 'user123', type: 'access', exp: Math.floor(Date.now() / 1000) - 1 },
          'test-secret-32-characters-long!!',
        );

        expect(() => {
          tokenService.validateAccessToken(expiredToken);
        }).toThrow();
      });

      it('should reject invalid signature', () => {
        const { sign } = require('jsonwebtoken');
        const invalidToken = sign({ sub: 'user123', type: 'access' }, 'wrong-secret');

        expect(() => {
          tokenService.validateAccessToken(invalidToken);
        }).toThrow();
      });

      it('should reject refresh token as access token', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        expect(() => {
          tokenService.validateAccessToken(tokens.refreshToken);
        }).toThrow();
      });

      it('should reject access token as refresh token', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        expect(() => {
          tokenService.validateRefreshToken(tokens.accessToken);
        }).toThrow();
      });
    });

    describe('API Key', () => {
      it('should validate correct API key', () => {
        const apiKeyService = new TokenService({
          mode: 'api-key',
          jwtSecret: '',
          jwtRefreshSecret: '',
          accessTokenExpiry: 0,
          refreshTokenExpiry: 0,
          apiKey: 'secret-api-key-123',
        });

        expect(apiKeyService.validateApiKey('secret-api-key-123')).toBe(true);
      });

      it('should reject incorrect API key', () => {
        const apiKeyService = new TokenService({
          mode: 'api-key',
          jwtSecret: '',
          jwtRefreshSecret: '',
          accessTokenExpiry: 0,
          refreshTokenExpiry: 0,
          apiKey: 'secret-api-key-123',
        });

        expect(apiKeyService.validateApiKey('wrong-key')).toBe(false);
      });

      it('should reject API key in JWT mode', () => {
        expect(tokenService.validateApiKey('any-key')).toBe(false);
      });

      it('should generate API key with correct format', () => {
        const key = tokenService.generateApiKey();
        expect(key.startsWith('kory_')).toBe(true);
        expect(key.length).toBe(5 + 64); // prefix + 32 bytes hex
      });
    });

    describe('Token Decoding', () => {
      it('should decode token payload', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        const payload = tokenService.decodeToken(tokens.accessToken);
        expect(payload?.sub).toBe('user123');
        expect(payload?.name).toBe('Test User');
        expect(payload?.type).toBe('access');
      });

      it('should return null for invalid token', () => {
        expect(tokenService.decodeToken('invalid.token.here')).toBeNull();
        expect(tokenService.decodeToken('not-a-token')).toBeNull();
      });
    });

    describe('Expiry Checking', () => {
      it('should detect expired token', () => {
        const { sign } = require('jsonwebtoken');
        const expiredToken = sign(
          { sub: 'user123', type: 'access', exp: Math.floor(Date.now() / 1000) - 1 },
          'test-secret-32-characters-long!!',
        );

        expect(tokenService.isTokenExpired(expiredToken)).toBe(true);
      });

      it('should detect valid token', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        expect(tokenService.isTokenExpired(tokens.accessToken)).toBe(false);
      });

      it('should calculate time until expiry', () => {
        const tokens = tokenService.generateTokenPair('user123', 'Test User', 'user', 'session123');

        const timeLeft = tokenService.getTimeUntilExpiry(tokens.accessToken);
        expect(timeLeft).toBeGreaterThan(800); // ~15 minutes minus some overhead
        expect(timeLeft).toBeLessThanOrEqual(900);
      });
    });
  });

  describe('SessionStore', () => {
    let sessionStore: ReturnType<typeof getSessionStore>;

    beforeEach(() => {
      initializeSessionStore(false); // Use in-memory store
      sessionStore = getSessionStore();
    });

    it('should create and retrieve session', async () => {
      const session = await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      expect(session.id).toBeDefined();

      const retrieved = await sessionStore.get(session.id);
      expect(retrieved?.userId).toBe('user123');
      expect(retrieved?.userName).toBe('Test User');
    });

    it('should return null for expired session', async () => {
      const session = await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() - 1000, // Already expired
        lastActivityAt: Date.now(),
      });

      const retrieved = await sessionStore.get(session.id);
      expect(retrieved).toBeNull();
    });

    it('should list sessions by user', async () => {
      await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      await sessionStore.create({
        userId: 'user456',
        userName: 'Other User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      const user123Sessions = await sessionStore.getByUserId('user123');
      expect(user123Sessions.length).toBe(2);

      const user456Sessions = await sessionStore.getByUserId('user456');
      expect(user456Sessions.length).toBe(1);
    });

    it('should delete session', async () => {
      const session = await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      await sessionStore.delete(session.id);
      const retrieved = await sessionStore.get(session.id);
      expect(retrieved).toBeNull();
    });

    it('should clean up expired sessions', async () => {
      await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() - 1000,
        lastActivityAt: Date.now(),
      });

      await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      const deleted = await sessionStore.deleteExpired();
      expect(deleted).toBe(1);

      const active = await sessionStore.listActive();
      expect(active.length).toBe(1);
    });

    it('should update last activity', async () => {
      const session = await sessionStore.create({
        userId: 'user123',
        userName: 'Test User',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        lastActivityAt: Date.now(),
      });

      const before = (await sessionStore.get(session.id))!.lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      await sessionStore.touch(session.id);
      const after = (await sessionStore.get(session.id))!.lastActivityAt;

      expect(after).toBeGreaterThan(before);
    });
  });

  describe('requireAuth Middleware', () => {
    beforeEach(() => {
      // Reset to known state
      process.env.KORYPHAIOS_AUTH_MODE = 'none';
    });

    it('should allow all requests in none mode', async () => {
      process.env.KORYPHAIOS_AUTH_MODE = 'none';

      const req = new Request('http://localhost/api/test');
      const auth = await requireAuth(req);

      expect(auth.sessionId).toBe('system');
    });

    it('should require API key in api-key mode', async () => {
      process.env.KORYPHAIOS_AUTH_MODE = 'api-key';
      process.env.KORYPHAIOS_API_KEY = 'test-api-key';

      initializeTokenService({
        mode: 'api-key',
        jwtSecret: '',
        jwtRefreshSecret: '',
        accessTokenExpiry: 0,
        refreshTokenExpiry: 0,
        apiKey: 'test-api-key',
      });

      // Request without key should fail
      const reqWithoutKey = new Request('http://localhost/api/test');
      expect(requireAuth(reqWithoutKey)).rejects.toThrow();

      // Request with wrong key should fail
      const reqWithWrongKey = new Request('http://localhost/api/test', {
        headers: { 'X-API-Key': 'wrong-key' },
      });
      expect(requireAuth(reqWithWrongKey)).rejects.toThrow();

      // Request with correct key should succeed
      const reqWithKey = new Request('http://localhost/api/test', {
        headers: { 'X-API-Key': 'test-api-key' },
      });
      const auth = await requireAuth(reqWithKey);
      expect(auth.user?.id).toBe('api-user');
    });

    it('should require Bearer token in JWT mode', async () => {
      process.env.KORYPHAIOS_AUTH_MODE = 'jwt';

      initializeTokenService({
        mode: 'jwt',
        jwtSecret: 'test-secret-32-characters-long!!',
        jwtRefreshSecret: 'test-refresh-secret-32-characters-long!!',
        accessTokenExpiry: 900,
        refreshTokenExpiry: 604800,
      });
      initializeSessionStore(false);

      // Request without token should fail
      const reqWithoutToken = new Request('http://localhost/api/test');
      expect(requireAuth(reqWithoutToken)).rejects.toThrow();

      // Request with invalid token should fail
      const reqWithInvalidToken = new Request('http://localhost/api/test', {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      expect(requireAuth(reqWithInvalidToken)).rejects.toThrow();
    });
  });
});
