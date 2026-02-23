-- Migration: Security Tables
-- Date: 2026-02-20

-- User credentials table (for encrypted provider API keys)
CREATE TABLE IF NOT EXISTS user_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_credential TEXT NOT NULL,
  encrypted_metadata TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- API Keys table (for programmatic access)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hashed_key TEXT NOT NULL,
  scopes TEXT NOT NULL,
  rate_limit_tier TEXT DEFAULT 'free',
  expires_at INTEGER,
  last_used_at INTEGER,
  usage_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  success INTEGER,
  reason TEXT,
  metadata TEXT,
  timestamp INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_credentials_user ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_credentials_provider ON user_credentials(provider);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);

-- DOWN
-- DROP INDEX IF EXISTS idx_audit_timestamp;
-- DROP INDEX IF EXISTS idx_audit_action;
-- DROP INDEX IF EXISTS idx_audit_user;
-- DROP INDEX IF EXISTS idx_api_keys_user;
-- DROP INDEX IF EXISTS idx_api_keys_prefix;
-- DROP INDEX IF EXISTS idx_credentials_provider;
-- DROP INDEX IF EXISTS idx_credentials_user;
-- DROP TABLE IF EXISTS audit_logs;
-- DROP TABLE IF EXISTS api_keys;
-- DROP TABLE IF EXISTS user_credentials;
