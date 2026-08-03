ALTER TABLE messages ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS session_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  target_revision INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  automatic INTEGER NOT NULL DEFAULT 0,
  source_message_count INTEGER NOT NULL,
  source_tokens INTEGER NOT NULL DEFAULT 0,
  checkpoint_tokens INTEGER NOT NULL DEFAULT 0,
  summary_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_revision
  ON messages(session_id, context_revision, created_at);
CREATE INDEX IF NOT EXISTS idx_session_compactions_session
  ON session_compactions(session_id, created_at);

-- DOWN
DROP INDEX IF EXISTS idx_session_compactions_session;
DROP INDEX IF EXISTS idx_messages_session_revision;
DROP TABLE IF EXISTS session_compactions;
