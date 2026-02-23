/**
 * Routing audit — Log routing decisions to SQLite for auditing.
 */

import { getDb } from "../../db/sqlite";
import { nanoid } from "nanoid";
import type { TriageIntent } from "./types";

export function logRoutingDecision(params: {
  userId: string | null;
  sessionId: string | null;
  intent: TriageIntent;
  selectedModelId: string | null;
  checkedModels: string[];
}): void {
  try {
    const db = getDb();
    db.run(
      `INSERT INTO routing_audit_log (id, user_id, session_id, intent, selected_model_id, checked_models_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nanoid(12),
        params.userId ?? null,
        params.sessionId ?? null,
        params.intent,
        params.selectedModelId ?? null,
        JSON.stringify(params.checkedModels),
        Date.now(),
      ]
    );
  } catch (e) {
    // Don't fail the request if audit logging fails
    console.warn("Routing audit log failed:", e);
  }
}
