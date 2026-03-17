// Reasoning Configuration
// Unified abstraction for reasoning/thinking modes across different LLM providers
// Maps to OpenAI reasoning_effort, Anthropic thinking, and Gemini thinking_budget/level

/**
 * Standard reasoning effort levels
 * Maps to different provider-specific values
 */
export type ReasoningMode =
  | "disabled"  // No reasoning/thinking
  | "minimal"   // Minimal reasoning (fastest, cheapest)
  | "low"       // Low effort
  | "medium"    // Balanced (default)
  | "high"      // High effort (more thorough)
  | "max";      // Maximum reasoning (slowest, most expensive)

/**
 * Unified reasoning configuration
 * Provider-specific implementations transform this to their native parameters
 */
export interface ReasoningConfig {
  /** Reasoning effort level */
  mode: ReasoningMode;
  /** 
   * Optional: explicit token budget for reasoning
   * If set, overrides mode-based estimates
   * Provider support varies (Gemini 2.5, Anthropic)
   */
  budgetTokens?: number;
  /**
   * Whether to include thinking/reasoning output in response
   * Some providers expose the model's reasoning process
   */
  includeThoughts?: boolean;
}

/**
 * Default reasoning configuration
 */
export const DEFAULT_REASONING_CONFIG: ReasoningConfig = {
  mode: "medium",
  includeThoughts: false,
};

/**
 * Mapping of reasoning modes to OpenAI reasoning_effort values
 */
const OPENAI_REASONING_EFFORT: Record<ReasoningMode, string | undefined> = {
  disabled: undefined,  // Don't send parameter
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  max: "high", // OpenAI doesn't have "max", use "high"
};

/**
 * Mapping of reasoning modes to Anthropic thinking.effort values (Claude 3.7+)
 */
const ANTHROPIC_THINKING_EFFORT: Record<ReasoningMode, string | undefined> = {
  disabled: undefined,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  max: "high", // Claude uses "high" as maximum
};

/**
 * Mapping of reasoning modes to Gemini 3 thinking levels
 */
const GEMINI_THINKING_LEVEL: Record<ReasoningMode, string | undefined> = {
  disabled: undefined,
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  max: "HIGH", // Gemini doesn't have "max", use "HIGH"
};

/**
 * Estimated token budgets for reasoning modes (for providers that use token budgets)
 */
const MODE_TOKEN_BUDGETS: Record<ReasoningMode, number | undefined> = {
  disabled: 0,
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16384,
};

/**
 * Check if a model supports reasoning based on model ID
 */
export function supportsReasoning(modelId: string, provider?: string): boolean {
  const id = modelId.toLowerCase();
  
  // OpenAI o-series (reasoning models)
  if (provider === "openai" || id.includes("gpt") || id.includes("o1") || id.includes("o3")) {
    return id.includes("o1") || id.includes("o3");
  }
  
  // Anthropic Claude 3.7+ (supports extended thinking)
  if (provider === "anthropic" || id.includes("claude")) {
    return id.includes("claude-3-7") || id.includes("claude-3.7");
  }
  
  // Google Gemini 2.5+
  if (provider === "google" || provider === "gemini" || id.includes("gemini")) {
    return id.includes("gemini-2.5") || id.includes("gemini-3") || id.includes("gemini-2") || id.includes("gemini-1.5-pro");
  }
  
  // Default: assume it might support reasoning
  return true;
}

/**
 * Transform unified reasoning config to OpenAI format
 * Returns undefined if reasoning should be disabled
 */
export function toOpenAIReasoning(
  config: ReasoningConfig,
  modelId?: string
): { reasoning_effort?: string; reasoning?: { effort: string } } | undefined {
  // GPT-5 uses new Responses API format with reasoning.effort
  const isGpt5 = modelId?.toLowerCase().includes("gpt-5");
  
  const effort = OPENAI_REASONING_EFFORT[config.mode];
  if (!effort) return undefined;
  
  if (isGpt5) {
    return { reasoning: { effort } };
  }
  
  return { reasoning_effort: effort };
}

/**
 * Transform unified reasoning config to Anthropic format
 */
export function toAnthropicThinking(
  config: ReasoningConfig,
  modelId?: string
): { thinking?: { type: string; budget_tokens?: number; effort?: string } } | undefined {
  const isClaude46 = modelId?.toLowerCase().includes("claude") && 
    (modelId.includes("4.6") || modelId.includes("-4-6"));
  
  if (config.mode === "disabled") {
    return undefined;
  }
  
  // Claude 3.7+ uses extended thinking with budget tokens
  if (isClaude46) {
    const budget = config.budgetTokens ?? MODE_TOKEN_BUDGETS[config.mode];
    if (!budget || budget <= 0) return undefined;
    
    return {
      thinking: {
        type: "enabled",
        budget_tokens: budget,
      },
    };
  }
  
  // Older Claude models don't support reasoning controls
  const budget = config.budgetTokens ?? MODE_TOKEN_BUDGETS[config.mode];
  if (!budget || budget <= 0) return undefined;
  
  return {
    thinking: {
      type: "enabled",
      budget_tokens: budget,
    },
  };
}

/**
 * Transform unified reasoning config to Gemini format
 */
export function toGeminiThinking(
  config: ReasoningConfig,
  modelId?: string
): { thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string; includeThoughts?: boolean } } | undefined {
  const isGemini3 = modelId?.toLowerCase().includes("gemini-3");
  const isGemini25 = modelId?.toLowerCase().includes("gemini-2.5");
  
  if (config.mode === "disabled") {
    return isGemini25 ? { thinkingConfig: { thinkingBudget: 0 } } : undefined;
  }
  
  // Gemini 2.x series - most don't expose reasoning controls via API
  // Only Gemini 2.0 Flash Thinking has explicit controls
  if (isGemini3 || isGemini25) {
    // Most Gemini models don't expose reasoning controls
    return undefined;
  }
  
  // Default: try token budget approach
  const budget = config.budgetTokens ?? MODE_TOKEN_BUDGETS[config.mode];
  if (!budget || budget <= 0) return undefined;
  
  return {
    thinkingConfig: {
      thinkingBudget: budget,
      ...(config.includeThoughts !== undefined && { includeThoughts: config.includeThoughts }),
    },
  };
}

/**
 * Apply reasoning configuration to provider-specific request params
 * This is the main entry point - call this with params and it will
 * inject the appropriate reasoning configuration
 */
export function applyReasoningConfig(
  params: Record<string, any>,
  config: ReasoningConfig,
  providerType: "openai" | "anthropic" | "gemini" | string,
  modelId?: string
): Record<string, any> {
  switch (providerType) {
    case "openai":
      const openaiReasoning = toOpenAIReasoning(config, modelId);
      return { ...params, ...openaiReasoning };
      
    case "anthropic":
      const anthropicThinking = toAnthropicThinking(config, modelId);
      return { ...params, ...anthropicThinking };
      
    case "gemini":
    case "google":
      const geminiThinking = toGeminiThinking(config, modelId);
      return { ...params, ...geminiThinking };
      
    default:
      // For unknown providers, try OpenAI format (most common)
      const defaultReasoning = toOpenAIReasoning(config, modelId);
      return { ...params, ...defaultReasoning };
  }
}

/**
 * Get a user-friendly description of what a reasoning mode does
 */
export function getReasoningModeDescription(mode: ReasoningMode): string {
  const descriptions: Record<ReasoningMode, string> = {
    disabled: "No reasoning - fastest responses, lowest cost",
    minimal: "Minimal reasoning - quick responses for simple tasks",
    low: "Low effort - faster responses with some reasoning",
    medium: "Balanced - good balance of speed and quality (default)",
    high: "High effort - thorough reasoning for complex tasks",
    max: "Maximum reasoning - deepest analysis, highest quality",
  };
  return descriptions[mode];
}

/**
 * Get estimated cost multiplier for a reasoning mode
 * These are rough estimates based on typical token usage
 */
export function getReasoningCostMultiplier(mode: ReasoningMode): number {
  const multipliers: Record<ReasoningMode, number> = {
    disabled: 1.0,
    minimal: 1.1,
    low: 1.3,
    medium: 1.6,
    high: 2.2,
    max: 3.0,
  };
  return multipliers[mode];
}

/**
 * All available reasoning modes for UI dropdowns
 */
export const ALL_REASONING_MODES: { value: ReasoningMode; label: string; description: string }[] = [
  { value: "disabled", label: "Disabled", description: "Fastest, no reasoning overhead" },
  { value: "minimal", label: "Minimal", description: "Quick responses" },
  { value: "low", label: "Low", description: "Faster with light reasoning" },
  { value: "medium", label: "Medium", description: "Balanced (recommended)" },
  { value: "high", label: "High", description: "Thorough reasoning" },
  { value: "max", label: "Maximum", description: "Deep analysis, highest quality" },
];

/**
 * Validate a reasoning configuration
 */
export function validateReasoningConfig(config: Partial<ReasoningConfig>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  if (!config.mode) {
    errors.push("Reasoning mode is required");
  } else if (!ALL_REASONING_MODES.find(m => m.value === config.mode)) {
    errors.push(`Invalid reasoning mode: ${config.mode}`);
  }
  
  if (config.budgetTokens !== undefined) {
    if (config.budgetTokens < 0 && config.budgetTokens !== -1) {
      errors.push("Budget tokens must be >= 0, or -1 for auto");
    }
    if (config.budgetTokens > 32768) {
      errors.push("Budget tokens cannot exceed 32768");
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}
