/**
 * TriageEngine — Local triage/decider using optional Gemma 3 270M (SLM) or heuristic fallback.
 *
 * CRITICAL: Routing only considers models the user has enabled in model_settings (is_checked = 1).
 * This module:
 * 1. Loads the list of enabled models from SQLite (for use by SelectionEngine / ManagerSession).
 * 2. Classifies user input into SMALL, MEDIUM, or LARGE.
 * 3. Supports optional @huggingface/transformers (v3) with WebGPU for google/gemma-3-270m-it;
 *    when not available, uses a heuristic classifier so the pipeline still works.
 */

import { getEnabledModelIds } from "../model-settings";
import type { TriageIntent, TriageResult } from "./types";
import { logRoutingDecision } from "./audit";

// Heuristic: keywords and length to approximate SMALL / MEDIUM / LARGE
const LARGE_KEYWORDS = [
  "refactor", "rewrite", "implement", "build", "create", "architecture", "design", "multiple", "several",
  "full", "entire", "whole", "project", "application", "system", "integration", "migration", "replace",
];
const MEDIUM_KEYWORDS = [
  "add", "fix", "update", "change", "modify", "improve", "feature", "function", "component", "module",
  "test", "tests", "api", "endpoint", "handler", "service", "util", "helper",
];

/**
 * Classify input using a simple heuristic (used when local Gemma 3 is not available).
 * For production with local SLM: integrate @huggingface/transformers (v3) with WebGPU
 * and replace this with a call to google/gemma-3-270m-it with a short classification prompt.
 */
function classifyHeuristic(input: string): TriageIntent {
  const text = input.trim().toLowerCase();
  const wordCount = text.split(/\s+/).length;

  const hasLarge = LARGE_KEYWORDS.some((k) => text.includes(k));
  const hasMedium = MEDIUM_KEYWORDS.some((k) => text.includes(k));

  if (wordCount >= 80 || hasLarge) return "LARGE";
  if (wordCount >= 25 || hasMedium) return "MEDIUM";
  return "SMALL";
}

/**
 * Optional: Run local Gemma 3 270M for triage (when @huggingface/transformers is available).
 * Returns null if not available; then caller uses heuristic.
 * Uses Function to avoid TS resolving the optional module.
 */
async function classifyWithGemma(input: string): Promise<TriageResult | null> {
  try {
    const load = new Function("return import('@huggingface/transformers')");
    const modRaw = await (load() as Promise<unknown>).catch(() => null);
    type Pipeline = (task: string, model: string, opts?: object) => Promise<(prompt: string, opts?: object) => Promise<{ generated_text?: string } | Array<{ generated_text?: string }>>>;
    const mod = modRaw as { pipeline?: Pipeline } | null;
    if (!mod?.pipeline) return null;

    const pipe = await mod.pipeline("text2text-generation", "google/gemma-3-270m-it", {
      device: "webgpu",
    });
    const prompt = `Classify the following user request complexity. Reply with exactly one word: SMALL, MEDIUM, or LARGE.\n\nRequest: ${input.slice(0, 500)}\n\nClassification:`;
    const out = await pipe(prompt, { max_new_tokens: 10 });
    const text = (out && (Array.isArray(out) ? out[0]?.generated_text : (out as { generated_text?: string })?.generated_text)) ?? "";
    const upper = text.toUpperCase();
    let intent: TriageIntent = "MEDIUM";
    if (upper.includes("LARGE")) intent = "LARGE";
    else if (upper.includes("SMALL")) intent = "SMALL";
    return { intent, rawLabel: text.trim() };
  } catch {
    return null;
  }
}

export interface TriageEngineOptions {
  /** User ID for loading enabled models and audit log. */
  userId: string;
  /** Session ID for audit log. */
  sessionId?: string | null;
  /** If true, attempt to use local Gemma 3 270M when available. */
  useLocalSlm?: boolean;
}

/**
 * Get the list of enabled (checked) model IDs for the user from SQLite.
 * TriageEngine and ManagerSession must only consider these models.
 */
export function getCheckedModelsForUser(userId: string): string[] {
  return getEnabledModelIds(userId);
}

/**
 * Run triage on user input: classify into SMALL, MEDIUM, or LARGE.
 * Uses local Gemma 3 270M when useLocalSlm is true and the dependency is available; otherwise heuristic.
 */
export async function triage(
  input: string,
  options: TriageEngineOptions
): Promise<TriageResult> {
  const { userId, sessionId, useLocalSlm = false } = options;

  let result: TriageResult;
  if (useLocalSlm) {
    const gemmaResult = await classifyWithGemma(input);
    result = gemmaResult ?? { intent: classifyHeuristic(input), rawLabel: "heuristic" };
  } else {
    result = { intent: classifyHeuristic(input), rawLabel: "heuristic" };
  }

  return result;
}

/**
 * Log the final routing decision to SQLite (intent, selected model, checked models).
 * Call this after SelectionEngine has chosen the model so the audit has the full picture.
 */
export function auditRoutingDecision(params: {
  userId: string | null;
  sessionId: string | null;
  intent: TriageIntent;
  selectedModelId: string | null;
  checkedModels: string[];
}): void {
  logRoutingDecision(params);
}
