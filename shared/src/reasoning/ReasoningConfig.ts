// Reasoning Configuration Data
// Domain: Data-driven configuration for LLM reasoning/thinking modes
// This replaces repetitive rule-based configuration with structured data.

import type { ReasoningRule, ReasoningOption, ReasoningConfig } from "./ReasoningTypes";

// Standard reasoning options shared across providers
export const STANDARD_REASONING_OPTIONS: Record<string, ReasoningOption> = {
  none: { value: "none", label: "None", description: "Standard generation without explicit reasoning" },
  low: { value: "low", label: "Low", description: "Minimal reasoning effort for speed" },
  medium: { value: "medium", label: "Medium", description: "Balanced depth and speed" },
  high: { value: "high", label: "High", description: "Thorough reasoning for complex tasks" },
  xhigh: { value: "xhigh", label: "xhigh", description: "Deepest possible reasoning budget" },
  adaptive: { value: "adaptive", label: "Auto", description: "Model automatically decides reasoning level based on task" },
};

// Extended reasoning options
const EXTENDED_REASONING_OPTIONS: Record<string, ReasoningOption> = {
  ...STANDARD_REASONING_OPTIONS,
  minimal: { value: "minimal", label: "Minimal", description: "Lightest available explicit reasoning effort" },
  max: { value: "max", label: "Max", description: "Maximum capability, no token constraints (Opus 4.6 only)" },
  off: { value: "off", label: "Off", description: "Disable explicit reasoning mode" },
  on: { value: "on", label: "On", description: "Enable default reasoning mode" },
  default: { value: "default", label: "Default", description: "Provider default reasoning mode" },
  // Budget-based options (Gemini, Haiku 4.5)
  budget_0: { value: "0", label: "Off", description: "Disable thinking budget" },
  budget_1024: { value: "1024", label: "Low", description: "Thinking budget: 1,024 tokens" },
  budget_8192: { value: "8192", label: "Medium", description: "Thinking budget: 8,192 tokens" },
  budget_24576: { value: "24576", label: "High", description: "Thinking budget: 24,576 tokens" },
  budget_65536: { value: "65536", label: "xhigh", description: "Thinking budget: 65,536 tokens" },
};

// Helper to create reasoning config
function createConfig(
  parameter: string,
  options: (keyof typeof EXTENDED_REASONING_OPTIONS)[],
  defaultValue: string,
): ReasoningConfig {
  return {
    parameter,
    options: options.map((key) => EXTENDED_REASONING_OPTIONS[key]),
    defaultValue,
  };
}

// Anthropic reasoning configurations
const ANTHROPIC_CONFIGS: Record<string, ReasoningConfig | null> = {
  // Opus 4.6: adaptive thinking with effort levels (low, medium, high, max)
  "claude-opus-4-6": createConfig(
    "thinking.effort",
    ["low", "medium", "high", "max"],
    "medium",
  ),
  // Sonnet 4.6: adaptive thinking with effort levels (no max)
  "claude-sonnet-4-6": createConfig(
    "thinking.effort",
    ["low", "medium", "high"],
    "medium",
  ),
  // Haiku 4.5: budget-based thinking
  "claude-haiku-4-5": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
  // Other Anthropic models: thinking on/off
  "default-anthropic": createConfig("thinking.type", ["off", "on"], "on"),
};

// OpenAI reasoning configurations
const OPENAI_CONFIGS: Record<string, ReasoningConfig | null> = {
  // o1-mini: no explicit reasoning config
  "o1-mini": null,
  // GPT-5: full effort range
  "gpt-5": createConfig(
    "reasoning.effort",
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  // o1/o3/o4: limited effort range
  "o1-series": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  // Default OpenAI: no reasoning config
  "default-openai": null,
};

// Google reasoning configurations
const GOOGLE_CONFIGS: Record<string, ReasoningConfig | null> = {
  // Gemini 3.x: level-based thinking
  "gemini-3": createConfig("thinkingConfig.thinkingLevel", ["low", "medium", "high"], "medium"),
  // Gemini 2.5 Pro: budget-based thinking
  "gemini-2.5": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
  // Default Google: budget-based
  "default-google": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
};

// Azure (same as OpenAI but with azure prefix)
const AZURE_CONFIGS: Record<string, ReasoningConfig | null> = {
  "azure.o1-mini": null,
  "azure.gpt-5": createConfig(
    "reasoning.effort",
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  "azure.o1-series": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  "default-azure": null,
};

// Groq reasoning configurations
const GROQ_CONFIGS: Record<string, ReasoningConfig | null> = {
  // Qwen models: reasoning effort on/off
  "qwen": createConfig("reasoning_effort", ["none", "default"], "default"),
  // Default Groq: no reasoning
  "default-groq": null,
};

// xAI reasoning configurations
const XAI_CONFIGS: Record<string, ReasoningConfig | null> = {
  // Grok 3 Mini: low/high effort
  "grok-3-mini": createConfig("reasoning_effort", ["low", "high"], "high"),
  // Default xAI: no reasoning
  "default-xai": null,
};

// OpenRouter reasoning configurations
const OPENROUTER_CONFIGS: Record<string, ReasoningConfig | null> = {
  // OpenAI o-series through OpenRouter
  "openrouter.o1-series": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  // Default OpenRouter: no reasoning
  "default-openrouter": null,
};

// Copilot reasoning configurations (complex - many model families)
const COPILOT_CONFIGS: Record<string, ReasoningConfig | null> = {
  // GPT-5.1/5.2 Codex: full effort range
  "gpt-5.1-codex": createConfig(
    "reasoning.effort",
    ["none", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  "gpt-5.2-codex": createConfig(
    "reasoning.effort",
    ["none", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  "gpt-5.1-codex-max": createConfig(
    "reasoning.effort",
    ["none", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  // Claude Opus 4.6 in Copilot: with max
  "claude-opus-4.6": createConfig("thinking.effort", ["low", "medium", "high", "max"], "medium"),
  // Claude Opus 4.5/Sonnet 4.x: no max
  "claude-opus-4.5": createConfig("thinking.effort", ["low", "medium", "high"], "medium"),
  "claude-sonnet-4": createConfig("thinking.effort", ["low", "medium", "high"], "medium"),
  "claude-sonnet-4.5": createConfig("thinking.effort", ["low", "medium", "high"], "medium"),
  "claude-sonnet-4.6": createConfig("thinking.effort", ["low", "medium", "high"], "medium"),
  // Claude Haiku 4.5: budget-based
  "claude-haiku-4.5": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
  // Gemini 3.x: level-based
  "gemini-3": createConfig("thinkingConfig.thinkingLevel", ["low", "medium", "high"], "medium"),
  // Gemini 2.5 Pro: budget-based
  "gemini-2.5-pro": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
  // GPT-5 mini/5.1/5.2 and codex-mini: reasoning effort (no xhigh)
  "gpt-5-mini": createConfig("reasoning.effort", ["minimal", "low", "medium", "high"], "medium"),
  "gpt-5.1": createConfig("reasoning.effort", ["minimal", "low", "medium", "high"], "medium"),
  "gpt-5.1-codex-mini": createConfig("reasoning.effort", ["none", "low", "medium"], "medium"),
  "gpt-5.2": createConfig("reasoning.effort", ["minimal", "low", "medium", "high"], "medium"),
  // GPT-5.3 Codex: full effort range
  "gpt-5.3-codex": createConfig(
    "reasoning.effort",
    ["none", "low", "medium", "high", "xhigh"],
    "medium",
  ),
  // Claude Opus 4.6 fast: no max
  "claude-opus-4.6-fast": createConfig("thinking.effort", ["low", "medium", "high"], "medium"),
  // Grok Code Fast 1
  "grok-code-fast-1": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  // Raptor mini
  "raptor-mini": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  // Goldeneye
  "goldeneye": createConfig("reasoning.effort", ["low", "medium", "high"], "medium"),
  // Default Copilot: no reasoning
  "default-copilot": null,
};

// VertexAI (Google Cloud) configurations
const VERTEXAI_CONFIGS: Record<string, ReasoningConfig | null> = {
  "vertexai.gemini-2.5": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
  "vertexai.gemini-3": createConfig("thinkingConfig.thinkingLevel", ["low", "medium", "high"], "medium"),
  "default-vertexai": createConfig(
    "thinkingConfig.thinkingBudget",
    ["budget_0", "budget_1024", "budget_8192", "budget_24576"],
    "8192",
  ),
};

// Codex reasoning configuration
const CODEX_CONFIGS: Record<string, ReasoningConfig | null> = {
  "default-codex": createConfig(
    "reasoning.effort",
    ["adaptive", "none", "low", "medium", "high"],
    "adaptive",
  ),
};

// Default configuration for providers without explicit reasoning
const NO_REASONING: ReasoningConfig | null = null;

// Provider list that doesn't support reasoning (static list)
const NO_REASONING_PROVIDERS = [
  "bedrock",
  "local",
  "deepseek",
  "togetherai",
  "cerebras",
  "fireworks",
  "huggingface",
  "baseten",
  "cloudflare",
  "vercel",
  "ollama",
  "ollamacloud",
  "lmstudio",
  "llamacpp",
  "minimax",
  "moonshot",
  "nebius",
  "venice",
  "deepinfra",
  "scaleway",
  "ovhcloud",
  "sapai",
  "stackit",
  "ionet",
  "zai",
  "zenmux",
  "opencodezen",
  "firmware",
  "cortecs",
  "azurecognitive",
  "gitlab",
  "mistralai",
  "cohere",
  "perplexity",
  "luma",
  "fal",
  "replicate",
  "modal",
  "hyperbolic",
  "stepfun",
  "qwen",
  "alibaba",
  "cloudflareworkers",
  "helicone",
  "portkey",
  "elevenlabs",
  "deepgram",
  "gladia",
  "lmnt",
  "nvidia",
  "nim",
  "friendliai",
  "voyageai",
  "mixedbread",
  "mem0",
  "letta",
  "chromeai",
  "requesty",
  "aihubmix",
  "aimlapi",
  "blackforestlabs",
  "klingai",
  "prodia",
  "302ai",
  "assemblyai",
];

// Build reasoning rules from configuration data
function buildRules(
  provider: string,
  configs: Record<string, ReasoningConfig | null>,
): ReasoningRule[] {
  const rules: ReasoningRule[] = [];

  for (const [pattern, config] of Object.entries(configs)) {
    // Skip default entries (they become fallback rules)
    if (pattern.startsWith("default-")) {
      continue;
    }

    // Convert pattern to regex
    let modelPattern: RegExp | undefined;
    if (pattern !== "all") {
      modelPattern = new RegExp(`^${pattern.replace(/\./g, "\\.")}`, "i");
    }

    rules.push({
      provider,
      modelPattern,
      config,
    });
  }

  // Add fallback rule (default config)
  const defaultConfig = configs[`default-${provider}`] ?? null;
  rules.push({
    provider,
    modelPattern: undefined,
    config: defaultConfig,
  });

  return rules;
}

// Complete reasoning rules for all providers
export const DEFAULT_REASONING_RULES: ReasoningRule[] = [
  // Auto-detection rule
  {
    provider: "auto",
    config: createConfig("reasoning", ["none", "low", "medium", "high", "xhigh", "adaptive"], "medium"),
  },
  // Anthropic
  ...buildRules("anthropic", ANTHROPIC_CONFIGS),
  // OpenAI
  ...buildRules("openai", OPENAI_CONFIGS),
  // Google
  ...buildRules("google", GOOGLE_CONFIGS),
  // Azure
  ...buildRules("azure", AZURE_CONFIGS),
  // Groq
  ...buildRules("groq", GROQ_CONFIGS),
  // xAI
  ...buildRules("xai", XAI_CONFIGS),
  // OpenRouter
  ...buildRules("openrouter", OPENROUTER_CONFIGS),
  // Copilot (complex - need custom rules)
  ...buildRules("copilot", COPILOT_CONFIGS),
  // VertexAI
  ...buildRules("vertexai", VERTEXAI_CONFIGS),
  // Codex
  ...buildRules("codex", CODEX_CONFIGS),
  // All providers without reasoning support
  ...NO_REASONING_PROVIDERS.map((provider) => ({
    provider,
    config: NO_REASONING,
  })),
];
