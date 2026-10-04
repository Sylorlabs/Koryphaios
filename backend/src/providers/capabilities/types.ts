import type { ProviderCapabilityKind } from '@koryphaios/shared';

/**
 * Modality served by a dedicated capability adapter.
 *
 * These providers have no chat-completions contract, so Koryphaios reaches them
 * through the surface that actually exists: media generation, speech, vectors,
 * or long-term memory. The kind set is a subset of the shared
 * `ProviderCapabilityKind` union so UI copy stays consistent.
 */
export type CapabilityKind = Extract<
  ProviderCapabilityKind,
  'image' | 'video' | 'audio' | 'embedding' | 'rerank' | 'memory'
>;

/** Media modalities produced by a generation call. */
export type MediaCapabilityKind = Extract<CapabilityKind, 'image' | 'video' | 'audio'>;

export interface ResolvedCapabilityConfig {
  /** Effective base URL, with any trailing slash removed. */
  baseUrl: string;
  /** Credential, whichever slot the provider was configured with. */
  apiKey: string;
  /** Extra headers the provider requires (e.g. LMNT's version pin). */
  headers: Record<string, string>;
  /** True when only a base URL is required (self-hosted endpoints). */
  endpointAuthOnly: boolean;
}

export interface CapabilityVerifyResult {
  ok: boolean;
  /** Human-readable failure, shown in provider settings. */
  error?: string;
  /** True when the failure is a credential problem rather than an entitlement one. */
  credentialProblem?: boolean;
}

export interface CapabilityModelDef {
  id: string;
  label: string;
  capability: CapabilityKind;
  /** Accepts a source image (img2img / image-to-video). */
  edits?: boolean;
  /** Accepts a source video, where the provider offers video editing. */
  videoInput?: boolean;
  /** Option values the UI may offer for this model. */
  sizes?: string[];
  durations?: string[];
  aspectRatios?: string[];
  /** Model ids discovered from the live provider rather than declared by us. */
  discovered?: boolean;
}

/** Optional source media supplied to an edit-style generation. */
export interface CapabilitySourceMedia {
  base64: string;
  mimeType: string;
}

export interface CapabilityGenerationRequest {
  /**
   * Resolved credential and endpoint for this call. Passed explicitly rather
   * than held in adapter state so concurrent generations cannot observe each
   * other's configuration.
   */
  config: ResolvedCapabilityConfig;
  /** Modality the caller is asking for; adapters assert it against the model. */
  capability: MediaCapabilityKind;
  model: string;
  prompt: string;
  /** Normalized options; each adapter maps the ones its model accepts. */
  options: Record<string, string | number | boolean | undefined>;
  signal: AbortSignal;
  sourceImage?: CapabilitySourceMedia;
  /** Poll deadline for providers whose generation is asynchronous. */
  timeoutMs: number;
}

export interface CapabilitySpeechRequest {
  config: ResolvedCapabilityConfig;
  model: string;
  text: string;
  voice: string;
  speed?: number;
  /** Container/codec hint; adapters fall back to their own default. */
  format?: string;
  signal: AbortSignal;
}

export interface CapabilityEmbedRequest {
  config: ResolvedCapabilityConfig;
  model: string;
  /** One entry per input; returned in the same order. */
  inputs: string[];
  /** Voyage-style query/document hint; ignored by adapters without the concept. */
  inputType?: 'query' | 'document';
  /** Requested output width; ignored when the model does not support it. */
  dimensions?: number;
  signal: AbortSignal;
}

export interface CapabilityRerankRequest {
  config: ResolvedCapabilityConfig;
  model: string;
  query: string;
  documents: string[];
  topK?: number;
  signal: AbortSignal;
}

export interface CapabilityRerankResult {
  index: number;
  relevanceScore: number;
}

export interface CapabilityMediaResult {
  capability: MediaCapabilityKind;
  /** Base64 payload of the produced asset. */
  dataBase64: string;
  mimeType: string;
  revisedPrompt?: string;
  /** Provider-specific identifiers, useful for debugging a failed render. */
  meta?: Record<string, unknown>;
}

/** A single long-term memory record, normalized across memory backends. */
export interface CapabilityMemoryRecord {
  id: string;
  text: string;
  score?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Long-term memory operations, normalized so Mem0 and Letta can back the same
 * recall surface. Local memory remains the default; these are opt-in external
 * stores, and an adapter failure never degrades local recall.
 */
export interface CapabilityMemoryAdapter {
  /** Verify the credential and the configured memory scope. */
  verify(config: ResolvedCapabilityConfig, signal?: AbortSignal): Promise<CapabilityVerifyResult>;
  /** Stable scope key (Mem0 user_id / Letta agent id) for this Koryphaios user. */
  listScopes(config: ResolvedCapabilityConfig, signal?: AbortSignal): Promise<string[]>;
  /** Store text, optionally scoped to an existing scope. */
  add(
    config: ResolvedCapabilityConfig,
    input: { text: string; scope?: string; metadata?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<CapabilityMemoryRecord[]>;
  /** Semantic recall over stored memories. */
  search(
    config: ResolvedCapabilityConfig,
    input: { query: string; scope?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<CapabilityMemoryRecord[]>;
  /** Forget records by id. Providers without deletion support return 0. */
  delete?(
    config: ResolvedCapabilityConfig,
    input: { ids: string[] },
    signal?: AbortSignal,
  ): Promise<number>;
}

/**
 * A dedicated non-chat provider contract.
 *
 * Every member beyond `provider`/`capabilities` is optional: an adapter
 * implements only what its upstream API actually supports, so an embedding-only
 * provider is not forced to declare a `generate` method. `listModels` returns
 * `[]` when the provider publishes no enumeration endpoint — never a guessed
 * catalog, consistent with the rest of the provider subsystem.
 */
export interface CapabilityAdapter {
  readonly provider: string;
  readonly capabilities: CapabilityKind[];
  /** Human-readable base URL, used in error messages when config is missing. */
  readonly defaultBaseUrl: string;
  /** Whether a base URL alone (no key) is sufficient configuration. */
  readonly endpointAuthOnly?: boolean;
  verify(config: ResolvedCapabilityConfig, signal?: AbortSignal): Promise<CapabilityVerifyResult>;
  listModels?(
    config: ResolvedCapabilityConfig,
    capability: CapabilityKind,
    signal?: AbortSignal,
  ): Promise<CapabilityModelDef[]>;
  generate?(request: CapabilityGenerationRequest): Promise<CapabilityMediaResult>;
  synthesize?(request: CapabilitySpeechRequest): Promise<CapabilityMediaResult>;
  embed?(request: CapabilityEmbedRequest): Promise<number[][]>;
  rerank?(request: CapabilityRerankRequest): Promise<CapabilityRerankResult[]>;
  /** Voices offered by a speech provider, discovered rather than hard-coded. */
  listVoices?(config: ResolvedCapabilityConfig, signal?: AbortSignal): Promise<string[]>;
  readonly memory?: CapabilityMemoryAdapter;
}

/** Thrown when an adapter is asked for a capability it does not implement. */
export class CapabilityUnsupportedError extends Error {
  constructor(
    public readonly provider: string,
    public readonly capability: CapabilityKind,
  ) {
    super(`${provider} does not implement the ${capability} capability.`);
    this.name = 'CapabilityUnsupportedError';
  }
}

/**
 * Media adapters only serve image and video. `MediaCapabilityKind` also admits
 * audio, so callers must narrow explicitly rather than being handed an `any`.
 */
export function requireVisualCapability(
  provider: string,
  capability: MediaCapabilityKind,
): 'image' | 'video' {
  if (capability === 'image' || capability === 'video') return capability;
  throw new CapabilityUnsupportedError(provider, capability);
}
