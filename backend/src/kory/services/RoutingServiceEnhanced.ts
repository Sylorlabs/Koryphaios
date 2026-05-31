/**
 * RoutingServiceEnhanced
 *
 * Enhanced routing service that encapsulates the routing logic from KoryManager.
 * This is a drop-in replacement for the inline methods in manager.ts.
 */

import type { WorkerDomain, ProviderName, KoryphaiosConfig } from '@koryphaios/shared';
import { resolveModel, isLegacyModel, getNonLegacyModels } from '../../providers';
import { DOMAIN } from '../../constants';

export interface RoutingDecision {
  model: string;
  provider: ProviderName | undefined;
}

export interface RoutingServiceEnhancedConfig {
  config: KoryphaiosConfig;
}

/**
 * Enhanced routing service that handles model/provider selection.
 * Extracted from KoryManager to reduce its line count.
 */
export class RoutingServiceEnhanced {
  private config: KoryphaiosConfig;

  constructor(deps: RoutingServiceEnhancedConfig) {
    this.config = deps.config;
  }

  /**
   * Build a fallback chain for a starting model.
   * Returns an array of model IDs to try in order.
   */
  buildFallbackChain(startModelId: string): string[] {
    const fallbacks = this.config.fallbacks ?? {};
    const chain: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [startModelId];

    while (stack.length > 0 && chain.length < 25) {
      const modelId = stack.pop()!;
      if (seen.has(modelId) || isLegacyModel(modelId)) continue;
      seen.add(modelId);
      chain.push(modelId);
      const next = fallbacks[modelId];
      if (Array.isArray(next)) {
        for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
      }
    }

    return chain;
  }

  /**
   * Resolves the routing (model/provider) for a domain.
   * Prioritizes user selection when provided.
   * When avoidLegacy is true, never returns a legacy/deprecated model.
   */
  resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
  ): RoutingDecision {
    let out: RoutingDecision;

    if (preferredModel && preferredModel.includes(':')) {
      const [p, m] = preferredModel.split(':');
      out = { provider: p as ProviderName, model: m! };
    } else {
      const assignment = this.config.assignments?.[domain];
      if (assignment && assignment.includes(':')) {
        const [p, m] = assignment.split(':');
        out = { provider: p as ProviderName, model: m! };
      } else {
        const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
        const def = resolveModel(modelId)!;
        out = { model: modelId, provider: def.provider };
      }
    }

    if (avoidLegacy && isLegacyModel(out.model)) {
      const nonLegacy = getNonLegacyModels();
      const sameProvider = nonLegacy.find((m) => m.provider === out.provider);
      const fallback = sameProvider ?? nonLegacy[0];
      if (fallback) out = { model: fallback.id, provider: fallback.provider };
    }

    return out;
  }

  /**
   * Parse a provider:model string into components.
   */
  parseProviderModel(providerModel: string): { provider: ProviderName; model: string } | null {
    if (!providerModel.includes(':')) return null;
    const [provider, model] = providerModel.split(':');
    return { provider: provider as ProviderName, model: model! };
  }

  /**
   * Check if a model ID is valid.
   */
  isValidModel(modelId: string): boolean {
    return resolveModel(modelId) !== null;
  }

  /**
   * Get the default model for a domain.
   */
  getDefaultModelForDomain(domain: WorkerDomain): string {
    return DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
  }
}
