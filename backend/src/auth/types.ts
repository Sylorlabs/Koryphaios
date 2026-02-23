// Authentication types for Koryphaios

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface JWTPayload {
  sub: string; // user ID
  username: string;
  isAdmin: boolean;
  iat: number; // issued at
  exp: number; // expiration
  jti: string; // token ID for revocation
}

export interface RefreshToken {
  token: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  revoked: boolean;
}

export interface AuthContext {
  user: User;
  token: string;
}
