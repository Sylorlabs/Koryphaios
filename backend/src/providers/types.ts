// Provider abstraction layer — modeled after OpenCode's baseProvider pattern.
// Each provider implements a uniform streaming interface regardless of underlying API.

import type {
  ModelDef,
  ModelParameterKey,
  FusionSelection,
  ModelParameterValues,
  ProviderConfig,
  ProviderName,
} from '@koryphaios/shared';

// Export model catalog and helpers from the new modular structure
export * from './models';

// ─── Prompt-cache topology ──────────────────────────────────────────────────

export type PromptCacheLaneKind =
  'manager' | 'worker' | 'critic' | 'compaction' | 'research' | 'memory' | 'default';

// ─── Provider Events (streaming protocol) ───────────────────────────────────

export type ProviderEventType =
  | 'content_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_delta'
  | 'tool_use_stop'
  | 'usage_update'
  /** The provider is still alive but temporarily queued for capacity. */
  | 'waiting'
  // Emitted by AGENTIC providers (CLI harnesses like claude-code) that execute their own
  // tools internally. Unlike tool_use_*, these are already-done actions to DISPLAY, not to
  // execute — the manager surfaces them (live file preview / tool feed) without re-running.
  | 'file_edit'
  | 'tool_executed'
  | 'complete'
  | 'error'
  | 'cli_commands';

export interface ProviderEvent {
  type: ProviderEventType;
  content?: string;
  thinking?: string;
  /** Reasoning-token estimate for redacted thinking streams (Claude Code -p). */
  thinkingTokens?: number;
  toolCallId?: string;
  toolName?: string;
  toolInput?: string;
  /** Actual USD charge returned by the provider, including an explicit zero. */
  reportedCostUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** True when tokensIn is cumulative across the turn's internal provider
   *  requests (agentic CLI harnesses such as Codex) rather than the final
   *  live context occupancy. Consumers must clamp it to the trusted window,
   *  surface it as estimated, and never trigger auto-compact on it. */
  estimated?: boolean;
  /** Input tokens processed across every provider request in one agentic turn.
   * This may differ from `tokensIn`, which is the final context occupancy used
   * by Kory's context meter. Billing prefers this field when present. */
  billingTokensIn?: number;
  /** Output tokens processed across every provider request in one agentic turn. */
  billingTokensOut?: number;
  /** Per-request usage retained for threshold-sensitive provider pricing.
   * Billing records these samples instead of the aggregate fields when set. */
  billingUsageSamples?: Array<{
    tokensIn: number;
    tokensOut: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
  }>;
  /** Limits of the provider evidence behind this usage sample. */
  usagePrecision?: 'provider-reported' | 'input-context-only';
  /** Human-readable provider wait reason, such as a CLI seat queue. */
  waitingReason?: string;
  // Cached prompt tokens NOT already counted in tokensIn (Anthropic-style
  // usage, where input_tokens excludes cache reads/writes). Consumers add
  // tokensIn + tokensCache to get real context occupancy. Providers whose
  // prompt count already includes cached tokens (OpenAI-style) must omit this.
  tokensCache?: number;
  /** Cached input included inside tokensIn (OpenAI/Codex-style usage).
   *  Informational only: never add this to context occupancy again. */
  tokensCacheRead?: number;
  /** Input tokens written into a provider prompt cache. Depending on the
   * provider these may be included in tokensIn (OpenAI/Google) or excluded
   * from it (Anthropic). Informational and billing metadata only. */
  tokensCacheWrite?: number;
  /** The harness expected this request to reuse an already-warm cache route. */
  cacheExpectedWarm?: boolean;
  /** Provider telemetry proved an expected-warm request performed a fresh
   * cache write with zero cache reads. */
  cacheUnexpectedMiss?: boolean;
  /** Cache lane that produced the provider outcome, for user-facing diagnostics. */
  cacheLaneKind?: PromptCacheLaneKind;
  /** Account selected by Koryphaios for this provider-emitted usage event. */
  accountId?: string;
  finishReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
  error?: string;
  /** The provider aborted this attempt for a reason it knows is worth retrying:
   *  a typed upstream `api_error`, a stream that died mid-flight, an empty
   *  response body, or an expired poll deadline. The registry retries the same
   *  model on this signal instead of inferring retryability from `error` text,
   *  so redacted/bounded display strings can never suppress a retry. Never set
   *  it for configuration, credential, or request-rejection failures — those
   *  must stay fail-closed. */
  errorTransient?: boolean;
  // file_edit (agentic providers): a file the agent just created/edited.
  filePath?: string;
  fileContent?: string;
  fileOldContent?: string;
  fileOperation?: 'create' | 'edit';
  // tool_executed (agentic providers): a non-file tool the agent already ran.
  toolOutput?: string;
  isError?: boolean;
  /** Commands discovered from a native CLI session initialization event. */
  cliCommands?: CliCommand[];
}

export interface CliCommand {
  name: string;
  description?: string;
  category?: 'builtin' | 'skill' | 'plugin' | 'custom';
}

// ─── Tool definition for provider calls ─────────────────────────────────────

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── Message format for provider calls ──────────────────────────────────────

/** Minimal tool call shape for assistant messages so APIs accept following "tool" messages. */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ProviderContentBlock[];
  /** Assistant reasoning returned by the provider, verbatim. Never synthesize missing reasoning. */
  reasoningContent?: string;
  /** Required for role "tool": ID of the tool call this result belongs to. */
  tool_call_id?: string;
  /** Required when following messages have role "tool": assistant must include tool_calls. */
  tool_calls?: ProviderToolCall[];
}

export interface ProviderContentBlock {
  type: 'text' | 'image' | 'audio' | 'video' | 'tool_use' | 'tool_result';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  imageData?: string;
  imageMimeType?: string;
  mediaData?: string;
  mediaMimeType?: string;
}

// ─── Stream request ─────────────────────────────────────────────────────────

export interface StreamRequest {
  /** Host-owned route pin. Remote inference cannot fall through to an adapter
   * with different credentials or native tool authority when availability changes. */
  requiredProvider?: string;
  model: string;
  messages: ProviderMessage[];
  systemPrompt: string;
  tools?: ProviderToolDef[];
  /** Turn-level subset of the declared tool universe that may be called.
   * Keeping this separate lets provider tool declarations stay byte-stable
   * for prompt caching while host policy can still change per turn. */
  allowedToolNames?: string[];
  maxTokens?: number;
  temperature?: number;
  /** For reasoning models — never restrict this. Can be "low"|"medium"|"high" or provider-specific like "8192" */
  reasoningLevel?: string;
  /** Request accelerated processing when the selected route actually supports it.
   * Providers must translate this into their own documented service-tier control.
   * Kept for backward compatibility — the API boundary normalizes it to `speedTier`. */
  fastMode?: boolean;
  /** The vendor-confirmed faster serving tier chosen in the composer — an id from
   * the model's `speedTiers` ('fast', 'priority', 'highspeed', 'ultraspeed', …).
   * Providers translate it into their own service-tier field or variant slug. */
  speedTier?: string;
  /** User-tunable request parameter overrides chosen in the composer's Model
   * settings panel — already sanitized against the model's `parameters`
   * before an adapter reads them. Unset keys mean the provider's own
   * default applies. */
  modelParameters?: ModelParameterValues;
  /** Devin Fusion slot selection (lead + sidekick) — only for the `fusion`
   * model; the provider validates it against the catalog's pairing matrix. */
  fusion?: FusionSelection;
  /** Explicit image capability correction, bound to the authorized route so
   * provider fallback never inherits another model's override. */
  imageInputOverride?: { provider: string; model: string };
  /** Signal to abort the stream */
  signal?: AbortSignal;
  /** Project working directory — agentic CLI providers (claude-code) run + edit files here. */
  workingDirectory?: string;
  /** Koryphaios session id — used for provider conversation continuity and tool grants. */
  sessionId?: string;
  /** Persisted generation of any provider-owned native transcript for this session. */
  providerConversationRevision?: number;
  /** Nonlinear history (regenerate/rewind) must not resume or adopt a stale native transcript. */
  forceFreshConversation?: boolean;
  /** Host-imposed sandbox for a REMOTE agentic turn: the CLI runs on the host,
   *  so the host confines it (OS jail + tool gating). Absent for local turns
   *  (full access). See SandboxPolicy. */
  sandbox?: import('@koryphaios/shared').SandboxPolicy;
  /** Qualification-only provider control: refuse all native tools and run the
   * request in the provider's private inference workspace. */
  nativeToolsDisabled?: boolean;
  /** Harness-owned role. Native providers translate this into real CLI tool policy. */
  harnessRole?: 'manager' | 'worker' | 'critic';
  /** Planning is an interaction mode, independent of the approval preset. */
  interactionMode?: 'act' | 'plan';
  /** Host-owned permission preset. Native CLI harnesses must not silently
   *  execute outside this policy. Non-YOLO turns run native tools read-only
   *  and route mutations through Kory's approval-gated tool bridge. */
  permissionMode?: 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom';
  /** Versioned prompt/task provenance; providers transport but never invent these values. */
  promptManifestHash?: string;
  taskContractHash?: string;
  /** Harness-authored cache topology. Providers validate the prefix hash
   * before using it and silently fall back to implicit caching if stale. */
  promptCache?: PromptCachePlan;
  /** Unattended cache refresh policy selected by the workspace. */
  promptCacheKeepaliveMode?: 'economic' | 'always' | 'off';
  /** Optional explicit cache-lane override for nonstandard subprocesses.
   * Normal manager/worker/critic lanes are inferred from harnessRole. */
  cacheLaneKind?: PromptCacheLaneKind;
  /** Controlled diagnostics/benchmark override for testing whether reasoning
   * variants truly share one provider-native cache domain. Normal product
   * requests leave this unset and use the provider capability registry. */
  cacheReasoningScopeOverride?: 'shared' | 'isolated';
  /** Narrow provider-native research subprocess. It receives no Kory MCP,
   * workspace, or general agent authority and may only return cited text. */
  capabilityProfile?: 'research-only';
}

export interface PromptCachePlan {
  version: 1;
  /** Exact immutable prefix of systemPrompt, never a second source of truth. */
  stableSystemPrompt: string;
  stablePrefixHash: string;
  /** Opaque workspace namespace. Tabs in one project share it; unrelated
   * workspaces cannot collide even when their stable prompt text is identical. */
  workspaceScopeHash?: string;
  /** Hashes of named stable prompt sections for cache-break attribution. */
  stableComponentHashes?: Record<string, string>;
  /** Opaque, non-identifying routing bucket. Provider adapters may combine it
   * with model, tool-schema, and reasoning hashes. */
  cacheKey: string;
  strategy: 'hierarchical';
  /** Anthropic default. Other providers translate to their native policy. */
  ttl: '5m';
  estimatedStableTokens: number;
}

// ─── Provider lifecycle contract ────────────────────────────────────────────

/**
 * What an adapter can actually do with a turn after it has started. Every flag
 * must be backed by code in that adapter (cite it at the flag). The manager
 * branches on these flags, never on provider names (docs/architecture/provider-lifecycle.md).
 */
export interface LifecycleCapabilities {
  version: 1;
  /** Can stop an in-flight turn and report it as interrupted. */
  interrupt: boolean;
  /** Can continue a prior provider conversation from a stored handle. */
  resume: boolean;
  /** That handle survives a Koryphaios backend restart. */
  resumeAfterRestart: boolean;
  /** Can inject input into a running turn without restarting it. */
  steerInFlight: boolean;
  /** Can drop the last N turns from the provider-side conversation. */
  rollback: boolean;
  /** Can branch a provider conversation natively. */
  fork: boolean;
  /** How reliably the provider reports turn end. */
  terminalStatusQuality: 'strong' | 'weak' | 'none';
}

/** A provider-owned conversation id, scoped to the provider that issued it. */
export interface ProviderResumeHandle {
  provider: string;
  kind: string;
  value: string;
  createdAt: number;
}

export interface ProviderLifecycle {
  capabilities(): LifecycleCapabilities;
  /** Handle for the conversation a just-finished or in-flight turn used, if any. */
  resumeHandle?(sessionId: string): ProviderResumeHandle | null;
}

/**
 * Capabilities for a provider. An adapter without `lifecycle` declares nothing,
 * so the conservative default is returned: no operation is claimed and terminal
 * status is treated as weak.
 */
export function lifecycleCapabilities(
  provider: Pick<Provider, 'lifecycle'>,
): LifecycleCapabilities {
  if (provider.lifecycle) return provider.lifecycle.capabilities();
  return {
    version: 1,
    interrupt: false,
    resume: false,
    resumeAfterRestart: false,
    steerInFlight: false,
    rollback: false,
    fork: false,
    terminalStatusQuality: 'weak',
  };
}

// ─── Provider interface ─────────────────────────────────────────────────────

export interface Provider {
  readonly name: ProviderName;
  /** Optional lifecycle contract. Absent means the conservative default (see lifecycleCapabilities). */
  readonly lifecycle?: ProviderLifecycle;
  readonly config: ProviderConfig;
  /**
   * Whether nonlinear regeneration can be served from the supplied messages
   * instead of a provider-owned transcript. Adapters that send the complete
   * message list on every request are fresh by construction. Stateful adapters
   * must clear their cached conversation when forceFreshConversation is set.
   * An explicit false fails regeneration closed rather than using stale context.
   */
  readonly supportsFreshConversation?: boolean;
  /** Adapter transport, independent of the selected model's vision capability.
   * A user can correct model metadata, but cannot add a missing transport. */
  readonly imageInputTransport?: 'native' | 'file' | 'none';
  /** Modalities this adapter can actually deliver as native model input. */
  readonly mediaInputKinds?: readonly ('audio' | 'video')[];

  /** Stream a response from the model. Yields events as they arrive. */
  streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent>;

  /** Check if this provider is configured and authenticated. */
  isAvailable(): boolean;

  /** Optional async re-check for adapters whose synchronous isAvailable()
   * serves a cached probe result. Turn admission awaits this before refusing
   * a turn so one transient failure cannot lock the provider out;
   * implementations must stay coalesced and rate-limited. */
  refreshAvailability?: () => Promise<boolean>;

  /** List models available for this provider. */
  listModels(): ModelDef[];

  /** Optional provider-level model refresh hook for cache reset/refresh control. */
  refreshModels?: (forceRefresh?: boolean) => void | Promise<unknown>;

  /** Why live model discovery is unavailable. Never substitute guessed models. */
  getModelDiscoveryError?: () => string | undefined;

  /** True while a live catalog request is in flight, so a status projection can
   *  avoid reporting "no models" for a catalog that is still loading. */
  isModelDiscoveryInFlight?: () => boolean;

  /** True after a successful provider catalog response, including an empty one. */
  isModelCatalogAuthoritative?: () => boolean;

  /** The request-parameter keys this adapter actually forwards. Absent means
   * none — the composer then hides model settings for every model here. */
  forwardedModelParameters?: () => ReadonlySet<ModelParameterKey>;

  /** Native CLI commands exposed by this provider when available. */
  getCliCommands?: () => CliCommand[];
}

// ─── Provider factory ───────────────────────────────────────────────────────

export type ProviderFactory = (config: ProviderConfig) => Provider;
