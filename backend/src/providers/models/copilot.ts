import type { ModelDef } from "@koryphaios/shared";

/**
 * GitHub Copilot Model Catalog
 * 
 * Per https://docs.github.com/en/copilot/reference/ai-models/supported-models
 * Retired models are excluded (see Model retirement history on that page).
 * 
 * Last updated: February 2026
 * 
 * NOTE: Model IDs in this catalog do NOT include the "copilot." prefix.
 * The provider prefix is added by the frontend/backend when displaying/selecting models.
 * The apiModelId field contains the exact ID to send to the Copilot API.
 */

interface ModelDefinitionParams {
  apiId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  canReason: boolean;
  tier?: "flagship" | "fast" | "reasoning";
  /** Description of reasoning capabilities for documentation */
  reasoningDescription?: string;
  /** Supported reasoning levels if canReason is true */
  reasoningLevels?: string[];
}

const def = ({
  apiId,
  name,
  contextWindow,
  maxOutputTokens,
  canReason,
  tier = "flagship",
  reasoningDescription,
  reasoningLevels,
}: ModelDefinitionParams): ModelDef => ({
  id: apiId, // Note: No "copilot." prefix - added by the provider system
  name: `GitHub Copilot ${name}`,
  provider: "copilot",
  apiModelId: apiId,
  contextWindow,
  maxOutputTokens,
  costPerMInputTokens: 0,
  costPerMOutputTokens: 0,
  costPerMInputCached: 0,
  costPerMOutputCached: 0,
  canReason,
  supportsAttachments: true,
  supportsStreaming: true,
  tier,
});

// ============================================================================
// OpenAI Models
// ============================================================================

const OPENAI_MODELS: ModelDef[] = [
  def({
    apiId: "gpt-4.1",
    name: "GPT-4.1",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: false,
    reasoningDescription: "Standard model optimized for high-throughput single-pass responses. No native reasoning controls.",
  }),
  def({
    apiId: "gpt-5-mini",
    name: "GPT-5 mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Supports reasoning_effort parameter (minimal, low, medium, high). Fast variant with reasoning controls.",
    reasoningLevels: ["minimal", "low", "medium", "high"],
  }),
  def({
    apiId: "gpt-5.1",
    name: "GPT-5.1",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports reasoning_effort parameter (minimal, low, medium, high).",
    reasoningLevels: ["minimal", "low", "medium", "high"],
  }),
  def({
    apiId: "gpt-5.1-codex",
    name: "GPT-5.1-Codex",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports reasoning_effort parameter (minimal, low, medium, high, xhigh). Extended reasoning for complex coding tasks.",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
  }),
  def({
    apiId: "gpt-5.1-codex-mini",
    name: "GPT-5.1-Codex-Mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Fast variant with Adaptive Reasoning. Supports reasoning_effort (none for fast mode, low/medium for deeper logic).",
    reasoningLevels: ["none", "low", "medium"],
  }),
  def({
    apiId: "gpt-5.1-codex-max",
    name: "GPT-5.1-Codex-Max",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Maximum capability Codex model. Supports reasoning_effort (minimal, low, medium, high, xhigh).",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
  }),
  def({
    apiId: "gpt-5.2",
    name: "GPT-5.2",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports reasoning_effort parameter (minimal, low, medium, high).",
    reasoningLevels: ["minimal", "low", "medium", "high"],
  }),
  def({
    apiId: "gpt-5.2-codex",
    name: "GPT-5.2-Codex",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports reasoning_effort parameter (minimal, low, medium, high, xhigh).",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
  }),
  def({
    apiId: "gpt-5.3-codex",
    name: "GPT-5.3-Codex",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Latest Codex model. Supports reasoning_effort parameter (minimal, low, medium, high, xhigh).",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
  }),
];

// ============================================================================
// Anthropic Models
// ============================================================================

const ANTHROPIC_MODELS: ModelDef[] = [
  def({
    apiId: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Supports extended thinking with budget tokens (0, 1024, 8192, 24576). Fastest Claude model with reasoning.",
    reasoningLevels: ["0", "1024", "8192", "24576"],
  }),
  def({
    apiId: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports extended thinking with effort levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports extended thinking with effort levels (low, medium, high, max). Most capable Claude model.",
    reasoningLevels: ["low", "medium", "high", "max"],
  }),
  def({
    apiId: "claude-opus-4.6-fast",
    name: "Claude Opus 4.6 (fast mode) (preview)",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Fast mode variant still supports thinking.effort parameter (can dial down).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports extended thinking with effort levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports extended thinking with effort levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Supports extended thinking with effort levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
];

// ============================================================================
// Google Models
// ============================================================================

const GOOGLE_MODELS: ModelDef[] = [
  def({
    apiId: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    canReason: true,
    reasoningDescription: "Supports thinking budget controls (0, 1024, 8192, 24576 tokens).",
    reasoningLevels: ["0", "1024", "8192", "24576"],
  }),
  def({
    apiId: "gemini-3-flash",
    name: "Gemini 3 Flash",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Supports thinking levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "gemini-3-pro",
    name: "Gemini 3 Pro",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    canReason: true,
    reasoningDescription: "Supports thinking levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    canReason: true,
    reasoningDescription: "Supports thinking levels (low, medium, high).",
    reasoningLevels: ["low", "medium", "high"],
  }),
];

// ============================================================================
// xAI Models
// ============================================================================

const XAI_MODELS: ModelDef[] = [
  def({
    apiId: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: true,
    tier: "fast",
    reasoningDescription: "Speedy reasoning model with Summarized Thinking Traces via reasoning_content field.",
    reasoningLevels: ["low", "medium", "high"],
  }),
];

// ============================================================================
// Fine-tuned / Experimental Models
// ============================================================================

const EXPERIMENTAL_MODELS: ModelDef[] = [
  def({
    apiId: "raptor-mini",
    name: "Raptor mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    tier: "fast",
    reasoningDescription: "GitHub's experimental VS Code model with workspace-based reasoning for multi-file edits.",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "goldeneye",
    name: "Goldeneye",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: true,
    reasoningDescription: "Agentic model with perception-reasoning-acting loop. Excels in Chain-of-Thought and Planning tasks.",
    reasoningLevels: ["low", "medium", "high"],
  }),
];

// ============================================================================
// Export Complete Catalog
// ============================================================================

export const CopilotModels: ModelDef[] = [
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS,
  ...GOOGLE_MODELS,
  ...XAI_MODELS,
  ...EXPERIMENTAL_MODELS,
];

// Verify no duplicate IDs
const ids = CopilotModels.map(m => m.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) {
  throw new Error(`Duplicate Copilot model IDs found: ${duplicates.join(", ")}`);
}

// Export count for verification
export const COPILOT_MODEL_COUNT = CopilotModels.length;
