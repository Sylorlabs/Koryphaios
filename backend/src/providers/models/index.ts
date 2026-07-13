import type { ModelDef, ProviderName } from '@koryphaios/shared';
import { OpenAIModels } from './openai';
import { AnthropicModels } from './anthropic';
import { GoogleModels } from './google';
import { VertexAIModels } from './vertex';
import { OpenRouterModels } from './openrouter';
import { GroqModels } from './groq';
import { XAIModels } from './xai';
import { AzureModels } from './azure';
import { CopilotModels } from './copilot';
import { BedrockModels } from './bedrock';
import { LocalModels } from './local';
import { OllamaModels } from './ollama';
import { OpenCodeZenModels } from './opencodezen';
import { OpenCodeGoModels } from './opencodego';
import { CodexModels } from './codex';
import { ClaudeCodeModels } from './claude-code';
import { GrokModels } from './grok';
import { AntigravityModels } from './antigravity';
import { JulesModels } from './jules';
import {
  BasetenModels,
  CerebrasModels,
  CloudflareModels,
  CortecsModels,
  DeepInfraModels,
  DeepSeekModels,
  FireworksModels,
  GitLabModels,
  HuggingFaceModels,
  IonetModels,
  KimiCodeModels,
  MiniMaxModels,
  MoonshotModels,
  NebiusModels,
  OllamaCloudModels,
  ScalewayModels,
  TogetherAIModels,
  VeniceModels,
  VercelModels,
  ZAIModels,
  ZenMuxModels,
} from './newproviders';

// Combined fallback catalog — providers refresh live model lists from APIs/CLIs when connected.
// Entries here supply metadata until discovery succeeds and enrich ids that match remotely.
const ALL_MODELS: ModelDef[] = [
  ...OpenAIModels,
  ...AnthropicModels,
  ...GoogleModels,
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
  ...OpenCodeGoModels,
  ...CodexModels,
  ...ClaudeCodeModels,
  ...GrokModels,
  ...AntigravityModels,
  ...JulesModels,
  ...KimiCodeModels,
  ...ZAIModels,
  ...DeepSeekModels,
  ...MoonshotModels,
  ...TogetherAIModels,
  ...CerebrasModels,
  ...FireworksModels,
  ...HuggingFaceModels,
  ...DeepInfraModels,
  ...MiniMaxModels,
  ...NebiusModels,
  ...VeniceModels,
  ...ScalewayModels,
  ...IonetModels,
  ...ZenMuxModels,
  ...OllamaCloudModels,
  ...CloudflareModels,
  ...VercelModels,
  ...GitLabModels,
  ...BasetenModels,
  ...CortecsModels,
];

// Map for fast lookup by ID
export const MODEL_CATALOG: Record<string, ModelDef> = Object.fromEntries(
  ALL_MODELS.map((m) => [m.id, m]),
);

const MODEL_CATALOG_BY_PROVIDER = new Map<string, ModelDef>(
  ALL_MODELS.map((model) => [`${model.provider}:${model.id}`, model]),
);

/**
 * Resolve a model ID to its definition.
 */
export function resolveModel(modelId: string): ModelDef | undefined {
  return MODEL_CATALOG[modelId];
}

/** Resolve without allowing an identical model ID from another provider to win. */
export function resolveModelForProvider(
  modelId: string,
  provider: ProviderName,
): ModelDef | undefined {
  return MODEL_CATALOG_BY_PROVIDER.get(`${provider}:${modelId}`);
}

/**
 * Get all known models for a specific provider.
 */
export function getModelsForProvider(providerName: ProviderName): ModelDef[] {
  // AI Studio is the same Gemini model catalog as 'google' under a distinct
  // API-key-only provider entry — reuse it (with ids re-tagged to aistudio).
  if (providerName === 'aistudio') {
    return ALL_MODELS.filter((m) => m.provider === 'google').map((m) => ({
      ...m,
      id: `aistudio-${m.id}`,
      apiModelId: m.apiModelId ?? m.id,
      provider: 'aistudio' as ProviderName,
    }));
  }
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
 * Hook for looking up LIVE model definitions (discovered from a provider API or
 * CLI at runtime). Registered by the provider registry so this module stays free
 * of an import cycle. Live defs carrying `contextVerified` beat the static
 * catalog and the provider allowlist.
 */
type LiveModelResolver = (modelId: string, provider: ProviderName) => ModelDef | undefined;
let liveModelResolver: LiveModelResolver | null = null;

export function registerLiveModelResolver(resolver: LiveModelResolver): void {
  liveModelResolver = resolver;
}

function hasUsableContext(model: ModelDef | undefined): boolean {
  // Provider/CLI metadata occasionally exposes a boolean capability as 1.
  // Never present that as a one-token context window; fall through to the
  // verified catalog/real-model chain instead.
  return !!model && Number.isFinite(model.contextWindow) && model.contextWindow >= 1024;
}

/**
 * Resolve trustworthy context metadata for UI telemetry.
 *
 * Trust order:
 *  1. A live-discovered model def whose contextWindow the provider/CLI reported
 *     itself (`contextVerified`).
 *  2. A static catalog entry from a provider with verified documentation.
 *  3. For alias CLI models (claude-code etc.): the REAL underlying model the
 *     alias resolves to, looked up in the verified catalog via `realModelId`.
 */
export function resolveTrustedContextWindow(
  modelId: string,
  provider: ProviderName,
): {
  contextWindow?: number;
  contextKnown: boolean;
  contextSource?: 'live' | 'catalog' | 'alias';
} {
  // 1. Live provider/CLI-reported context window.
  const live = liveModelResolver?.(modelId, provider);
  if (live?.contextVerified && hasUsableContext(live)) {
    return { contextWindow: live.contextWindow, contextKnown: true, contextSource: 'live' };
  }

  const model = resolveModelForProvider(modelId, provider);
  if (!model) return { contextKnown: false };
  if (model.isGeneric) return { contextKnown: false };

  // 2. Provider-scoped built-in catalog. These definitions are the fallback
  // metadata for every API provider and CLI harness when live discovery does
  // not report a window itself.
  if (hasUsableContext(model)) {
    return { contextWindow: model.contextWindow, contextKnown: true, contextSource: 'catalog' };
  }

  // 3. CLI alias → real model chain (use the live-resolved realModelId when the
  //    probe has run, else the catalog's).
  const realId = live?.realModelId ?? model.realModelId;
  if (realId) {
    const real = resolveModel(realId);
    if (
      real &&
      !real.isGeneric &&
      hasUsableContext(real)
    ) {
      return { contextWindow: real.contextWindow, contextKnown: true, contextSource: 'alias' };
    }
  }

  return { contextKnown: false };
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
      !isLegacyModel(m),
  );

  if (sameProvider.length > 0) return sameProvider[0];
  return undefined;
}

/**
 * Check if a model is a legacy/deprecated model.
 * Includes retired models (e.g. Claude 3.7 Sonnet, Haiku 3.5 as of Feb 2026).
 */
export function isLegacyModel(modelOrId: string | ModelDef): boolean {
  const id = typeof modelOrId === 'string' ? modelOrId : modelOrId.id;
  const deprecatedIds = [
    'gpt-3.5-turbo',
    'gpt-4',
    'gpt-4-32k',
    'claude-1',
    'claude-2',
    'claude-instant',
    'claude-3.7-sonnet',
    'claude-3.5-haiku',
    'claude-3.5-sonnet',
  ];
  return deprecatedIds.includes(id);
}

/**
 * Get non-legacy models only.
 */
export function getNonLegacyModels(): ModelDef[] {
  return ALL_MODELS.filter((m) => !isLegacyModel(m));
}
