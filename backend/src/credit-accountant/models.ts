/**
 * 2026 multiplier logic: map model IDs to 2026 costs ($/MTok).
 * Used to compute local estimate from token usage.
 */

export interface ModelCost2026 {
  /** $ per million input tokens */
  costPerMInput: number;
  /** $ per million output tokens */
  costPerMOutput: number;
  /** Relative multiplier (e.g. 0.33x, 1.0x); for display only */
  multiplier: number;
}

/** Normalize model id for lookup (e.g. claude-3-sonnet-4-6 -> claude-sonnet-4-6). */
function normalizeModelId(model: string): string {
  const s = (model || "").toLowerCase().trim();
  // Strip "claude-3-" prefix if present
  if (s.startsWith("claude-3-")) return "claude-" + s.slice("claude-3-".length);
  return s;
}

/**
 * 2026 pricing (as specified):
 * - claude-3-haiku-4-5: $1.00/MTok (In) / $5.00/MTok (Out) [0.33x]
 * - claude-3-sonnet-4-6: $3.00/MTok (In) / $15.00/MTok (Out) [1.0x]
 * - gpt-5-mini: $0.15/MTok [0x / free-tier equivalent]
 */
const COST_MAP: Record<string, ModelCost2026> = {
  "claude-haiku-4-5": { costPerMInput: 1.0, costPerMOutput: 5.0, multiplier: 0.33 },
  "claude-3-haiku-4-5": { costPerMInput: 1.0, costPerMOutput: 5.0, multiplier: 0.33 },
  "claude-sonnet-4-6": { costPerMInput: 3.0, costPerMOutput: 15.0, multiplier: 1.0 },
  "claude-3-sonnet-4-6": { costPerMInput: 3.0, costPerMOutput: 15.0, multiplier: 1.0 },
  "gpt-5-mini": { costPerMInput: 0.15, costPerMOutput: 0.15, multiplier: 0 },
};

export function getModelCost2026(model: string): ModelCost2026 | null {
  const key = normalizeModelId(model);
  return COST_MAP[key] ?? null;
}

/** Compute cost in USD for the given token counts using 2026 pricing. */
export function computeCost2026(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const cost = getModelCost2026(model);
  if (!cost) return 0;
  const inCost = (tokensIn / 1_000_000) * cost.costPerMInput;
  const outCost = (tokensOut / 1_000_000) * cost.costPerMOutput;
  return inCost + outCost;
}
