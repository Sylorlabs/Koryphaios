// Authentication types for Koryphaios
// Supports: none, api-key, jwt modes

export type AuthMode = 'none' | 'api-key' | 'jwt';

export interface User {
  id: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: number;
}

export interface AuthContext {
  userId: string;
  user?: User;
  sessionId: string;
  tokenType: 'access' | 'api-key';
  issuedAt: number;
  expiresAt: number;
}

export interface JWTPayload {
  sub: string; // userId
  name: string; // user name
  role: 'user' | 'admin';
  sid: string; // sessionId
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

export interface Session {
  id: string;
  userId: string;
  userName: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AuthConfig {
  mode: AuthMode;
  jwtSecret: string;
  jwtRefreshSecret: string;
  accessTokenExpiry: number; // seconds (default: 15 minutes)
  refreshTokenExpiry: number; // seconds (default: 7 days)
  apiKey?: string; // for api-key mode
}

export interface AuthenticatedRequest {
  user?: User;
  sessionId: string;
}

// Error types
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export class TokenExpiredError extends AuthError {
  constructor() {
    super('Token has expired', 'TOKEN_EXPIRED', 401);
  }
}

export class InvalidTokenError extends AuthError {
  constructor(reason?: string) {
    super(`Invalid token${reason ? `: ${reason}` : ''}`, 'INVALID_TOKEN', 401);
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Invalid username or password', 'INVALID_CREDENTIALS', 401);
  }
}

export class SessionNotFoundError extends AuthError {
  constructor() {
    super('Session not found or expired', 'SESSION_NOT_FOUND', 401);
  }
}
