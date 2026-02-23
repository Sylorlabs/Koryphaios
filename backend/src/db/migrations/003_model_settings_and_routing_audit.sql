-- Migration: Model Settings and Routing Audit
-- User-enabled models for Intelligent Auto-Mode; audit log for routing decisions.
-- Database: koryphaios.db (same as app; sylorlabs.db is an alternate name in spec)

-- Per-user model selection: which models the user has "checked" (enabled) for auto-routing
CREATE TABLE IF NOT EXISTS model_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  is_checked INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(user_id, model_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Audit log for triage/routing decisions (intent, selected model, checked list)
CREATE TABLE IF NOT EXISTS routing_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  session_id TEXT,
  intent TEXT NOT NULL,
  selected_model_id TEXT,
  checked_models_json TEXT,
  created_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_model_settings_user_checked ON model_settings(user_id, is_checked);
CREATE INDEX IF NOT EXISTS idx_routing_audit_user ON routing_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_routing_audit_session ON routing_audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_routing_audit_created ON routing_audit_log(created_at);

-- DOWN
-- DROP INDEX IF EXISTS idx_routing_audit_created;
-- DROP INDEX IF EXISTS idx_routing_audit_session;
-- DROP INDEX IF EXISTS idx_routing_audit_user;
-- DROP INDEX IF EXISTS idx_model_settings_user_checked;
-- DROP TABLE IF EXISTS routing_audit_log;
-- DROP TABLE IF EXISTS model_settings;
