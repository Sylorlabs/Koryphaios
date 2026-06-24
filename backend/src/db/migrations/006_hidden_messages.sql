-- Add hidden flag and tool_call_id to messages for soft-hide / recall feature
ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
