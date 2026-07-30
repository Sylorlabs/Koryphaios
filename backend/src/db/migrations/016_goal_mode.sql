CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, user_id TEXT, objective TEXT NOT NULL, scope TEXT NOT NULL,
  project_path TEXT, session_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
  checklist TEXT NOT NULL DEFAULT '[]', linked_session_ids TEXT NOT NULL DEFAULT '[]',
  activity TEXT NOT NULL DEFAULT '[]', blocker TEXT, active_duration_ms INTEGER NOT NULL DEFAULT 0,
  active_started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_scope_status ON goals(scope, status, priority DESC, sort_order ASC);
