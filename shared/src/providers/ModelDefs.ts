// Model Definitions
// Domain: LLM model specifications and capabilities

import type { ProviderName } from "./ProviderNames";

// Re-export for convenience
export type { ProviderName } from "./ProviderNames";

export type ModelTier = "flagship" | "fast" | "cheap" | "reasoning";

export interface ModelDef {
  id: string;
  name: string;
  provider: ProviderName;
  /** Model ID sent to the API. Defaults to `id` if omitted. Used when API expects a different name (e.g., OpenRouter "openai/gpt-4.1"). */
  apiModelId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  costPerMInputCached?: number;
  costPerMOutputCached?: number;
  canReason?: boolean;
  supportsAttachments?: boolean;
  supportsStreaming?: boolean;
  tier?: ModelTier;
  isGeneric?: boolean;
  reasoningBudget?: number;
  // Additional metadata
  deprecated?: boolean;
  beta?: boolean;
  vision?: boolean;
  functionCall?: boolean;
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled: boolean;
  /** List of model IDs enabled by the user. If empty or undefined, all are enabled. */
  selectedModels?: string[];
  /** Whether to skip the model selection dialog in the future. */
  hideModelSelector?: boolean;
  headers?: Record<string, string>;
}

export interface ProviderStatus {
  name: ProviderName;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  availableModels: number;
  circuitOpen?: boolean;
  lastError?: string;
  responseTimeMs?: number;
}
