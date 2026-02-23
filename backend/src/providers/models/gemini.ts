import type { ModelDef } from "@koryphaios/shared";

/**
 * Official Gemini CLI Models (Exact IDs)
 * These IDs map to what the 'gemini' CLI expects in its --model flag.
 */
export const GeminiModels: ModelDef[] = [
  // Auto-Select Models (CLI dynamic mapping)
  {
    id: "auto-gemini-3",
    name: "Gemini 3 (Auto)",
    provider: "google",
    apiModelId: "gemini-3",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0.15,
    costPerMOutputTokens: 0.6,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "auto-gemini-2.5",
    name: "Gemini 2.5 (Auto)",
    provider: "google",
    apiModelId: "gemini-2.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0.1,
    costPerMOutputTokens: 0.4,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },

  // Specific Model Versions — Gemini 3.1 (Feb 2026)
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    provider: "google",
    apiModelId: "gemini-3.1-pro-preview",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 1.5,
    costPerMOutputTokens: 15,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  // Specific Model Versions
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    provider: "google",
    apiModelId: "gemini-3-pro-preview",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 1.5,
    costPerMOutputTokens: 15,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    provider: "google",
    apiModelId: "gemini-3-flash-preview",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0.15,
    costPerMOutputTokens: 0.6,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-2.0-pro-exp",
    name: "Gemini 2.0 Pro Experimental",
    provider: "google",
    apiModelId: "gemini-2.0-pro-exp-02-05", // Exact API/CLI ID
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "gemini-2.0-flash-exp",
    name: "Gemini 2.0 Flash Experimental",
    provider: "google",
    apiModelId: "gemini-2.0-flash-exp",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-2.0-flash-001",
    name: "Gemini 2.0 Flash (Legacy)",
    provider: "google",
    apiModelId: "gemini-2.0-flash-001",
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.1,
    costPerMOutputTokens: 0.4,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    apiModelId: "gemini-2.5-flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 50_000,
    costPerMInputTokens: 0.3,
    costPerMOutputTokens: 2.5,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    apiModelId: "gemini-2.5-pro",
    contextWindow: 1_000_000,
    maxOutputTokens: 50_000,
    costPerMInputTokens: 1.25,
    costPerMOutputTokens: 10,

    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

// Antigravity models removed - using real providers only
