// Authentication module exports

export {
  hashPassword,
  verifyPassword,
  generateToken,
  createAccessToken,
  verifyAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  createUser,
  authenticateUser,
  getUserById,
  getOrCreateGuestUser,
  getOrCreateLocalUser,
  changePassword,
  cleanupExpiredTokens,
} from "./auth";

export type { User, JWTPayload, RefreshToken, AuthContext } from "./types";
