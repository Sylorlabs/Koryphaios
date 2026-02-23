import type { ModelDef } from "@koryphaios/shared";

// Only models currently supported per https://docs.github.com/en/copilot/reference/ai-models/supported-models
// Retired models are excluded (see Model retirement history on that page).
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
  def("gpt-4.1", "GPT-4.1", 128_000, 16_384, true),
  def("gpt-5-mini", "GPT-5 mini", 128_000, 16_384, false, "fast"),
  def("gpt-5.1", "GPT-5.1", 128_000, 16_384, true),
  def("gpt-5.1-codex", "GPT-5.1-Codex", 128_000, 16_384, false),
  def("gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini", 128_000, 16_384, false, "fast"),
  def("gpt-5.1-codex-max", "GPT-5.1-Codex-Max", 128_000, 16_384, true),
  def("gpt-5.2", "GPT-5.2", 128_000, 16_384, true),
  def("gpt-5.2-codex", "GPT-5.2-Codex", 128_000, 16_384, false),
  def("gpt-5.3-codex", "GPT-5.3-Codex", 128_000, 16_384, false),
  def("claude-haiku-4.5", "Claude Haiku 4.5", 128_000, 8_192, false, "fast"),
  def("claude-opus-4.5", "Claude Opus 4.5", 128_000, 16_384, true),
  def("claude-opus-4.6", "Claude Opus 4.6", 128_000, 16_384, true),
  def("claude-opus-4.6-fast", "Claude Opus 4.6 fast", 128_000, 16_384, false),
  def("claude-sonnet-4", "Claude Sonnet 4", 128_000, 16_000, true),
  def("claude-sonnet-4.5", "Claude Sonnet 4.5", 128_000, 16_000, true),
  def("claude-sonnet-4.6", "Claude Sonnet 4.6", 128_000, 16_000, true),
  def("gemini-2.5-pro", "Gemini 2.5 Pro", 128_000, 64_000, true),
  def("gemini-3-flash", "Gemini 3 Flash", 128_000, 8_192, false, "fast"),
  def("gemini-3-pro", "Gemini 3 Pro", 128_000, 64_000, true),
  def("gemini-3.1-pro", "Gemini 3.1 Pro", 128_000, 64_000, true),
  def("grok-code-fast-1", "Grok Code Fast 1", 128_000, 8_192, false, "fast"),
  def("raptor-mini", "Raptor mini", 128_000, 16_384, false, "fast"),
  def("goldeneye", "Goldeneye", 128_000, 16_384, false),
];
