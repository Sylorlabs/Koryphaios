// Model Definitions
// Domain: LLM model specifications and capabilities

import type { ProviderName } from './ProviderNames';
import type { ModelParameterDef } from './model-parameters';

// Re-export for convenience
export type { ProviderName } from './ProviderNames';

export type ModelTier = 'flagship' | 'fast' | 'cheap' | 'reasoning';

/** A vendor-confirmed faster serving tier of the same model (OpenAI Priority,
 *  Devin/Codex/Hoplite Fast, MiniMax Highspeed, MiMo UltraSpeed). Each entry
 *  describes a real serving-mode choice, not a different model. */
export interface ModelSpeedTier {
  /** Stable id used in `speedVariants`/`speedAliases` and `StreamRequest.speedTier`. */
  id: string;
  /** Short display label shown on the composer control. */
  label: string;
  /** What the tier does and how it is billed, shown in the tier menu. */
  description: string;
}

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
  /** Effort level → the provider's own model id, for providers that expose
   *  reasoning effort as separate models instead of a request parameter
   *  (Antigravity: `-low` / `-medium` / `-high` slugs). Koryphaios collapses
   *  such families into one base model and resolves the composer's effort
   *  through this map, so effort stays a Koryphaios control. Absent when the
   *  provider takes a real reasoning parameter. */
  reasoningVariants?: Record<string, string>;
  /** Superseded ids that resolve to this model. Antigravity lists them when it
   *  collapses per-effort slugs into one base model, so persisted selections
   *  and enabled-model filters written before the collapse keep working. */
  aliases?: string[];
  /** True when this exact model is known to support Codex's ChatGPT Fast tier.
   * This is intentionally separate from reasoning effort and API priority. */
  supportsFastMode?: boolean;
  /** Vendor-confirmed faster serving tiers of this exact model, in the order
   *  the composer cycles through them. Standard speed is never listed — the
   *  speed control is hidden entirely when this is absent or empty. */
  speedTiers?: ModelSpeedTier[];
  /** Speed tier id → (`reasoningLevel` effort or `'default'`) → the provider's
   *  own model id, for providers that encode the serving tier in the model
   *  slug (Devin `-fast` / `-priority`, MiniMax `-highspeed`, MiMo
   *  `-ultraspeed`). Resolved at request time; a missing effort key falls
   *  back to `default`, then to the standard slug. */
  speedVariants?: Record<string, Record<string, string>>;
  /** Superseded id/slug → the speed tier id it implied. Kept alongside
   *  `aliases` so a selection persisted before a speed fold still resolves to
   *  this model — and restores that tier as on. */
  speedAliases?: Record<string, string>;
  /** Provider-reported user-tunable request parameters, already filtered to
   *  what the adapter forwards. Absent or empty means the model has no
   *  settings the composer may offer. */
  parameters?: ModelParameterDef[];
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
  /** Provider-reported Fusion pairing matrix (Devin's two-slot paired model).
   *  Present only on the single collapsed `fusion` model — the composer edits
   *  each slot (model, effort, fast) instead of picking a pairing slug. */
  fusion?: FusionCatalog;
  /** The provider's own selectable context budgets (tokens), ascending, from
   *  the CLI product catalog's `contextWindow.supportedLengths`. Present only
   *  when the vendor reports at least two tiers — a single tier is not a
   *  choice. These are real vendor values, never a generated ladder. */
  contextWindowOptions?: number[];
  /** The vendor's own default tier, when it differs from the maximum. Kept
   *  separately so Koryphaios can say what it is overriding. */
  contextWindowVendorDefault?: number;
  /** Live quota info from the provider's quota API (e.g. Antigravity's
   *  RetrieveUserQuota). Present only when the provider exposes per-model quota. */
  quota?: ModelQuota;
  /** Provider-reported Freebuff model rate shown in the model picker. */
  freebuckCost?: number;
  /** Provider-reported price label from a CLI's own product catalog. The
   *  vendor's per-request credit multiplier ("x0.03 credits") is shown as
   *  "0.03x", a zero multiplier as "free"; any other vendor text is kept
   *  verbatim. Never converted into a currency amount we cannot substantiate. */
  creditsLabel?: string;
  /** Vendor-reported numeric quota factor (e.g. 100MillionSeek's
   *  `quota_multiplier`). Kept as reported; never converted into a price. */
  quotaMultiplier?: number;
  /** Output modalities the provider reports for this model, lowercased
   *  ('text', 'image', 'video', 'audio', 'embedding'). Present only when the
   *  provider publishes them; never inferred from the model name. The image and
   *  video surfaces use this to decide which models can actually produce media,
   *  so a text model can never appear in those pickers. */
  outputModalities?: string[];
}

/** One selectable model for a Fusion slot. `efforts` empty means the slot has
 *  no effort token at all (e.g. the GLM sidekick). */
export interface FusionSlotOption {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
}

/** Context/price facts for one pairing, taken from that pairing's
 *  default-effort row. */
export interface FusionPairingMeta {
  contextWindow: number;
  costPerMInputTokens?: number;
  costPerMOutputTokens?: number;
  costPerMInputCached?: number;
}

/** Devin's full Fusion offer: which leads and sidekicks exist, which pairings
 *  the vendor actually lists, and what each pairing costs. */
export interface FusionCatalog {
  leads: FusionSlotOption[];
  sidekicks: FusionSlotOption[];
  /** key = fusionPairingKey(lead, leadFast, sidekick, sidekickEffort) →
   *  leadEffort → the exact Devin slug for that cell. */
  pairings: Record<string, Record<string, string>>;
  /** Same key → the pairing's context/price facts. */
  meta: Record<string, FusionPairingMeta>;
  /** The pairing Devin lists first — the composer's initial selection. */
  defaultSelection: FusionSelection;
}

/** The composer's editable Fusion state: one lead slot + one sidekick slot. */
export interface FusionSelection {
  lead: string;
  leadEffort: string;
  leadFast: boolean;
  sidekick: string;
  sidekickEffort: string | null;
}

/** Non-secret ACP agent definition carried on an `acp:<id>` provider config. Env
 *  secret VALUES are never on this object; they live in the agent secret store. */
export interface AcpAgentProviderConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Env variable NAMES whose values are stored in the agent secret store. */
  envNames: string[];
  cwdPolicy: 'workspace' | 'private';
  permissionProfile: 'bridge-only' | 'read-only';
  source: 'manual' | 'registry' | 'autodetect';
  /** Last capability probe verdict; absent until the agent has been probed. */
  probe?: {
    ok: boolean;
    checkedAt: number;
    protocolVersion?: number;
    models: string[];
    agentName?: string;
    agentVersion?: string;
    error?: string;
  };
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
  /** Effective context budget (tokens) for CLI-backed providers that publish
   *  selectable tiers. Undefined means use the maximum tier, which is the
   *  default. Both the user (Settings selector) and Koryphaios (provider API)
   *  can set this; adapters validate it against the live model's own tiers. */
  contextWindow?: number;
  lastVerifiedAt?: number;
  lastVerificationScope?: 'credential' | 'account' | 'endpoint' | 'catalog' | 'runtime';
  /**
   * The confirmed verification state at lastVerifiedAt. Custom endpoints can
   * never reach 'verified' (only catalog/endpoint confirmation), so the state
   * must be stored explicitly — otherwise a restart upgrades them to
   * 'verified' or drops them back to unconfigured.
   */
  lastVerificationState?: 'verified' | 'detected';
  /** Present only on `acp:<id>` providers (user-registered ACP agents). */
  acpAgent?: AcpAgentProviderConfig;
  /** Runtime-only: material was auto-detected (env/AWS/local server) and verified; never persisted. */
  autoDetected?: boolean;
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
  /** API wire format for a custom provider, auto-detected from the endpoint's
   *  catalog responses when the provider is added. Defaults to 'openai'. */
  kind?: 'openai' | 'anthropic' | 'gemini';
  /** Wire-adapter id (backend wire-adapters registry) for endpoints that
   *  speak a dialect outside the three SDK families. Takes precedence over
   *  `kind` when constructing the provider. */
  adapter?: string;
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
