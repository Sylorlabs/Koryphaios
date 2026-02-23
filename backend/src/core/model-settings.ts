/**
 * Model Settings Service — Queries enabled (checked) models from SQLite for Auto-Mode routing.
 * Table: model_settings (user_id, model_id, provider, is_checked).
 * Database is koryphaios.db (same as app initDb dataDir).
 */

import { getDb } from "../db/sqlite";
import type { ProviderName } from "@koryphaios/shared";
import { nanoid } from "nanoid";

export interface ModelSettingRow {
  id: string;
  user_id: string;
  model_id: string;
  provider: string;
  is_checked: number;
  created_at: number | null;
  updated_at: number | null;
}

/**
 * Get list of enabled model IDs for a user (is_checked = 1).
 * Returns model_id as stored (e.g. "claude-sonnet-4-5"); provider is in the same row for provider:model format.
 */
export function getEnabledModelIds(userId: string): string[] {
  const db = getDb();
  const rows = db
    .query("SELECT model_id, provider FROM model_settings WHERE user_id = ? AND is_checked = 1")
    .all(userId) as ModelSettingRow[];

  return rows.map((r) => (r.provider ? `${r.provider}:${r.model_id}` : r.model_id));
}

/**
 * Get enabled model IDs in provider:model form for resolution.
 */
export function getEnabledModelsForRouting(userId: string): { modelId: string; provider: ProviderName }[] {
  const db = getDb();
  const rows = db
    .query("SELECT model_id, provider FROM model_settings WHERE user_id = ? AND is_checked = 1")
    .all(userId) as ModelSettingRow[];

  return rows.map((r) => ({
    modelId: r.model_id,
    provider: r.provider as ProviderName,
  }));
}

/**
 * Set or update a model's checked state for a user.
 */
export function setModelChecked(userId: string, modelId: string, provider: ProviderName, isChecked: boolean): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .query("SELECT id FROM model_settings WHERE user_id = ? AND model_id = ?")
    .get(userId, modelId) as { id: string } | undefined;

  if (existing) {
    db.run(
      "UPDATE model_settings SET is_checked = ?, updated_at = ? WHERE id = ?",
      [isChecked ? 1 : 0, now, existing.id]
    );
  } else {
    db.run(
      "INSERT INTO model_settings (id, user_id, model_id, provider, is_checked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [nanoid(12), userId, modelId, provider, isChecked ? 1 : 0, now, now]
    );
  }
}

/**
 * Ensure model_settings table exists (e.g. after migration). No-op if already present.
 */
export function ensureModelSettingsTable(): void {
  try {
    getDb().exec(
      "CREATE TABLE IF NOT EXISTS model_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, model_id TEXT NOT NULL, provider TEXT NOT NULL, is_checked INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER, UNIQUE(user_id, model_id))"
    );
  } catch {
    // Migration may not have run; caller should run migrations
  }
}
