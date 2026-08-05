// Reasoning Configuration Functions
// Domain: Helper functions to query and normalize reasoning settings
//
// There are no static per-provider reasoning tables. Reasoning config is built
// at runtime from each model's live-reported reasoningLevels via
// buildReasoningConfigFromLevels(). These helpers remain for compatibility but
// always return null/default since the static rule table is empty.

import type { ReasoningConfig } from './ReasoningTypes';
import { DEFAULT_REASONING_RULES } from './ReasoningConfig';

/**
 * Get reasoning configuration for a specific provider/model combination.
 * Always returns null — reasoning config is now built from live model metadata
 * (reasoningLevels) via buildReasoningConfigFromLevels(), not static rules.
 */
export function getReasoningConfig(_provider?: string, _model?: string): ReasoningConfig | null {
  return null;
}

/**
 * Check if a provider/model combination supports reasoning.
 * Always false — use the model's live reasoningLevels array instead.
 */
export function hasReasoningSupport(_provider?: string, _model?: string): boolean {
  return false;
}

/**
 * Get the default reasoning level for a provider/model.
 * Always returns 'medium' — the actual default comes from the live
 * reasoningLevels array via buildReasoningConfigFromLevels().
 */
export function getDefaultReasoning(_provider?: string, _model?: string): string {
  return 'medium';
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

  const normalizedLevel = reasoningLevel.toLowerCase().trim();

  // Antigravity exposes Low/Medium/High as separate model entries. It has no
  // independent reasoning parameter, so stale UI/session values must not be
  // forwarded or interpreted as a request to switch models.
  if (provider === 'antigravity') return undefined;

  if (normalizedLevel === 'adaptive') {
    return undefined;
  }

  // Auto means manager decides based on task complexity
  if (normalizedLevel === 'auto') {
    return 'auto';
  }

  // Pass the level through unchanged. The reasoning picker only offers levels
  // the model itself reported via reasoningLevels, so the value is already in
  // the provider's native format. Each provider's backend code handles any
  // API-specific mapping (e.g. OpenAI maps budget tokens to effort strings).
  return normalizedLevel;
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
      return 'high';
    }
  }

  for (const pattern of lowComplexityPatterns) {
    if (pattern.test(lower)) {
      return 'low';
    }
  }

  // Default to medium for everything else
  return 'medium';
}

// Re-export types and constants for convenience
export { DEFAULT_REASONING_RULES } from './ReasoningConfig';
export { STANDARD_REASONING_OPTIONS } from './ReasoningConfig';
export { buildReasoningConfigFromLevels } from './ReasoningConfig';
export type {
  ReasoningConfig,
  ReasoningOption,
  ReasoningRule,
  ReasoningLevel,
} from './ReasoningTypes';
