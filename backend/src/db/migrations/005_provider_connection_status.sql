-- Migration: Provider connection status (2026 auth hardening)
-- Stores invalid key state (401) and optional endpoint overrides (404 fallback).

-- Provider keys marked invalid (401) so we don't keep trying
CREATE TABLE IF NOT EXISTS provider_key_invalid (
  provider TEXT PRIMARY KEY,
  invalid_since INTEGER NOT NULL,
  last_error TEXT
);

-- Optional base URL overrides when 404 triggered fallback (e.g. Gemini v1beta)
CREATE TABLE IF NOT EXISTS provider_endpoint_override (
  provider TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- DOWN
-- DROP TABLE IF EXISTS provider_endpoint_override;
-- DROP TABLE IF EXISTS provider_key_invalid;
