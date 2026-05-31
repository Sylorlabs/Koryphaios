// JWT Token Service - Generation, validation, and refresh

import { sign, verify } from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import {
  JWTPayload,
  TokenPair,
  AuthContext,
  AuthConfig,
  TokenExpiredError,
  InvalidTokenError,
} from './types';
import { authLog } from '../logger';

export class TokenService {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
    this.validateSecrets();
  }

  private validateSecrets(): void {
    if (this.config.mode === 'jwt') {
      if (!this.config.jwtSecret || this.config.jwtSecret.length < 32) {
        throw new Error(
          'JWT_SECRET must be at least 32 characters when using JWT authentication mode',
        );
      }
      if (!this.config.jwtRefreshSecret || this.config.jwtRefreshSecret.length < 32) {
        throw new Error(
          'JWT_REFRESH_SECRET must be at least 32 characters when using JWT authentication mode',
        );
      }
      if (this.config.jwtSecret === this.config.jwtRefreshSecret) {
        throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different');
      }
    }
  }

  /**
   * Generate a pair of access and refresh tokens
   */
  generateTokenPair(
    userId: string,
    userName: string,
    role: 'user' | 'admin' = 'user',
    sessionId: string,
  ): TokenPair {
    const now = Math.floor(Date.now() / 1000);
    const accessTokenExpiry = this.config.accessTokenExpiry || 900; // 15 minutes
    const refreshTokenExpiry = this.config.refreshTokenExpiry || 604800; // 7 days

    const accessPayload: JWTPayload = {
      sub: userId,
      name: userName,
      role,
      sid: sessionId,
      type: 'access',
      iat: now,
      exp: now + accessTokenExpiry,
    };

    const refreshPayload: JWTPayload = {
      sub: userId,
      name: userName,
      role,
      sid: sessionId,
      type: 'refresh',
      iat: now,
      exp: now + refreshTokenExpiry,
    };

    const accessToken = sign(accessPayload, this.config.jwtSecret);
    const refreshToken = sign(refreshPayload, this.config.jwtRefreshSecret);

    authLog.debug({ userId, sessionId, accessExpiry: accessPayload.exp }, 'Generated token pair');

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiry,
    };
  }

  /**
   * Validate an access token
   */
  validateAccessToken(token: string): AuthContext {
    try {
      const payload = verify(token, this.config.jwtSecret) as JWTPayload;

      if (payload.type !== 'access') {
        throw new InvalidTokenError('Not an access token');
      }

      return {
        userId: payload.sub,
        user: {
          id: payload.sub,
          name: payload.name,
          role: payload.role,
          createdAt: payload.iat,
        },
        sessionId: payload.sid,
        tokenType: 'access',
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        throw new TokenExpiredError();
      }
      if (error.name === 'JsonWebTokenError') {
        throw new InvalidTokenError(error.message);
      }
      throw new InvalidTokenError(error.message);
    }
  }

  /**
   * Validate a refresh token
   */
  validateRefreshToken(token: string): { userId: string; sessionId: string } {
    try {
      const payload = verify(token, this.config.jwtRefreshSecret) as JWTPayload;

      if (payload.type !== 'refresh') {
        throw new InvalidTokenError('Not a refresh token');
      }

      return {
        userId: payload.sub,
        sessionId: payload.sid,
      };
    } catch (error: any) {
      if (error.name === 'TokenExpiredError') {
        throw new TokenExpiredError();
      }
      if (error.name === 'JsonWebTokenError') {
        throw new InvalidTokenError(error.message);
      }
      throw new InvalidTokenError(error.message);
    }
  }

  /**
   * Generate a secure random API key
   */
  generateApiKey(): string {
    return `kory_${randomBytes(32).toString('hex')}`;
  }

  /**
   * Validate API key
   */
  validateApiKey(providedKey: string): boolean {
    if (this.config.mode !== 'api-key' || !this.config.apiKey) {
      return false;
    }
    // Use timing-safe comparison to prevent timing attacks
    try {
      const provided = Buffer.from(providedKey);
      const expected = Buffer.from(this.config.apiKey);

      if (provided.length !== expected.length) {
        return false;
      }

      let result = 0;
      for (let i = 0; i < provided.length; i++) {
        result |= provided[i] ^ expected[i];
      }

      return result === 0;
    } catch {
      return false;
    }
  }

  /**
   * Decode token without verification (for debugging, doesn't throw)
   */
  decodeToken(token: string): JWTPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      return payload as JWTPayload;
    } catch {
      return null;
    }
  }

  /**
   * Check if a token is expired (without throwing)
   */
  isTokenExpired(token: string): boolean {
    const payload = this.decodeToken(token);
    if (!payload) return true;

    const now = Math.floor(Date.now() / 1000);
    return payload.exp < now;
  }

  /**
   * Get time until token expiry in seconds
   */
  getTimeUntilExpiry(token: string): number {
    const payload = this.decodeToken(token);
    if (!payload) return 0;

    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, payload.exp - now);
  }
}

// Singleton instance
let tokenService: TokenService | null = null;

export function initializeTokenService(config: AuthConfig): TokenService {
  tokenService = new TokenService(config);
  return tokenService;
}

export function getTokenService(): TokenService {
  if (!tokenService) {
    throw new Error('TokenService not initialized');
  }
  return tokenService;
}
