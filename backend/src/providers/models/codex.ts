import type { ModelDef } from "@koryphaios/shared";

/**
 * Codex CLI models — accessed via `codex` CLI (ChatGPT/Codex subscription).
 * Uses OpenAI's Codex model series.
 */
export const CodexModels: ModelDef[] = [
  {
    id: "codex-o3-mini",
    name: "Codex o3-mini",
    provider: "codex",
    apiModelId: "o3-mini",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    costPerMInputTokens: 1.10,
    costPerMOutputTokens: 4.40,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "reasoning",
  },
  {
    id: "codex-o1-mini",
    name: "Codex o1-mini",
    provider: "codex",
    apiModelId: "o1-mini",
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    costPerMInputTokens: 1.10,
    costPerMOutputTokens: 4.40,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "reasoning",
  },
];
