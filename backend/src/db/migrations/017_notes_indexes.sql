-- Migration: Add notes indexes on updated_at and include_in_context
-- Speeds up listNotes()/getNotesCatalog() ORDER BY updated_at and the
-- WHERE include_in_context = 1 context-build query.

CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_include_in_context ON notes(include_in_context);

-- DOWN
DROP INDEX IF EXISTS idx_notes_include_in_context;
DROP INDEX IF EXISTS idx_notes_updated_at;
