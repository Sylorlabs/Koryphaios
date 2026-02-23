/**
 * SelectionEngine — Maps Gemma 3 triage intent to the best available model from the user's checked list.
 * If the intent recommends a tier (e.g. LARGE -> flagship) but no enabled model is in that tier,
 * downgrades to the next best enabled tier (e.g. fast, then cheap).
 */

import type { ModelDef, ProviderName } from "@koryphaios/shared";
import { resolveModel } from "../../providers";
import type { TriageIntent, ModelTier, SelectionResult } from "./types";

const INTENT_TO_TIERS: Record<TriageIntent, ModelTier[]> = {
  LARGE: ["flagship", "reasoning", "fast", "cheap"],
  MEDIUM: ["fast", "flagship", "cheap", "reasoning"],
  SMALL: ["cheap", "fast", "flagship", "reasoning"],
};

/**
 * Normalize enabled list to provider:modelId. Accepts either "modelId" or "provider:modelId".
 */
function normalizeChecked(checked: string[]): { modelId: string; provider: ProviderName }[] {
  const out: { modelId: string; provider: ProviderName }[] = [];
  for (const s of checked) {
    if (s.includes(":")) {
      const [provider, modelId] = s.split(":");
      if (provider && modelId) out.push({ modelId: modelId.trim(), provider: provider.trim() as ProviderName });
    } else {
      const def = resolveModel(s);
      if (def) out.push({ modelId: def.id, provider: def.provider });
    }
  }
  return out;
}

/**
 * Build a list of enabled model definitions with tier, from the user's checked list.
 */
function getEnabledDefs(checked: string[]): (ModelDef & { providerModelId: string })[] {
  const normalized = normalizeChecked(checked);
  const result: (ModelDef & { providerModelId: string })[] = [];
  for (const { modelId, provider } of normalized) {
    const def = resolveModel(modelId);
    if (def && def.provider === provider) {
      result.push({ ...def, providerModelId: `${provider}:${modelId}` });
    }
  }
  return result;
}

/**
 * Select the best model from the user's checked list for the given intent.
 * Only considers enabled models; downgrades tier if no model in preferred tier is checked.
 */
export function selectModel(intent: TriageIntent, checkedModels: string[]): SelectionResult | null {
  const enabled = getEnabledDefs(checkedModels);
  if (enabled.length === 0) return null;

  const tiers = INTENT_TO_TIERS[intent];
  for (const tier of tiers) {
    const inTier = enabled.filter((m) => m.tier === tier);
    if (inTier.length === 0) continue;
    // Prefer first (catalog order); could sort by context window or cost
    const chosen = inTier[0]!;
    return {
      modelId: chosen.id,
      provider: chosen.provider,
      tier: chosen.tier!,
      downgraded: tier !== tiers[0],
    };
  }

  // No tier matched (e.g. no tier on defs) — use first enabled
  const fallback = enabled[0]!;
  return {
    modelId: fallback.id,
    provider: fallback.provider,
    tier: (fallback.tier as ModelTier) ?? "fast",
    downgraded: true,
  };
}

/**
 * Resolve model_tier (e.g. "flagship") to a concrete model from the checked list.
 * Used by Manager when spawning workers: must strictly obey checked list.
 */
export function selectModelForTier(
  modelTier: ModelTier,
  checkedModels: string[]
): SelectionResult | null {
  const enabled = getEnabledDefs(checkedModels);
  const inTier = enabled.filter((m) => m.tier === modelTier);
  if (inTier.length === 0) return null;
  const chosen = inTier[0]!;
  return {
    modelId: chosen.id,
    provider: chosen.provider,
    tier: chosen.tier!,
    downgraded: false,
  };
}

/**
 * If no model in the required tier is checked, return the best available fallback from checked list.
 */
export function selectFallbackWhenTierUnavailable(
  requiredTier: ModelTier,
  checkedModels: string[]
): SelectionResult | null {
  const fallbackTiers: ModelTier[] = (
    ["flagship", "fast", "reasoning", "cheap"] as ModelTier[]
  ).filter((t) => t !== requiredTier);
  for (const tier of fallbackTiers) {
    const r = selectModelForTier(tier, checkedModels);
    if (r) return { ...r, downgraded: true };
  }
  const enabled = getEnabledDefs(checkedModels);
  const first = enabled[0];
  if (!first) return null;
  return {
    modelId: first.id,
    provider: first.provider,
    tier: (first.tier as ModelTier) ?? "fast",
    downgraded: true,
  };
}
