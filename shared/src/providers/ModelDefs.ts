// Model Definitions
// Domain: LLM model specifications and capabilities

import type { ProviderName } from './ProviderNames';

// Re-export for convenience
export type { ProviderName } from './ProviderNames';

export type ModelTier = 'flagship' | 'fast' | 'cheap' | 'reasoning';

/** Live quota info for a model from the provider's quota API (e.g. Antigravity's
 *  RetrieveUserQuota gRPC). `remainingFraction` is 0–1 (0% – 100%); `resetTime`
 *  is a Unix-ms timestamp when the quota window resets. */
export interface ModelQuota {
  /** 0–1 fraction of quota remaining for the current window. */
  remainingFraction: number;
  /** Unix-ms timestamp when the quota window resets (0 if unknown). */
  resetTime: number;
  /** Quota tier label (e.g. "free", "paid") if reported by the provider. */
  tier?: string;
}

export interface ModelDef {
  id: string;
  name: string;
  provider: ProviderName;
  /** Model ID sent to the API. Defaults to `id` if omitted. Used when API expects a different name (e.g., OpenRouter "openai/gpt-4.1"). */
  apiModelId?: string;
  /** Provider-owned account/profile that reported this model. Present only
   * when a CLI exposes multiple independently authenticated accounts. */
  accountId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  costPerMInputCached?: number;
  costPerMOutputCached?: number;
  canReason?: boolean;
  /** Real effort levels this model supports (e.g. ['low','medium','high','xhigh']), when the
   *  provider reports them live. Falls back to static ReasoningConfig tables when absent. */
  reasoningLevels?: string[];
  /** True when this exact model is known to support Codex's ChatGPT Fast tier.
   * This is intentionally separate from reasoning effort and API priority. */
  supportsFastMode?: boolean;
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
  /** For alias-based CLI models: the real resolved model ID (e.g. 'claude-opus-4-8' for alias 'opus') */
  realModelId?: string;
  /** True when contextWindow came from (or was confirmed against) a live provider/CLI
   *  response rather than a hand-maintained catalog entry. Trusted for UI telemetry. */
  contextVerified?: boolean;
  /** Live quota info from the provider's quota API (e.g. Antigravity's
   *  RetrieveUserQuota). Present only when the provider exposes per-model quota. */
  quota?: ModelQuota;
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
  lastVerifiedAt?: number;
  lastVerificationScope?: 'credential' | 'account' | 'endpoint' | 'catalog' | 'runtime';
  /** Ordered list of saved account IDs for automatic fallback on failure. */
  fallbackOrder?: string[];
  /** Whether automatic fallback between selected account profiles is enabled. */
  fallbackEnabled?: boolean;
  headers?: Record<string, string>;
  /**
   * User-chosen deployment identifier. Azure and SAP catalogs expose model
   * metadata separately from runnable deployments; keeping the fields apart
   * prevents a base model id from being presented as an inference target.
   */
  deployment?: string;
  /** Bedrock: explicit AWS region (falls back to AWS_REGION / us-east-1). */
  awsRegion?: string;
  /** Bedrock: optional STS session token paired with apiKey/authToken. */
  awsSessionToken?: string;

  // ─── Custom (user-defined / bring-your-own) provider fields ───────────────
  /** True when this is a user-defined custom provider (not a built-in). */
  custom?: boolean;
  /** API wire format for a custom provider. Defaults to 'openai' (OpenAI-compatible). */
  kind?: 'openai' | 'anthropic' | 'gemini';
  /** Human-friendly display name for a custom provider. */
  label?: string;
  /** Explicitly declared model IDs for a custom provider (used when the endpoint has
   *  no /models discovery, or to seed the catalog before the live fetch completes). */
  models?: string[];
  /** Opaque reference to a normalized provider badge stored outside project config. */
  customIcon?: CustomProviderIconConfig;
}

export type CustomProviderIconShape = 'rounded-square' | 'circle';

export interface CustomProviderIconConfig {
  assetId: string;
  revision: string;
  shape: CustomProviderIconShape;
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
