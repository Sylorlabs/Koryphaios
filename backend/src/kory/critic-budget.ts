export interface CriticBudgetInput {
  provider: string;
  /** Verified model output ceiling, when the provider has one. */
  modelMaxOutputTokens?: number;
  evidenceChars: number;
  changedPathCount?: number;
  skillCount?: number;
}

/**
 * Critic output includes hidden reasoning on some gateways, so a small fixed
 * cap can truncate the actual PASS/FAIL JSON. Start with a provider-aware
 * floor, then add room for the evidence complexity, and never exceed the
 * selected model's verified output limit.
 */
export function criticOutputTokenBudget(input: CriticBudgetInput): number {
  const providerFloor = input.provider === 'cline' ? 8_192 : 2_048;
  const evidenceUnits = Math.ceil(Math.max(0, input.evidenceChars - 12_000) / 12_000);
  const pathUnits = Math.ceil(Math.max(0, input.changedPathCount ?? 0) / 8);
  const skillUnits = Math.ceil(Math.max(0, input.skillCount ?? 0) / 4);
  const requested = Math.max(
    providerFloor,
    4_096 + evidenceUnits * 2_048 + pathUnits * 2_048 + skillUnits * 1_024,
  );
  const ceiling = Number.isFinite(input.modelMaxOutputTokens) && (input.modelMaxOutputTokens ?? 0) > 0
    ? Math.floor(input.modelMaxOutputTokens as number)
    : 32_768;
  return Math.max(1, Math.min(ceiling, requested));
}
