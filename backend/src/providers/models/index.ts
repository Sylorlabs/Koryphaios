import type { ModelDef, ProviderName } from "@koryphaios/shared";
import { OpenAIModels } from "./openai";
import { AnthropicModels } from "./anthropic";
import { GeminiModels, AntigravityModels } from "./gemini";
import { VertexAIModels } from "./vertex";
import { OpenRouterModels } from "./openrouter";
import { GroqModels } from "./groq";
import { XAIModels } from "./xai";
import { AzureModels } from "./azure";
import { CopilotModels } from "./copilot";
import { BedrockModels } from "./bedrock";
import {
  DeepSeekModels,
  TogetherAIModels,
  CerebrasModels,
  FireworksModels,
  HuggingFaceModels,
  DeepInfraModels,
  MiniMaxModels,
  MoonshotModels,
  NebiusModels,
  VeniceModels,
  ScalewayModels,
  IonetModels,
  ZAIModels,
  ZenMuxModels,
  OpenCodeZenModels,
  OllamaCloudModels,
  CloudflareModels,
  VercelModels,
  GitLabModels,
  BasetenModels,
  FirmwareModels,
  CortecsModels,
  LocalModels,
  LMStudioModels,
  LlamaCppModels,
  OllamaModels,
} from "./newproviders";

// Combined list of all known models
const ALL_MODELS: ModelDef[] = [
  ...OpenAIModels,
  ...AnthropicModels,
  ...GeminiModels,
  ...AntigravityModels,
  ...VertexAIModels,
  ...OpenRouterModels,
  ...GroqModels,
  ...XAIModels,
  ...AzureModels,
  ...CopilotModels,
  ...BedrockModels,
  // New providers
  ...DeepSeekModels,
  ...TogetherAIModels,
  ...CerebrasModels,
  ...FireworksModels,
  ...HuggingFaceModels,
  ...DeepInfraModels,
  ...MiniMaxModels,
  ...MoonshotModels,
  ...NebiusModels,
  ...VeniceModels,
  ...ScalewayModels,
  ...IonetModels,
  ...ZAIModels,
  ...ZenMuxModels,
  ...OpenCodeZenModels,
  ...OllamaCloudModels,
  ...CloudflareModels,
  ...VercelModels,
  ...GitLabModels,
  ...BasetenModels,
  ...FirmwareModels,
  ...CortecsModels,
  ...LocalModels,
  ...LMStudioModels,
  ...LlamaCppModels,
  ...OllamaModels,
];

// Map for fast lookup by ID
export const MODEL_CATALOG: Record<string, ModelDef> = Object.fromEntries(
  ALL_MODELS.map((m) => [m.id, m])
);

/**
 * Resolve a model ID to its definition.
 * If not found, returns undefined (caller should handle generic fallback).
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
 * Uses safe defaults.
 */
export function createGenericModel(id: string, provider: ProviderName): ModelDef {
  return {
    id,
    name: id,
    provider,
    contextWindow: 0, // Unknown: do not treat as reliable context metadata
    maxOutputTokens: 4_096,
    costPerMInputTokens: 0, // Unknown
    costPerMOutputTokens: 0, // Unknown
    canReason: false,
    supportsAttachments: false, // Safer to assume no
    supportsStreaming: true,
    isGeneric: true,
  };
}

/**
 * Providers with official, first-party model context documentation we currently trust.
 * Verified February 15, 2026 from provider docs:
 * - OpenAI: https://platform.openai.com/docs/models
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models/all-models
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/models
 * - Groq: https://console.groq.com/docs/models
 * - xAI: https://docs.x.ai/docs/models
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
 * Returns unknown when model/provider metadata cannot be guaranteed.
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
 * Find an alternative model with similar capabilities (same tier/provider).
 * Useful for 429 rate limit fallbacks.
 */
export function findAlternativeModel(failedModelId: string): ModelDef | undefined {
  const original = resolveModel(failedModelId);
  if (!original || !original.tier) return undefined;

  // Look for another model from the same provider in the same tier
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
 * Check if a model is a legacy model.
 * Legacy models are deprecated and should not be used in auto mode.
 */
export function isLegacyModel(modelOrId: string | ModelDef): boolean {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const name = typeof modelOrId === "string" ? undefined : modelOrId.name;
  
  // Check by ID patterns
  if (id.includes("legacy") || id.includes("-legacy")) return true;
  
  // Check by name (if available)
  if (name && name.includes("(Legacy)")) return true;
  
  // Specific legacy model IDs that don't follow naming convention
  // Verified against official provider docs Feb 2026
  const KNOWN_LEGACY_IDS = [
    // OpenAI - Retired Feb 17, 2026
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4.5-preview",
    "gpt-4o",
    "gpt-4o-mini",
    "o1",
    "o1-pro",
    "o1-mini",
    "o3",
    "o3-mini",
    "o4-mini",
    "gpt-5",
    "chatgpt-4o-latest",
    "codex-mini-latest",
    // Anthropic - Retired 2025
    "claude-opus-4",
    "claude-opus-4-0",
    "claude-sonnet-4-0",
    "claude-sonnet-3.5",
    "claude-sonnet-3.7",
    "claude-sonnet-3.7-thought",
    "claude-3.5-sonnet",
    "claude-3.5-haiku",
    "claude-3-haiku",
    "claude-3-opus",
    // Google Gemini - Only deprecated in Copilot, still available in API
    // gemini-2.0-flash, gemini-2.0-flash-lite - retired
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    // xAI Grok
    "grok-4",
    "grok-3",
    "grok-3-beta",
    "grok-3-mini-beta",
    // GitHub Copilot only (not direct API)
    "gemini-2.5-pro", // Copilot deprecated Feb 2026
    "claude-opus-4-1", // Copilot deprecated Feb 2026
  ];
  
  return KNOWN_LEGACY_IDS.includes(id);
}

/**
 * Get non-legacy models only.
 * Useful for auto mode to exclude deprecated models.
 */
export function getNonLegacyModels(): ModelDef[] {
  return ALL_MODELS.filter((m) => !isLegacyModel(m));
}
