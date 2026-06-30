-- Migration: Notes network (Obsidian-style note graph)
-- Adds notes, note_links (wiki-link edges), and note_attachments tables.

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  folder_path TEXT NOT NULL DEFAULT '/',
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  include_in_context INTEGER NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (from_note_id, to_note_id)
);

CREATE TABLE IF NOT EXISTS note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_folder_path ON notes(folder_path);
CREATE INDEX IF NOT EXISTS idx_note_links_from ON note_links(from_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_to ON note_links(to_note_id);

-- DOWN
DROP INDEX IF EXISTS idx_note_links_to;
DROP INDEX IF EXISTS idx_note_links_from;
DROP INDEX IF EXISTS idx_notes_folder_path;
DROP INDEX IF EXISTS idx_notes_user_id;
DROP TABLE IF EXISTS note_attachments;
DROP TABLE IF EXISTS note_links;
DROP TABLE IF EXISTS notes;
