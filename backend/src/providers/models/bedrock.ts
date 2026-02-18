import type { ModelDef } from "@koryphaios/shared";

export const BedrockModels: ModelDef[] = [
  {
    id: "bedrock.claude-3.7-sonnet",
    name: "Bedrock: Claude 3.7 Sonnet",
    provider: "bedrock",
    apiModelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
    contextWindow: 200_000,
    maxOutputTokens: 20_000, // Bedrock default limits are often lower
    costPerMInputTokens: 3.0,
    costPerMOutputTokens: 15.0,
    costPerMInputCached: 3.75,
    costPerMOutputCached: 0.30,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];
