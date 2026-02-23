/**
 * Types for Intelligent Auto-Mode routing (Triage + Selection).
 */

export type TriageIntent = "SMALL" | "MEDIUM" | "LARGE";

export type ModelTier = "flagship" | "fast" | "cheap" | "reasoning";

export interface RoutingAuditEntry {
  id: string;
  user_id: string | null;
  session_id: string | null;
  intent: TriageIntent;
  selected_model_id: string | null;
  checked_models_json: string;
  created_at: number;
}

export interface TriageResult {
  intent: TriageIntent;
  /** Raw label from classifier (e.g. Gemma 3 or heuristic). */
  rawLabel?: string;
}

export interface SelectionResult {
  modelId: string;
  provider: string;
  tier: ModelTier;
  /** True if we downgraded from the intent's preferred tier. */
  downgraded: boolean;
}
