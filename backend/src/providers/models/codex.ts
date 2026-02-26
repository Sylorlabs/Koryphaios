import type { ModelDef } from "@koryphaios/shared";

/**
 * Codex CLI models — accessed via `codex` CLI (ChatGPT/Codex subscription).
 */
export const CodexModels: ModelDef[] = [
  {
    id: "gpt-5.3-codex",
    name: "GPT 5.3 Codex",
    provider: "codex",
    contextWindow: 500_000,
    maxOutputTokens: 128_000,
    costPerMInputTokens: 1.50,
    costPerMOutputTokens: 12.0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT 5.2 Codex",
    provider: "codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPerMInputTokens: 1.25,
    costPerMOutputTokens: 10.0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];
