// Speed tiers — vendor-confirmed faster serving modes of the SAME model.
//
// A speed tier is never a different model: MiniMax ships `…-highspeed`
// variants of the same weights, Xiaomi's MiMo Pro runs an "UltraSpeed" mode,
// OpenAI sells a `priority` service tier, Codex a `fast` service tier, and
// Devin folds `-fast`/`-priority` slugs into its base families. Catalogs that
// enumerate both the base and the variant get folded here so the model picker
// shows one model with a speed switch instead of two look-alike entries.
//
// Every rule needs a vendor source — a suffix-shaped name alone is not
// evidence. `gpt-3.5-turbo`, `veo-3.1-fast`, `grok-code-fast-1`,
// `swe-2-lightning` and friends are different models and must never fold.

import type { ModelDef, ModelSpeedTier } from '@koryphaios/shared';

/** One vendor-confirmed "same model, faster serving" rule. Both regexes run
 *  against the LAST path segment of the model id, so namespaced ids like
 *  `xiaomi/mimo-v2.6-pro` and `openrouter/xiaomi/mimo-v2.6-pro` match alike. */
export interface VendorSpeedTierRule {
  /** Matches the base-model segment (the variant id with the suffix removed). */
  baseFamily: RegExp;
  /** Matches the speed-tier suffix at the END of the segment. Anchored, so a
   *  trailing `:free`/`:batch` qualifier makes the variant not fold. */
  suffix: RegExp;
  /** The tier attached to the base model when a confirmed variant folds in. */
  tier: ModelSpeedTier;
  /** Where the vendor documents that this is the same model served faster. */
  evidence: string;
}

/** Shared tier descriptors so catalogs agree on label + description. */
export const SPEED_TIER_PRIORITY_OPENAI: ModelSpeedTier = {
  id: 'priority',
  label: 'Priority',
  description: 'API Priority processing. Requires Priority access on this OpenAI project.',
};
export const SPEED_TIER_FAST_CODEX: ModelSpeedTier = {
  id: 'fast',
  label: 'Fast',
  description: '1.5× faster Codex service tier. Uses ChatGPT credits at a higher rate.',
};
export const SPEED_TIER_FAST_HOPLITE: ModelSpeedTier = {
  id: 'fast',
  label: 'Fast',
  description: "Hoplite's fast service tier for this model.",
};
export const SPEED_TIER_FAST_DEVIN: ModelSpeedTier = {
  id: 'fast',
  label: 'Fast',
  description: "Devin's fast serving tier for this model. Bills at a higher rate.",
};

export const VENDOR_SPEED_TIER_RULES: VendorSpeedTierRule[] = [
  {
    // "M2.7 and M2.7-highspeed with identical results but faster speed" —
    // the HighSpeed series is the same weights on a faster serving path.
    baseFamily: /^minimax-m\d/i,
    suffix: /-highspeed$/i,
    tier: {
      id: 'highspeed',
      label: 'Highspeed',
      description:
        'Same MiniMax model and output, served about 1.7× faster. Billed at about 2× the standard rate.',
    },
    evidence: 'https://www.minimax.io/models/text/m27',
  },
  {
    // "MiMo-V2.6-Pro can also be called in UltraSpeed mode, at up to 20x the
    // output speed … same quality" — a serving mode, not a different model.
    baseFamily: /^mimo-v\d/i,
    suffix: /-ultraspeed$/i,
    tier: {
      id: 'ultraspeed',
      label: 'UltraSpeed',
      description:
        'Same MiMo Pro model at up to 20× output speed. Billed at about 10× the standard rate.',
    },
    evidence: 'https://mimo.xiaomi.com/mimo-v2-6',
  },
];

/** Fold vendor-confirmed speed variants into their base models.
 *
 *  A variant folds only when the rule's base-family and suffix both match its
 *  last path segment AND the exact base id (variant minus suffix, same
 *  namespace prefix and casing) is present in the same list. Folding attaches
 *  the rule's tier to the base, records `speedVariants[tier.id].default` as
 *  the variant's API slug, and keeps the variant id as an alias + speedAlias
 *  so persisted selections still resolve. A variant with no base stays as its
 *  own model — the fold never drops a catalog entry. */
export function foldVendorSpeedTiers(models: ModelDef[]): ModelDef[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const folded = new Set<string>();
  const updated = new Map<string, ModelDef>();
  for (const model of models) {
    const segment = model.id.split('/').pop() ?? model.id;
    for (const rule of VENDOR_SPEED_TIER_RULES) {
      const match = rule.suffix.exec(segment);
      if (!match) continue;
      const baseSegment = segment.slice(0, match.index);
      if (!rule.baseFamily.test(baseSegment)) break;
      const baseId = model.id.slice(0, model.id.length - segment.length) + baseSegment;
      const original = byId.get(baseId);
      if (!original || original === model) break;
      const base = updated.get(baseId) ?? { ...original };
      updated.set(baseId, base);
      if (!(base.speedTiers ?? []).some((t) => t.id === rule.tier.id)) {
        base.speedTiers = [...(base.speedTiers ?? []), rule.tier];
      }
      base.speedVariants = {
        ...base.speedVariants,
        [rule.tier.id]: {
          ...(base.speedVariants?.[rule.tier.id] ?? {}),
          default: model.apiModelId ?? model.id,
        },
      };
      base.speedAliases = { ...base.speedAliases, [model.id]: rule.tier.id };
      base.aliases = [...new Set([...(base.aliases ?? []), model.id])];
      folded.add(model.id);
      break;
    }
  }
  return models.filter((m) => !folded.has(m.id)).map((m) => updated.get(m.id) ?? m);
}

/** Resolve a selected speed tier (+ optional effort) to the provider slug the
 *  request should use. Undefined means "use the standard slug". */
export function resolveSpeedVariant(
  model: ModelDef | undefined,
  tierId: string | undefined,
  effort?: string,
): string | undefined {
  if (!model || !tierId) return undefined;
  const variants = model.speedVariants?.[tierId];
  if (!variants) return undefined;
  return (effort ? variants[effort] : undefined) ?? variants.default;
}

/** Backward-compatibility shim for the API boundary. A request carrying only
 *  the retired boolean `fastMode` maps onto the provider's tier id — OpenAI's
 *  fast path is the `priority` service tier; everyone else's is `fast`. An
 *  explicit `speedTier` always wins. */
export function normalizeSpeedTier(
  provider: string | undefined,
  speedTier: string | null | undefined,
  fastMode: boolean | undefined,
): string | undefined {
  if (speedTier) return speedTier;
  if (fastMode === true) return provider === 'openai' ? 'priority' : 'fast';
  return undefined;
}
