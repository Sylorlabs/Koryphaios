/**
 * RoutingServiceEnhanced
 *
 * Enhanced routing service that encapsulates the routing logic from KoryManager.
 * This is a drop-in replacement for the inline methods in manager.ts.
 */

import type { WorkerDomain, ProviderName, KoryphaiosConfig } from '@koryphaios/shared';
import { resolveModel, isLegacyModel, getNonLegacyModels } from '../../providers';
import { DOMAIN } from '../../constants';
import type { ProviderRegistry } from '../../providers/registry';
import { SmartRouterService } from './SmartRouterService';

export interface RoutingDecision {
  model: string;
  provider: ProviderName | undefined;
}

/**
 * Split a `provider:model` string on the first colon only, preserving colons
 * in the model part (e.g. `codex:codex-account:YWNjb3VudA:gpt-5.6-sol`).
 */
export function splitProviderModel(value: string): { provider: ProviderName; model: string } {
  const idx = value.indexOf(':');
  if (idx < 0) return { provider: value as ProviderName, model: value };
  return {
    provider: value.slice(0, idx) as ProviderName,
    model: value.slice(idx + 1),
  };
}

export interface RoutingServiceEnhancedConfig {
  config: KoryphaiosConfig;
  providers?: ProviderRegistry;
}

export function splitProviderModel(value: string): { provider: ProviderName; model: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    provider: value.slice(0, separator) as ProviderName,
    model: value.slice(separator + 1),
  };
}

/**
 * Enhanced routing service that handles model/provider selection.
 * Extracted from KoryManager to reduce its line count.
 */
export class RoutingServiceEnhanced {
  private config: KoryphaiosConfig;
  private smartRouter: SmartRouterService | undefined;

  constructor(deps: RoutingServiceEnhancedConfig) {
    this.config = deps.config;
    if (deps.providers) {
      this.smartRouter = new SmartRouterService(deps.providers);
    }
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
   *
   * Auto mode order:
   *   1. Explicit provider:model string → honor as-is
   *   2. Bare model ID (not "auto") → look up in catalog
   *   3. Category assignment in config → honor
   *   4. SmartRouterService (task-aware, live-catalog) if available
   *   5. DOMAIN.DEFAULT_MODELS static fallback
   */
  resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
    prompt?: string,
    preferCheap?: boolean,
  ): RoutingDecision {
    let out: RoutingDecision;

    if (preferredModel && preferredModel.includes(':')) {
      const parsed = splitProviderModel(preferredModel)!;
      out = { provider: parsed.provider, model: parsed.model };
    } else if (preferredModel && preferredModel !== 'auto' && resolveModel(preferredModel)) {
      const def = resolveModel(preferredModel)!;
      out = { model: preferredModel, provider: def.provider };
    } else {
      const assignment = this.config.assignments?.[domain];
      if (assignment && assignment.includes(':')) {
        const parsed = splitProviderModel(assignment)!;
        out = { provider: parsed.provider, model: parsed.model };
      } else if (this.smartRouter) {
        // Task-aware selection from live catalog
        const decision = this.smartRouter.route({ prompt, domain, preferCheap });
        if (decision) {
          out = { model: decision.model, provider: decision.provider };
        } else {
          // SmartRouter returned nothing (no providers) — fall through to static default
          const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
          const def = resolveModel(modelId)!;
          out = { model: modelId, provider: def.provider };
        }
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
    return splitProviderModel(providerModel);
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
