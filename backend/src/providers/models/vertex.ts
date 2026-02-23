import type { ModelDef } from "@koryphaios/shared";

/**
 * Curated Vertex AI model list (fallback). Vertex uses GCP auth and a different API;
 * this list is kept in sync with Vertex AI docs. For dynamic discovery, a future
 * integration could call Vertex AI's list models endpoint.
 */
export const VertexAIModels: ModelDef[] = [
  {
    id: "vertexai.gemini-2.5-flash",
    name: "VertexAI – Gemini 2.5 Flash",
    provider: "vertexai",
    apiModelId: "gemini-2.5-flash-preview-04-17",
    contextWindow: 1_000_000,
    maxOutputTokens: 50_000,
    costPerMInputTokens: 0.15,
    costPerMOutputTokens: 0.60,
    costPerMInputCached: 0,
    costPerMOutputCached: 0,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
  {
    id: "vertexai.gemini-2.5-pro",
    name: "VertexAI – Gemini 2.5 Pro",
    provider: "vertexai",
    apiModelId: "gemini-2.5-pro-preview-03-25",
    contextWindow: 1_000_000,
    maxOutputTokens: 50_000,
    costPerMInputTokens: 1.25,
    costPerMOutputTokens: 10.0,
    costPerMInputCached: 0,
    costPerMOutputCached: 0,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];
