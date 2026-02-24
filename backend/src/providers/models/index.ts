import type { ModelDef, ProviderName } from "@koryphaios/shared";
import { OpenAIModels } from "./openai";
import { AnthropicModels } from "./anthropic";
import { GeminiModels } from "./gemini";
import { VertexAIModels } from "./vertex";
import { OpenRouterModels } from "./openrouter";
import { GroqModels } from "./groq";
import { XAIModels } from "./xai";
import { AzureModels } from "./azure";
import { CopilotModels } from "./copilot";
import { BedrockModels } from "./bedrock";
import { LocalModels } from "./local";
import { OllamaModels } from "./ollama";
import { OpenCodeZenModels } from "./opencodezen";
import { ClineModels } from "./cline";

// Combined list of all known models from REAL providers only
const ALL_MODELS: ModelDef[] = [
  ...OpenAIModels,
  ...AnthropicModels,
  ...GeminiModels,
  ...VertexAIModels,
  ...OpenRouterModels,
  ...GroqModels,
  ...XAIModels,
  ...AzureModels,
  ...CopilotModels,
  ...BedrockModels,
  ...LocalModels,
  ...OllamaModels,
  ...OpenCodeZenModels,
  ...ClineModels,
];

// Map for fast lookup by ID
export const MODEL_CATALOG: Record<string, ModelDef> = Object.fromEntries(
  ALL_MODELS.map((m) => [m.id, m])
);

/**
 * Resolve a model ID to its definition.
 */
export function resolveModel(modelId: string): ModelDef | undefined {
  return MODEL_CATALOG[modelId];
}

/**
 * Get all known models for a specific provider.
 */
export function getModelsForProvider(providerName: ProviderName): ModelDef[] {
  return ALL_MODELS.filter((m) => m.provider === providerName);
}

/**
 * Create a generic model definition for unknown models discovered at runtime.
 */
export function createGenericModel(id: string, provider: ProviderName): ModelDef {
  return {
    id,
    name: id,
    provider,
    contextWindow: 0,
    maxOutputTokens: 4_096,
    costPerMInputTokens: 0,
    costPerMOutputTokens: 0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    isGeneric: true,
  };
}

/**
 * Providers with verified context window documentation.
 */
const VERIFIED_CONTEXT_PROVIDERS = new Set<ProviderName>([
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
]);

/**
 * Resolve trustworthy context metadata for UI telemetry.
 */
export function resolveTrustedContextWindow(modelId: string, provider: ProviderName): { contextWindow?: number; contextKnown: boolean } {
  const model = resolveModel(modelId);
  if (!model) return { contextKnown: false };
  if (model.isGeneric) return { contextKnown: false };
  if (model.provider !== provider) return { contextKnown: false };
  if (!VERIFIED_CONTEXT_PROVIDERS.has(provider)) return { contextKnown: false };
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return { contextKnown: false };
  return { contextWindow: model.contextWindow, contextKnown: true };
}

/**
 * Find an alternative model with similar capabilities.
 */
export function findAlternativeModel(failedModelId: string): ModelDef | undefined {
  const original = resolveModel(failedModelId);
  if (!original || !original.tier) return undefined;

  const sameProvider = ALL_MODELS.filter(
    (m) =>
      m.provider === original.provider &&
      m.tier === original.tier &&
      m.id !== original.id &&
      !isLegacyModel(m)
  );

  if (sameProvider.length > 0) return sameProvider[0];
  return undefined;
}

/**
 * Check if a model is a legacy/deprecated model.
 * Includes retired models (e.g. Claude 3.7 Sonnet, Haiku 3.5 as of Feb 2026).
 */
export function isLegacyModel(modelOrId: string | ModelDef): boolean {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const deprecatedIds = [
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-32k",
    "claude-1",
    "claude-2",
    "claude-instant",
    "claude-3.7-sonnet",
    "claude-3.5-haiku",
    "claude-3.5-sonnet",
  ];
  return deprecatedIds.includes(id);
}

/**
 * Get non-legacy models only.
 */
export function getNonLegacyModels(): ModelDef[] {
  return ALL_MODELS.filter((m) => !isLegacyModel(m));
}
