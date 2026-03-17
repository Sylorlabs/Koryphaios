import type { ModelDef } from "@koryphaios/shared";

/**
 * Official Gemini CLI Models (Exact IDs)
 * These IDs map to what the 'gcloud' / 'gemini' CLI expects.
 */
export const GeminiModels: ModelDef[] = [
  // Current Models (as of March 2026)
  {
    id: "gemini-2.0-pro",
    name: "Gemini 2.0 Pro",
    provider: "google",
    apiModelId: "gemini-2.0-pro-exp-02-05",
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    provider: "google",
    apiModelId: "gemini-2.0-flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-2.0-flash-lite",
    name: "Gemini 2.0 Flash Lite",
    provider: "google",
    apiModelId: "gemini-2.0-flash-lite",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  
  // Legacy Models (Gemini 1.5 series)
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro (Legacy)",
    provider: "google",
    apiModelId: "gemini-1.5-pro",
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 1.25,
    costPerMOutputTokens: 5.0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash (Legacy)",
    provider: "google",
    apiModelId: "gemini-1.5-flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.075,
    costPerMOutputTokens: 0.30,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
];
