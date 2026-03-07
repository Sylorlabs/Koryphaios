// Reasoning Configuration Functions
// Domain: Helper functions to query and normalize reasoning settings

import type { ReasoningConfig } from "./ReasoningTypes";
import { DEFAULT_REASONING_RULES } from "./ReasoningConfig";

/**
 * Get reasoning configuration for a specific provider/model combination.
 * @param provider - Provider name (e.g., "anthropic", "openai")
 * @param model - Model ID (e.g., "claude-opus-4-6", "gpt-5")
 * @returns ReasoningConfig or null if reasoning is not supported
 */
export function getReasoningConfig(provider?: string, model?: string): ReasoningConfig | null {
  const normalizedProvider = provider || "auto";

  for (const rule of DEFAULT_REASONING_RULES) {
    if (rule.provider !== normalizedProvider) continue;
    if (rule.modelPattern && !rule.modelPattern.test(model ?? "")) continue;
    return rule.config;
  }
  return null;
}

/**
 * Check if a provider/model combination supports reasoning.
 * @param provider - Provider name
 * @param model - Model ID
 * @returns true if reasoning is supported with at least one option
 */
export function hasReasoningSupport(provider?: string, model?: string): boolean {
  const config = getReasoningConfig(provider, model);
  return config !== null && config.options && config.options.length > 0;
}

/**
 * Get the default reasoning level for a provider/model.
 * @param provider - Provider name
 * @param model - Model ID
 * @returns Default reasoning level string
 */
export function getDefaultReasoning(provider?: string, model?: string): string {
  const config = getReasoningConfig(provider, model);
  return config?.defaultValue ?? "medium";
}

/**
 * Normalize a reasoning level to the provider's expected format.
 * Handles mapping between standardized levels (low/medium/high) and
 * provider-specific values (budget tokens, effort strings, etc.).
 *
 * @param provider - Provider name
 * @param model - Model ID
 * @param reasoningLevel - User-specified reasoning level
 * @returns Normalized reasoning level or undefined
 */
export function normalizeReasoningLevel(
  provider: string | undefined,
  model: string | undefined,
  reasoningLevel: string | undefined,
): string | undefined {
  if (!reasoningLevel) return undefined;

  // Adaptive means let the model decide
  const normalizedLevel = reasoningLevel.toLowerCase().trim();
  if (normalizedLevel === "adaptive") {
    return undefined;
  }

  // Auto means manager decides based on task complexity
  if (normalizedLevel === "auto") {
    return "auto";
  }

  // If provider is specified, map standardized level to provider's native value
  if (provider && provider !== "auto") {
    const level = normalizedLevel;

    // Gemini (Budget-based)
    if (provider === "google" || provider === "vertexai") {
      const isGemini3 = model ? /gemini-3/i.test(model) : false;
      if (isGemini3) {
        if (level === "none") return "low";
        if (["low", "medium", "high", "xhigh"].includes(level)) {
          return level === "xhigh" ? "high" : level;
        }
      } else {
        // Budget-based mapping
        if (level === "none") return "0";
        if (level === "low") return "1024";
        if (level === "medium") return "8192";
        if (level === "high") return "24576";
        if (level === "xhigh") return "65536";
      }
    }

    // Copilot-specific handling for budget-based models
    if (provider === "copilot") {
      // Gemini 2.5 Pro uses budget-based thinking
      if (model && /gemini-2\.5-pro/i.test(model)) {
        if (level === "none") return "0";
        if (level === "low") return "1024";
        if (level === "medium") return "8192";
        if (level === "high") return "24576";
        if (level === "xhigh") return "65536";
      }
      // Gemini 3.x uses thinking levels
      if (model && /gemini-3/i.test(model)) {
        if (level === "none") return "low";
        if (["low", "medium", "high", "xhigh"].includes(level)) {
          return level === "xhigh" ? "high" : level;
        }
      }
      // Claude Haiku 4.5 uses budget tokens
      if (model && /claude-haiku-4\.5/i.test(model)) {
        if (level === "none") return "0";
        if (level === "low") return "1024";
        if (level === "medium") return "8192";
        if (level === "high") return "24576";
        if (level === "xhigh") return "24576"; // Max for Haiku
      }
    }

    // OpenAI / Anthropic / Groq / xAI / Azure / OpenRouter / Copilot (Effort-based)
    if (["openai", "anthropic", "groq", "xai", "azure", "openrouter", "copilot"].includes(provider)) {
      if (level === "none") return "none";
      if (level === "xhigh") return "high"; // Map xhigh to high for effort-based APIs
      // Preserve low, medium, high, max (max is valid for Anthropic Opus 4.6 only)
      return level;
    }
  }

  // Fallback: search in config options
  const config = getReasoningConfig(provider, model);
  if (!config || config.options.length === 0) return undefined;

  const value = reasoningLevel.trim().toLowerCase();
  const option = config.options.find((opt) => opt.value.toLowerCase() === value);
  if (!option) return config.defaultValue;
  return option.value;
}

/**
 * Determine reasoning level based on task complexity.
 * Used when reasoningLevel is "auto" - the manager decides the appropriate level.
 *
 * @param taskDescription - The task description to analyze
 * @returns Reasoning level: "low", "medium", or "high"
 */
export function determineAutoReasoningLevel(taskDescription: string): string {
  const lower = taskDescription.toLowerCase();

  // High complexity tasks - need deep reasoning
  const highComplexityPatterns = [
    /multi-?step/i,
    /complex/i,
    /architect/i,
    /design/i,
    /refactor/i,
    /debug/i,
    /troubleshoot/i,
    /optimize/i,
    /implement/i,
    /create.*from.*scratch/i,
    /build.*system/i,
    /rewrite/i,
    /migrate/i,
    /restructure/i,
    /explain.*complex/i,
    /analyze.*entire/i,
    /review.*entire/i,
  ];

  // Low complexity tasks - quick responses sufficient
  const lowComplexityPatterns = [
    /simple/i,
    /quick/i,
    /basic/i,
    /small/i,
    /fix.*typo/i,
    /add.*comment/i,
    /format/i,
    /lint/i,
    /brief/i,
    /what.*is/i,
    /how.*do/i,
    /list/i,
    /show.*me/i,
    /read.*file/i,
  ];

  for (const pattern of highComplexityPatterns) {
    if (pattern.test(lower)) {
      return "high";
    }
  }

  for (const pattern of lowComplexityPatterns) {
    if (pattern.test(lower)) {
      return "low";
    }
  }

  // Default to medium for everything else
  return "medium";
}

// Re-export types and constants for convenience
export { DEFAULT_REASONING_RULES } from "./ReasoningConfig";
export { STANDARD_REASONING_OPTIONS } from "./ReasoningConfig";
export type { ReasoningConfig, ReasoningOption, ReasoningRule, ReasoningLevel } from "./ReasoningTypes";
