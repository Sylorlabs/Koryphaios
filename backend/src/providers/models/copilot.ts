import type { ModelDef } from "@koryphaios/shared";

// Only models currently supported per https://docs.github.com/en/copilot/reference/ai-models/supported-models
// Retired models are excluded (see Model retirement history on that page).
// Last updated: February 2026
const def = (apiId: string, name: string, contextWindow: number, maxOut: number, canReason: boolean, tier: "flagship" | "fast" | "reasoning" = "flagship"): ModelDef => ({
  id: `copilot.${apiId}`,
  name: `GitHub Copilot ${name}`,
  provider: "copilot",
  apiModelId: apiId,
  contextWindow,
  maxOutputTokens: maxOut,
  costPerMInputTokens: 0,
  costPerMOutputTokens: 0,
  costPerMInputCached: 0,
  costPerMOutputCached: 0,
  canReason: canReason,
  supportsAttachments: true,
  supportsStreaming: true,
  tier,
});

export const CopilotModels: ModelDef[] = [
  // OpenAI models
  // GPT-4.1: Standard model, no explicit reasoning controls
  def("gpt-4.1", "GPT-4.1", 128_000, 16_384, false),
  // GPT-5 mini: Supports reasoning_effort (minimal, low, medium, high)
  def("gpt-5-mini", "GPT-5 mini", 128_000, 16_384, true, "fast"),
  // GPT-5.1: Supports reasoning_effort (minimal, low, medium, high)
  def("gpt-5.1", "GPT-5.1", 128_000, 16_384, true),
  // GPT-5.1-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  def("gpt-5.1-codex", "GPT-5.1-Codex", 128_000, 16_384, true),
  // GPT-5.1-Codex-Mini: Fast variant with Adaptive Reasoning
  def("gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini", 128_000, 16_384, true, "fast"),
  // GPT-5.1-Codex-Max: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  def("gpt-5.1-codex-max", "GPT-5.1-Codex-Max", 128_000, 16_384, true),
  // GPT-5.2: Supports reasoning_effort (minimal, low, medium, high)
  def("gpt-5.2", "GPT-5.2", 128_000, 16_384, true),
  // GPT-5.2-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  def("gpt-5.2-codex", "GPT-5.2-Codex", 128_000, 16_384, true),
  // GPT-5.3-Codex: Supports reasoning_effort (minimal, low, medium, high, xhigh)
  def("gpt-5.3-codex", "GPT-5.3-Codex", 128_000, 16_384, true),
  
  // Anthropic models
  // Claude Haiku 4.5: Supports extended thinking with budget tokens
  def("claude-haiku-4.5", "Claude Haiku 4.5", 128_000, 8_192, true, "fast"),
  // Claude Opus 4.5: Supports extended thinking (low/medium/high effort)
  def("claude-opus-4.5", "Claude Opus 4.5", 128_000, 16_384, true),
  // Claude Opus 4.6: Supports extended thinking (low/medium/high/max effort)
  def("claude-opus-4.6", "Claude Opus 4.6", 128_000, 16_384, true),
  // Claude Opus 4.6 fast: Fast mode variant, still supports thinking.effort (can dial down)
  def("claude-opus-4.6-fast", "Claude Opus 4.6 (fast mode) (preview)", 128_000, 16_384, true, "fast"),
  // Claude Sonnet 4: Supports extended thinking (low/medium/high effort)
  def("claude-sonnet-4", "Claude Sonnet 4", 128_000, 16_384, true),
  // Claude Sonnet 4.5: Supports extended thinking (low/medium/high effort)
  def("claude-sonnet-4.5", "Claude Sonnet 4.5", 128_000, 16_384, true),
  // Claude Sonnet 4.6: Supports extended thinking (low/medium/high effort)
  def("claude-sonnet-4.6", "Claude Sonnet 4.6", 128_000, 16_384, true),
  
  // Google models
  // Gemini 2.5 Pro: Supports thinking budget controls
  def("gemini-2.5-pro", "Gemini 2.5 Pro", 128_000, 64_000, true),
  // Gemini 3 Flash: Supports thinking levels (low/medium/high)
  def("gemini-3-flash", "Gemini 3 Flash", 128_000, 8_192, true, "fast"),
  // Gemini 3 Pro: Supports thinking levels (low/medium/high)
  def("gemini-3-pro", "Gemini 3 Pro", 128_000, 64_000, true),
  // Gemini 3.1 Pro: Supports thinking levels (low/medium/high)
  def("gemini-3.1-pro", "Gemini 3.1 Pro", 128_000, 64_000, true),
  
  // xAI models
  // Grok Code Fast 1: Speedy reasoning model with Summarized Thinking Traces
  def("grok-code-fast-1", "Grok Code Fast 1", 128_000, 8_192, true, "fast"),
  
  // Fine-tuned models
  // Raptor mini: Workspace-based reasoning for multi-file edits
  def("raptor-mini", "Raptor mini", 128_000, 16_384, true, "fast"),
  // Goldeneye: Agentic model with perception-reasoning-acting loop
  def("goldeneye", "Goldeneye", 128_000, 16_384, true),
];
