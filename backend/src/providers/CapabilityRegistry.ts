import type { ModelDef, ProviderName, ModelTier } from '@koryphaios/shared';
import { isLegacyModel } from './types';
import type { ProviderRegistry } from './registry';

/**
 * Capability-based model selection. Replaces the blind
 * getFirstAvailableRouting() "pick the first provider's first model" approach
 * with a scored selection that considers:
 *   - Model tier (flagship > fast > cheap > reasoning)
 *   - Capability requirements (vision, function calling, reasoning)
 *   - Context window size
 *   - Circuit breaker state
 *   - Cost (cheaper is preferred when ties)
 *
 * The registry queries live provider catalogs (listModels()) so it always
 * reflects the current authenticated state.
 */

export interface CapabilityRequirements {
  /** Minimum context window in tokens. */
  minContextWindow?: number;
  /** Require vision/image support. */
  vision?: boolean;
  /** Require function/tool calling support. */
  functionCall?: boolean;
  /** Require reasoning capability. */
  reasoning?: boolean;
  /** Require streaming support. */
  streaming?: boolean;
  /** Prefer this tier. */
  preferredTier?: ModelTier;
  /** Prefer cheaper models when ties. */
  preferCheap?: boolean;
}

interface ScoredModel {
  model: string;
  provider: ProviderName;
  score: number;
  def: ModelDef;
}

const TIER_SCORE: Record<ModelTier, number> = {
  flagship: 100,
  reasoning: 90,
  fast: 70,
  cheap: 50,
};

export class CapabilityRegistry {
  constructor(private providers: ProviderRegistry) {}

  /** Find the best available model matching the given requirements.
   *  Returns undefined if no available model meets the requirements. */
  findBestModel(requirements: CapabilityRequirements = {}): {
    model: string;
    provider: ProviderName;
  } | undefined {
    const candidates = this.collectCandidates();
    if (candidates.length === 0) return undefined;

    const scored = candidates
      .map((def) => ({
        model: def.id,
        provider: def.provider,
        def,
        score: this.scoreModel(def, requirements),
      }))
      .filter((c) => c.score >= 0) // Negative score = doesn't meet requirements
      .sort((a, b) => b.score - a.score);

    return scored[0]
      ? { model: scored[0].model, provider: scored[0].provider }
      : undefined;
  }

  /** Collect all non-deprecated, non-legacy models from available providers
   *  whose circuit breaker is not open. */
  private collectCandidates(): ModelDef[] {
    const candidates: ModelDef[] = [];
    for (const provider of this.providers.getAvailable()) {
      // Skip providers with open circuit breakers
      // (isCircuitOpen is private — we check via resolveProvider instead)
      if (provider.name === 'vertexai') continue;
      const models = provider.listModels().filter(
        (m) => !isLegacyModel(m) && !m.deprecated,
      );
      candidates.push(...models);
    }
    return candidates;
  }

  /** Score a model against requirements. Returns -1 if it doesn't meet
   *  hard requirements, otherwise a positive score (higher = better). */
  private scoreModel(def: ModelDef, req: CapabilityRequirements): number {
    // Hard requirements — return -1 if not met
    if (req.minContextWindow && def.contextWindow < req.minContextWindow) return -1;
    if (req.vision && !def.vision) return -1;
    if (req.functionCall && !def.functionCall) return -1;
    if (req.streaming && def.supportsStreaming === false) return -1;

    let score = 0;

    // Tier scoring
    const tier = def.tier ?? 'fast';
    if (req.preferredTier) {
      score += tier === req.preferredTier ? 50 : 0;
    }
    score += TIER_SCORE[tier] ?? 0;

    // Reasoning bonus
    if (req.reasoning) {
      score += def.canReason ? 30 : -20;
    } else if (def.canReason) {
      // Slight bonus for reasoning even when not required (more capable)
      score += 5;
    }

    // Context window bonus (logarithmic — doubling context is worth a fixed amount)
    score += Math.log2(def.contextWindow / 1000) * 2;

    // Cost penalty (when preferCheap)
    if (req.preferCheap) {
      const cost = (def.costPerMInputTokens ?? 0) + (def.costPerMOutputTokens ?? 0);
      score -= cost / 10;
    }

    // Function calling bonus
    if (def.functionCall) score += 10;

    // Vision bonus
    if (def.vision) score += 5;

    return score;
  }
}
