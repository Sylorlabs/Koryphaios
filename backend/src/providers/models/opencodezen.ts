import type { ModelDef } from "@koryphaios/shared";

/**
 * OpenCode Zen — curated models at opencode.ai/zen (API key from opencode.ai/auth).
 * Additional models are discovered via GET /v1/models when the provider is configured.
 */
export const OpenCodeZenModels: ModelDef[] = [
  {
    id: "opencodezen.claude-sonnet-4",
    name: "Claude Sonnet 4 (Zen)",
    provider: "opencodezen",
    apiModelId: "claude-sonnet-4",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "opencodezen.gpt-4.1",
    name: "GPT-4.1 (Zen)",
    provider: "opencodezen",
    apiModelId: "gpt-4.1",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 2,
    costPerMOutputTokens: 8,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "opencodezen.default",
    name: "OpenCode Zen (auto)",
    provider: "opencodezen",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "fast",
    isGeneric: true,
  },
];
