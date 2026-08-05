// Reasoning Configuration Data
// Domain: Data-driven configuration for LLM reasoning/thinking modes
//
// There are NO static per-provider reasoning tables. A model's reasoning
// levels are discovered at runtime — either from the provider's CLI/API
// (Codex supportedReasoningEfforts, Claude Code catalog, Grok cache), from
// models.dev enrichment, or from a user's custom provider config. If a
// model does not report reasoningLevels, the reasoning picker is not shown.

import type { ReasoningRule, ReasoningOption, ReasoningConfig } from './ReasoningTypes';

// Standard reasoning options shared across providers
export const STANDARD_REASONING_OPTIONS: Record<string, ReasoningOption> = {
  none: {
    value: 'none',
    label: 'None',
    description: 'Standard generation without explicit reasoning',
  },
  low: { value: 'low', label: 'Low', description: 'Minimal reasoning effort for speed' },
  medium: { value: 'medium', label: 'Medium', description: 'Balanced depth and speed' },
  high: { value: 'high', label: 'High', description: 'Standard deep reasoning' },
  xhigh: { value: 'xhigh', label: 'X-High', description: 'Extended reasoning depth' },
  max: { value: 'max', label: 'Max', description: 'Absolute maximum reasoning capability' },
  auto: {
    value: 'auto',
    label: 'Auto',
    description: 'Automatically decide reasoning level based on task complexity',
  },
};

// Extended reasoning options
const EXTENDED_REASONING_OPTIONS: Record<string, ReasoningOption> = {
  ...STANDARD_REASONING_OPTIONS,
  minimal: {
    value: 'minimal',
    label: 'Minimal',
    description: 'Lightest available explicit reasoning effort',
  },
  max: {
    value: 'max',
    label: 'Max',
    description: 'Maximum capability, no token constraints',
  },
  off: { value: 'off', label: 'Off', description: 'Disable explicit reasoning mode' },
  on: { value: 'on', label: 'On', description: 'Enable default reasoning mode' },
  default: { value: 'default', label: 'Default', description: 'Provider default reasoning mode' },
  // Budget-based options (Gemini, Haiku 4.5)
  budget_0: { value: '0', label: 'Off', description: 'Disable thinking budget' },
  budget_1024: { value: '1024', label: 'Low', description: 'Thinking budget: 1,024 tokens' },
  budget_8192: { value: '8192', label: 'Medium', description: 'Thinking budget: 8,192 tokens' },
  budget_24576: { value: '24576', label: 'High', description: 'Thinking budget: 24,576 tokens' },
  budget_65536: { value: '65536', label: 'xhigh', description: 'Thinking budget: 65,536 tokens' },
};

// No static reasoning rules — reasoning is entirely data-driven.
// Providers report reasoningLevels per model via live discovery; the frontend
// builds the picker from those levels using buildReasoningConfigFromLevels().
export const DEFAULT_REASONING_RULES: ReasoningRule[] = [];

/**
 * Build a ReasoningConfig from a model's own live-reported effort levels (e.g. Codex's
 * `supported_reasoning_levels` from its models API) instead of a static table.
 * Unrecognized level strings still get a usable option via a generic label/description.
 */
export function buildReasoningConfigFromLevels(
  levels: string[] | undefined | null,
  parameter = 'reasoning.effort',
): ReasoningConfig | null {
  if (!levels || levels.length === 0) return null;

  const options = levels.map(
    (level) =>
      EXTENDED_REASONING_OPTIONS[level] ?? {
        value: level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
        description: `${level} reasoning effort`,
      },
  );

  const defaultValue = levels.includes('medium') ? 'medium' : levels[Math.floor(levels.length / 2)];

  return { parameter, options, defaultValue };
}
