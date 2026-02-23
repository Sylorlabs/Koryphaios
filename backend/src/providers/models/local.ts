import type { ModelDef } from "@koryphaios/shared";

/**
 * Local/Custom endpoint models
 * These are generic placeholders for local LLM servers
 */
export const LocalModels: ModelDef[] = [
  {
    id: "local.default",
    name: "Local Model",
    provider: "local",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "fast",
    isGeneric: true,
  },
];
