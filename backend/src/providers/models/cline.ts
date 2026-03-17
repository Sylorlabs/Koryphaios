import type { ModelDef } from "@koryphaios/shared";

/**
 * Cline models - fetched dynamically from Cline's API
 * These are placeholder definitions; actual models are fetched at runtime.
 * Cline provides access to various models through their WorkOS-based auth.
 */
export const ClineModels: ModelDef[] = [
  // Cline uses WorkOS auth and provides access to various models
  // The actual available models depend on the user's Cline subscription
  // These are common models accessible through Cline
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet (via Cline)",
    provider: "cline",
    apiModelId: "claude-3-7-sonnet-20250219",
    contextWindow: 200_000,
    maxOutputTokens: 50_000,
    costPerMInputTokens: 3.0,
    costPerMOutputTokens: 15.0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet (via Cline)",
    provider: "cline",
    apiModelId: "claude-3-5-sonnet-20241022",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 3.0,
    costPerMOutputTokens: 15.0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-3-opus",
    name: "Claude 3 Opus (via Cline)",
    provider: "cline",
    apiModelId: "claude-3-opus-20240229",
    contextWindow: 200_000,
    maxOutputTokens: 4_096,
    costPerMInputTokens: 15.0,
    costPerMOutputTokens: 75.0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
  },
];
