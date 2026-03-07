-- JWT Token Blacklist and Active Token Tracking
-- Migration: 004_jwt_blacklist.sql
-- Description: Adds table for tracking active JWT tokens per user for complete session revocation

-- Active JWT tokens table (optional, for complete session revocation)
-- This allows us to blacklist ALL access tokens for a user when needed
CREATE TABLE IF NOT EXISTS active_jwt_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for querying user's active tokens
CREATE INDEX IF NOT EXISTS idx_active_jwt_user_id ON active_jwt_tokens(user_id, revoked);

-- Index for cleanup of expired tokens
CREATE INDEX IF NOT EXISTS idx_active_jwt_expires ON active_jwt_tokens(expires_at);

-- Comments for documentation
-- Note: Redis is the primary blacklist mechanism for performance
-- This table provides persistence and a backup for complete session revocation
-- When revoking all user sessions:
-- 1. Mark all refresh_tokens as revoked
-- 2. Mark all active_jwt_tokens as revoked
-- 3. Add all JTIs to Redis blacklist (in background job)
