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
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet (via Cline)",
    provider: "cline",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerMInputTokens: 3.0,
    costPerMOutputTokens: 15.0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude 4 Opus (via Cline)",
    provider: "cline",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerMInputTokens: 15.0,
    costPerMOutputTokens: 75.0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
  {
    id: "claude-4-5-sonnet-20251022",
    name: "Claude 4.5 Sonnet (via Cline)",
    provider: "cline",
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    costPerMInputTokens: 2.5,
    costPerMOutputTokens: 12.5,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
  },
];
