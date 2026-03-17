/**
 * Model cost tracking: map model IDs to actual API costs ($/MTok).
 * Used to compute local estimate from token usage.
 */

export interface ModelCost {
  /** $ per million input tokens */
  costPerMInput: number;
  /** $ per million output tokens */
  costPerMOutput: number;
  /** Relative multiplier (e.g. 0.33x, 1.0x); for display only */
  multiplier: number;
}

/** Normalize model id for lookup. */
function normalizeModelId(model: string): string {
  const s = (model || "").toLowerCase().trim();
  return s;
}

/**
 * Current pricing (as of March 2026):
 * - claude-3-5-haiku: $0.80/MTok (In) / $4.00/MTok (Out) [0.27x]
 * - claude-3-5-sonnet: $3.00/MTok (In) / $15.00/MTok (Out) [1.0x]
 * - claude-3-7-sonnet: $3.00/MTok (In) / $15.00/MTok (Out) [1.0x]
 * - claude-3-opus: $15.00/MTok (In) / $75.00/MTok (Out) [5.0x]
 * - gpt-4o: $2.50/MTok (In) / $10.00/MTok (Out) [0.83x]
 * - gpt-4o-mini: $0.15/MTok (In) / $0.60/MTok (Out) [0.05x]
 * - o1: $15.00/MTok (In) / $60.00/MTok (Out) [5.0x]
 * - o3-mini: $1.10/MTok (In) / $4.40/MTok (Out) [0.37x]
 */
const COST_MAP: Record<string, ModelCost> = {
  // Anthropic
  "claude-3-5-haiku": { costPerMInput: 0.80, costPerMOutput: 4.00, multiplier: 0.27 },
  "claude-3-5-sonnet": { costPerMInput: 3.0, costPerMOutput: 15.0, multiplier: 1.0 },
  "claude-3-7-sonnet": { costPerMInput: 3.0, costPerMOutput: 15.0, multiplier: 1.0 },
  "claude-3-opus": { costPerMInput: 15.0, costPerMOutput: 75.0, multiplier: 5.0 },
  "claude-3-haiku": { costPerMInput: 0.25, costPerMOutput: 1.25, multiplier: 0.08 },
  
  // OpenAI
  "gpt-4o": { costPerMInput: 2.50, costPerMOutput: 10.0, multiplier: 0.83 },
  "gpt-4o-mini": { costPerMInput: 0.15, costPerMOutput: 0.60, multiplier: 0.05 },
  "o1": { costPerMInput: 15.0, costPerMOutput: 60.0, multiplier: 5.0 },
  "o1-mini": { costPerMInput: 1.10, costPerMOutput: 4.40, multiplier: 0.37 },
  "o3-mini": { costPerMInput: 1.10, costPerMOutput: 4.40, multiplier: 0.37 },
  "gpt-4-turbo": { costPerMInput: 10.0, costPerMOutput: 30.0, multiplier: 2.5 },
  "gpt-4": { costPerMInput: 30.0, costPerMOutput: 60.0, multiplier: 6.0 },
  "gpt-3.5-turbo": { costPerMInput: 0.50, costPerMOutput: 1.50, multiplier: 0.17 },
};

export function getModelCost(model: string): ModelCost | null {
  const key = normalizeModelId(model);
  return COST_MAP[key] ?? null;
}

/** Compute cost in USD for the given token counts. */
export function computeCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const cost = getModelCost(model);
  if (!cost) return 0;
  const inCost = (tokensIn / 1_000_000) * cost.costPerMInput;
  const outCost = (tokensOut / 1_000_000) * cost.costPerMOutput;
  return inCost + outCost;
}
