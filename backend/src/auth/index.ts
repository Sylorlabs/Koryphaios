// Authentication module exports

export {
  hashPassword,
  verifyPassword,
  generateToken,
  createAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  revokeAllUserSessions,
  createUser,
  authenticateUser,
  getUserById,
  getOrCreateGuestUser,
  getOrCreateLocalUser,
  changePassword,
  cleanupExpiredTokens,
  cleanupBlacklist,
} from "./auth";

export type { User, JWTPayload, RefreshToken, AuthContext } from "./types";
