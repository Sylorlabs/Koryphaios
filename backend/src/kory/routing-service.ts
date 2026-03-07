// Routing Service
// Domain: Model selection and domain routing logic
// Extracted from manager.ts lines 232-244, 336-376, 581-591

import type { ProviderName, WorkerDomain, KoryphaiosConfig } from "@koryphaios/shared";
import { resolveModel, isLegacyModel, getNonLegacyModels, type ProviderRegistry } from "../providers";
import { DOMAIN } from "../constants";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RoutingDecision {
  model: string;
  provider: ProviderName | undefined;
}

export interface RoutingServiceDependencies {
  config: KoryphaiosConfig;
  providers: ProviderRegistry;
}

// ─── RoutingService Class ───────────────────────────────────────────────────────

export class RoutingService {
  private config: KoryphaiosConfig;
  private providers: ProviderRegistry;

  constructor(deps: RoutingServiceDependencies) {
    this.config = deps.config;
    this.providers = deps.providers;
  }

  /**
   * Builds a fallback chain for model selection.
   * Follows configured fallbacks and avoids legacy models.
   *
   * @param startModelId - The starting model ID
   * @returns Array of model IDs in fallback order (max 25)
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
        // Push in reverse order to maintain original order when popping
        for (let i = next.length - 1; i >= 0; i--) {
          stack.push(next[i]!);
        }
      }
    }

    return chain;
  }

  /**
   * Resolves the routing (model/provider) for a domain.
   * Prioritizes: user selection > domain assignment > default model
   *
   * @param preferredModel - User-specified model (optional)
   * @param domain - Worker domain
   * @param avoidLegacy - Whether to avoid legacy/deprecated models
   * @returns Routing decision with model and provider
   */
  resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = "general",
    avoidLegacy = false
  ): RoutingDecision {
    let out: RoutingDecision;

    // 1. User-specified model (provider:model or just model)
    if (preferredModel && preferredModel.includes(":")) {
      const [p, m] = preferredModel.split(":");
      out = { provider: p as ProviderName, model: m };
    } else {
      // 2. Domain assignment from config
      const assignment = this.config.assignments?.[domain];
      if (assignment && assignment.includes(":")) {
        const [p, m] = assignment.split(":");
        out = { provider: p as ProviderName, model: m };
      } else {
        // 3. Default model for domain or general fallback
        const modelId = DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
        const def = resolveModel(modelId)!;
        out = { model: modelId, provider: def.provider };
      }
    }

    // 4. Avoid legacy models if requested
    if (avoidLegacy && isLegacyModel(out.model)) {
      const nonLegacy = getNonLegacyModels();
      const sameProvider = nonLegacy.find((m) => m.provider === out.provider);
      const fallback = sameProvider ?? nonLegacy[0];
      if (fallback) {
        out = { model: fallback.id, provider: fallback.provider };
      }
    }

    return out;
  }

  /**
   * Classifies a message into a worker domain using keyword scoring.
   *
   * @param message - The user message to classify
   * @returns The best-matching worker domain
   */
  classifyDomainLLM(message: string): WorkerDomain {
    const lower = message.toLowerCase();
    const scores: Record<string, number> = {};

    // Score each domain by keyword matches
    for (const [domain, keywords] of Object.entries(DOMAIN.KEYWORDS)) {
      scores[domain] = (keywords as readonly string[]).filter((k) => lower.includes(k)).length;
    }

    // Find the highest-scoring domain
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return (best && best[1] > 0 ? best[0] : "general") as WorkerDomain;
  }

  /**
   * Checks if a message requires system-level access (install, sudo, apt, etc.).
   * Used for determining if a task needs elevated permissions.
   *
   * @param message - The message to check
   * @returns true if system access is required
   */
  requiresSystemAccess(message: string): boolean {
    const systemKeywords = ["install", "sudo", "apt"];
    return systemKeywords.some((keyword) => message.toLowerCase().includes(keyword));
  }

  /**
   * Extract allowed file paths from a plan using LLM analysis.
   * This helps constrain worker operations to specific paths.
   *
   * @param sessionId - Session identifier
   * @param plan - The execution plan
   * @param preferredModel - Optional preferred model for analysis
   * @returns Array of allowed paths (empty if extraction fails)
   */
  async extractAllowedPaths(sessionId: string, plan: string, preferredModel?: string): Promise<string[]> {
    const routing = this.resolveActiveRouting(preferredModel, "general", true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);

    if (!provider) return [];

    const prompt = `Identify paths to modify or read. PLAN: ${plan}. Return ONLY JSON array.`;
    let result = "";

    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: "JSON only.",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 300,
      });

      for await (const event of stream) {
        if (event.type === "content_delta") {
          result += event.content ?? "";
        }
      }

      // Extract JSON array from response
      const match = result.trim().match(/\[.*\]/s);
      return match ? JSON.parse(match[0]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Validates that a model ID exists and is properly configured.
   *
   * @param modelId - The model ID to validate
   * @returns true if the model is valid
   */
  isValidModel(modelId: string): boolean {
    const def = resolveModel(modelId);
    return def !== null && def !== undefined;
  }

  /**
   * Gets the default model for a domain.
   *
   * @param domain - Worker domain
   * @returns Default model ID for the domain
   */
  getDefaultModelForDomain(domain: WorkerDomain): string {
    return DOMAIN.DEFAULT_MODELS[domain] ?? DOMAIN.DEFAULT_MODELS.general;
  }
}

// ─── Default Model Validation ───────────────────────────────────────────────────

// Validate default models on module load
for (const [domain, modelId] of Object.entries(DOMAIN.DEFAULT_MODELS)) {
  const def = resolveModel(modelId);
  if (!def) {
    throw new Error(`DOMAIN.DEFAULT_MODELS["${domain}"] references unknown model: "${modelId}".`);
  }
}
