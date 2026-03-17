import type { ModelDef } from "@koryphaios/shared";

/**
 * GitHub Copilot Model Catalog
 * 
 * Per https://docs.github.com/en/copilot/reference/ai-models/supported-models
 * Retired models are excluded (see Model retirement history on that page).
 * 
 * Last updated: March 2026
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
    apiId: "gpt-4o",
    name: "GPT-4o",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: false,
    reasoningDescription: "Standard model optimized for high-throughput single-pass responses. No native reasoning controls.",
  }),
  def({
    apiId: "gpt-4o-mini",
    name: "GPT-4o mini",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    canReason: false,
    tier: "fast",
    reasoningDescription: "Fast, cost-effective model for simpler tasks.",
  }),
  def({
    apiId: "o1",
    name: "o1",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    canReason: true,
    tier: "reasoning",
    reasoningDescription: "Reasoning model that thinks before responding. Supports reasoning effort controls.",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "o1-mini",
    name: "o1-mini",
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    canReason: true,
    tier: "reasoning",
    reasoningDescription: "Faster reasoning model for coding tasks.",
    reasoningLevels: ["low", "medium", "high"],
  }),
  def({
    apiId: "o3-mini",
    name: "o3-mini",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    canReason: true,
    tier: "reasoning",
    reasoningDescription: "Latest reasoning model with improved coding capabilities.",
    reasoningLevels: ["low", "medium", "high"],
  }),
];

// ============================================================================
// Anthropic Models (via Copilot)
// ============================================================================

const ANTHROPIC_MODELS: ModelDef[] = [
  def({
    apiId: "claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    canReason: false,
    reasoningDescription: "Balanced performance and speed. No native reasoning controls via Copilot.",
  }),
];

// ============================================================================
// Google Models (via Copilot)
// ============================================================================

const GOOGLE_MODELS: ModelDef[] = [
  def({
    apiId: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    canReason: false,
    tier: "fast",
    reasoningDescription: "Fast multimodal model with large context window.",
  }),
  def({
    apiId: "gemini-2.0-pro",
    name: "Gemini 2.0 Pro",
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
    canReason: false,
    reasoningDescription: "Advanced multimodal model for complex tasks.",
  }),
];

// ============================================================================
// Export Complete Catalog
// ============================================================================

export const CopilotModels: ModelDef[] = [
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS,
  ...GOOGLE_MODELS,
];

// Verify no duplicate IDs
const ids = CopilotModels.map(m => m.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length > 0) {
  throw new Error(`Duplicate Copilot model IDs found: ${duplicates.join(", ")}`);
}

// Export count for verification
export const COPILOT_MODEL_COUNT = CopilotModels.length;
