// WebSocket Message Payloads
// Domain: Payload structures for all WebSocket event types

import type { ProviderName, ModelDef, CustomProviderIconConfig } from '../providers/ModelDefs';
import type { AgentRole, AgentStatus, WorkerDomain } from '../types/AgentTypes';

// Re-export these types to avoid circular dependency
export type ChangeSummary = {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  operation: 'create' | 'edit' | 'delete';
};

/** Estimated composition of the prompt context, measured at dispatch time
 *  (chars/4 heuristic). Segment proportions for the context-usage bar; the
 *  authoritative TOTAL is still tokensUsed from the provider. */
export type ContextBreakdown = {
  /** Base system prompt + behavior rules. */
  system: number;
  /** Injected memory/notes network context. */
  memory: number;
  /** Tool definitions + all tool calls and results in the history. */
  tools: number;
  /** Conversation only: what the user typed + what the agent typed back. */
  chat: number;
  /** Injected skill guidance chars/4. Skill promptText ships inside the
   *  compiled system prompt; the backend carves it out at dispatch so the
   *  bar shows Skills instead of inflating System. */
  skills: number;
  /** Generated output tokens from the provider usage report, patched in
   *  post-dispatch when usageKnown. 0 at dispatch (unknown yet). */
  output: number;
  /** Native CLI-owned prompt/history not exposed as individual categories. */
  cliHarness?: number;
  /** Request context when an older provider snapshot has no composition data. */
  request?: number;
};

export type StreamUsage = {
  agentId: string;
  model: string;
  provider: ProviderName;
  tokensIn: number;
  tokensOut: number;
  tokensUsed: number;
  usageKnown: boolean;
  /** True when tokensIn/tokensUsed is an estimate rather than an exact
   *  provider-reported occupancy — e.g. an agentic CLI harness whose
   *  turn-level total is cumulative across its internal requests (Codex), or
   *  a value clamped down to the trusted window because the raw total was
   *  impossibly large. Estimated occupancy must never trigger auto-compact. */
  estimated?: boolean;
  /** Provider-reported cached input already included in tokensIn. This
   *  explains billing/prompt reuse without double-counting context. */
  cachedInputTokens?: number;
  /** Provider-reported input tokens written into prompt cache this turn. */
  cacheWriteInputTokens?: number;
  /** Estimated turn cost using the resolved provider/model pricing table. */
  estimatedCostUsd?: number;
  /** Estimated delta versus pricing the same input entirely as fresh input.
   * Positive means prompt caching reduced cost; negative means cache-write
   * premiums outweighed cache-read savings for this turn. */
  cacheSavingsUsd?: number;
  contextWindow?: number;
  contextKnown: boolean;
  /** Where the context limit came from. Live provider/CLI data is preferred;
   * catalog is an explicit fallback when that surface exposes no limit. */
  contextSource?: 'live' | 'catalog' | 'alias';
  breakdown?: ContextBreakdown;
};

export interface AgentSpawnedPayload {
  agent: {
    id: string;
    name: string;
    role: AgentRole;
    model: string;
    provider: ProviderName;
    domain: WorkerDomain;
    glowColor: string;
  };
  task: string;
  parentAgentId?: string;
}

export interface AgentStatusPayload {
  agentId: string;
  status: AgentStatus;
  detail?: string;
  /** True when a turn-cap exit still has pending work and a followup is queued. */
  continuationNeeded?: boolean;
}

/** Explicit worker-control changes, independent of usage telemetry. */
export interface AgentUpdatedPayload {
  agentId: string;
  model?: string;
  provider?: ProviderName;
  reasoningLevel?: string;
  contextPruned?: number;
}

/** agent.heartbeat — periodic "the run is still alive" signal emitted by the
 *  backend while a turn is active. Lets the client watchdog distinguish
 *  "alive but quiet" (e.g. a long tool call) from "dead — terminal event
 *  was dropped". */
export interface AgentHeartbeatPayload {
  agentId: string;
  sessionId: string;
  /** Coarse phase the backend believes it's in, mirroring AgentStatus. */
  phase: AgentStatus;
}

export interface AgentThreadMessagePayload {
  agentId: string;
  entry: {
    id: string;
    role: 'manager' | 'user' | 'assistant';
    content: string;
    createdAt: number;
  };
}

export interface AgentSteeringQueuePayload {
  agentId: string;
  commands: import('../types/AgentSteeringTypes').AgentSteeringCommand[];
}

/** Payload for the `agent.message` event (inter-agent mailbox updates). */
export interface AgentMessageEventPayload {
  message: import('../types/MessagingTypes').AgentMessage;
}

export interface ThinkingPayload {
  agentId: string;
  thinking: string;
  /** Estimated reasoning tokens so far — used when the provider redacts the
   *  thinking text (Claude Code headless) but reports progress. */
  thinkingTokens?: number;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
}
export type StreamThinkingPayload = ThinkingPayload;

export interface StreamDeltaPayload {
  agentId: string;
  content: string;
  model: string;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
}

export interface StreamClearContentPayload {
  agentId: string;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
}

export interface ContextDetectedPayload {
  files: Array<{
    path: string;
    relevance: number;
    reason: string;
  }>;
}

export interface MessagePendingPayload {
  messageId: string;
  agentId: string;
  model: string;
  provider: ProviderName;
}

export interface MessageDeltaPayload {
  messageId: string;
  agentId: string;
  delta: string;
  accumulatedContent?: string;
}

export interface MessageCompletePayload {
  messageId: string;
  agentId: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
}

export interface ToolCallPayload {
  agentId: string;
  sourceProvider?: string;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
  toolCall: {
    /** App-owned id (Invariant 2). Results carry the same id in `callId`. */
    id: string;
    /** The provider-native id, kept as evidence only. Never used to match calls and results. */
    nativeRef?: string;
    name: string;
    input: Record<string, unknown>;
  };
}
export type StreamToolCallPayload = ToolCallPayload;

export interface StreamToolResultPayload {
  agentId: string;
  sourceProvider?: string;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
  toolResult: {
    /** App-owned id of the call this result belongs to. */
    callId: string;
    /** The provider-native id of the call, kept as evidence only. */
    nativeRef?: string;
    name: string;
    output: string;
    isError: boolean;
    durationMs: number;
    computerUse?: import('../computer-use').ComputerUseReceipt;
    /** Critic-specific outcome so a runner error is not confused with a
     * completed review that rejected the work. */
    criticOutcome?:
      'run_failed' | 'run_failed_after_output' | 'verdict_failed' | 'passed' | 'skipped';
  };
}

/** stream.complete: terminal event for a manager or worker turn. */
export interface StreamCompletePayload {
  agentId: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Id of the assistant message this event belongs to. Allocated when the manager turn starts;
   *  the frontend replaces a live turn with persisted history by this id, never by text.
   *  See docs/architecture/transcript-integrity.md. */
  messageId?: string;
}

/** turn.provider_completed: the manager's final provider call for a turn ended (success, error or stop).
 *  Emitted once per manager turn, before critic, checkpoint and persistence work start. The
 *  spinner follows this event; later follow-up work is not provider work. */
export interface TurnProviderCompletedPayload {
  agentId: string;
  /** The assistant message id allocated when the turn began (transcript-integrity Invariant 2). */
  messageId: string;
  runId?: string;
  completedAt: number;
}

export type RunSettledOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** run.settled: the run is terminal and every follow-up step for it has finished. Emitted once per run,
 *  immediately after its terminal run.state transition. The `messageId` is optional because the run
 *  coordinator does not know the turn id; `turn.provider_completed` carries the same `runId` and `messageId`. */
export interface RunSettledPayload {
  runId: string;
  messageId?: string;
  outcome: RunSettledOutcome;
  settledAt: number;
}

/**
 * A chat paused on a provider usage limit and will retry on its own. `null`
 * means no pending resume remains for the session (resumed, cancelled, or
 * exhausted). The UI renders "Paused until <resumeAt> · Resume now · Cancel".
 */
export interface PendingResumePayload {
  pendingResume: {
    id: string;
    reason: 'usage_limit';
    provider: string | null;
    model: string | null;
    /** Epoch ms of the next automatic attempt. */
    resumeAt: number;
    /** Automatic attempts already made (0 before the first retry). */
    attempt: number;
    maxAttempts: number;
    state: 'scheduled' | 'resuming';
    /** Why the chat paused, bounded and safe to show. */
    message: string;
  } | null;
  /** Set when pendingResume is null. */
  clearedReason?: 'resumed' | 'cancelled' | 'exhausted';
}

export interface SessionCreatedPayload {
  sessionId: string;
  title: string;
  createdAt: number;
}

export interface SessionUpdatedPayload {
  sessionId: string;
  title?: string;
  status?: string;
  updatedAt: number;
}

export interface SessionIdlePayload {
  sessionId: string;
  state: string;
  messageId?: string;
  updatedAt: number;
}

/** Durable sequence-one control row emitted after an intentional conversation
 * rewrite. Its epoch must match the WS message epoch. */
export interface SessionTimelineRewrittenPayload {
  eventEpoch: number;
  reason: 'conversation_rewind';
}

export interface CompactionProgressPayload {
  compactionId: string;
  sessionId: string;
  phase: 'preparing' | 'summarizing' | 'validating' | 'committing' | 'complete' | 'failed';
  progress: number;
  provider: string;
  model: string;
  automatic: boolean;
  message: string;
  /** Accumulated or final compaction checkpoint text, when available. */
  summary?: string;
  /** Raw model output for the compaction checkpoint, when available. */
  raw?: string;
  text?: string;
  sourceMessages?: number;
  sourceTokens?: number;
  checkpointTokens?: number;
  error?: string;
}

export interface ChangeSummaryPayload {
  sessionId: string;
  changes: ChangeSummary[];
}

export interface KorySessionChangesPayload {
  changes: ChangeSummary[];
  /** Stable durable review identity. Absent only for legacy operational rows. */
  reviewId?: string;
  /** Exact publication displayed by the controller, including identical refreshes. */
  reviewRevision?: string;
}

/** Terminal control for a prior session.changes projection. The matching
 * review is no longer actionable, so reconnecting clients must remove it. */
export interface KorySessionChangesResolvedPayload {
  reviewId?: string;
  reviewRevision?: string;
  status: 'accepted' | 'rejected' | 'terminalized' | 'not_pending';
  /** Structural reason only; never includes file or prompt contents. */
  reason?: string;
}

/** Terminal control for a prior kory.ask_user projection. */
export interface KoryAskUserResolvedPayload {
  questionId?: string;
  status: 'answered' | 'cancelled' | 'superseded' | 'not_pending';
}

/** Compact durable index used after a fresh renderer boot. The client can
 * subscribe only to waiting sessions rather than replaying every chat. */
export interface SessionActionableWaitsPayload {
  questionSessionIds: string[];
  reviewSessionIds: string[];
}

export interface StreamUsagePayload extends StreamUsage {}

export interface StreamFileDeltaPayload {
  agentId: string;
  path: string;
  delta: string;
  totalLength: number;
  operation: 'create' | 'edit';
  /** For edits: the original text being replaced, sent once on the first delta (enables a live diff). */
  oldStr?: string;
}

export interface StreamFileCompletePayload {
  agentId: string;
  path: string;
  totalLines: number;
  operation: 'create' | 'edit';
}

export interface ErrorPayload {
  sessionId: string;
  agentId?: string;
  error: string;
  code?: string;
  details?: string;
}

export interface NotificationPayload {
  type: 'info' | 'warning' | 'success' | 'error';
  title?: string;
  message: string;
  duration?: number;
  metadata?: {
    branch?: string;
    commitHash?: string;
    prUrl?: string;
    [key: string]: unknown;
  };
}

// Kory-specific payloads
export interface KoryThoughtPayload {
  thought: string;
  phase: 'analyzing' | 'routing' | 'delegating' | 'verifying' | 'synthesizing';
}

export interface KoryRoutingPayload {
  domain: string;
  selectedModel: string;
  selectedProvider: ProviderName;
  reasoning: string;
}

export interface KorySkillUse {
  name: string;
  representation: 'full' | 'compact' | 'minimal';
  reason?: string;
  source?: string;
}

/** The skills a turn actually injected into its compiled prompt. */
export interface KorySkillPayload {
  agentId?: string;
  skills: KorySkillUse[];
}

export interface KoryTaskBreakdownPayload {
  tasks: Array<{
    id: string;
    description: string;
    domain: string;
    assignedModel: string;
    status: 'pending' | 'active' | 'done' | 'failed';
  }>;
}

export interface KoryAskUserPayload {
  questionId?: string;
  question: string;
  options: string[];
  allowOther: boolean;
  allowKeepChatting?: boolean;
}

export interface KoryVerificationPayload {
  sessionId: string;
  verified: boolean;
  issues?: string[];
  warnings?: string[];
}

// Provider status payload
export interface ProviderInfo {
  name: ProviderName;
  enabled: boolean;
  /**
   * Compatibility field retained for older clients. True only after a
   * process-local verification probe succeeds; detection alone is never
   * serialized as authenticated.
   */
  authenticated: boolean;
  /** Whether the configured adapter can attempt work in this process. */
  adapterAvailable?: boolean;
  /** Whether credential material, a CLI login file, or a local endpoint was detected. */
  credentialDetected?: boolean;
  /** Authoritative distinction between local detection and a completed provider probe. */
  connectionState?:
    'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
  /** Timestamp for a successful verification performed by this backend process. */
  verifiedAt?: number;
  /** Scope of what the latest probe established; catalog scope may remain detected. */
  verificationScope?: 'credential' | 'account' | 'endpoint' | 'catalog' | 'runtime';
  /** Last probe failure. Never contains raw credential material. */
  verificationError?: string;
  /** Where auto-detected connection material came from (e.g. `OPENAI_API_KEY`,
   *  `AWS credentials`, `Local server · http://localhost:11434`). */
  autoDetectedSource?: string;
  /** Effective provider base URL used for inference and discovery. */
  endpointUrl?: string;
  /** Exact model-catalog URL used for provider discovery, when applicable. */
  modelCatalogUrl?: string;
  /** HTTP status from the last model-catalog failure, when available. */
  modelDiscoveryHttpStatus?: number;
  authSource?: 'API Key' | 'Subscription' | 'CLI session';
  models: string[];
  allAvailableModels: ModelDef[];
  /** A successful empty catalog is meaningful and must clear removed models. */
  modelCatalogAuthoritative?: boolean;
  selectedModels: string[];
  hideModelSelector: boolean;
  authMode:
    | string
    | {
        id: string;
        label: string;
        description: string;
      };
  supportsApiKey: boolean;
  supportsAuthToken: boolean;
  requiresBaseUrl: boolean;
  /** Inference requires an explicit provider deployment identifier. */
  requiresDeployment?: boolean;
  /** Explicit configured deployment name; not a discovered base model id. */
  deploymentName?: string;
  /** True when this build deliberately refuses configuration/execution for the adapter. */
  configurationBlocked?: boolean;
  baseUrlPlaceholder?: string;
  extraAuthModes?: Array<{ id: string; label: string; description: string }>;
  error?: string;
  circuitOpen?: boolean;
  /** Human-friendly name (e.g. "Claude Code") */
  label?: string;
  /** Static icon path served by the frontend (e.g. /provider-icons/lobehub/claude.svg) */
  iconPath?: string;
  /** Authenticated custom-provider icon asset and presentation metadata. */
  customIcon?: CustomProviderIconConfig;
  /** Supported agent execution locations, including explicit unavailable modes. */
  execution?: import('../provider-execution').ProviderExecutionCapabilities;
  /** Where the provider executes work */
  deployment?: 'cloud' | 'api' | 'local' | 'hybrid';
  /** Short UI description of provider behavior */
  description?: string;
  /** Official page where this provider issues the expected credential. */
  credentialUrl?: string;
  /** True for a REMOTE provider served by another machine (id `remote-*`). */
  remote?: boolean;
  /** Remote CLI harness: using it copies the client's project to the host and
   *  runs the CLI there. The composer confirms this before the first send. */
  remoteAgentic?: boolean;
  /** Display name of the host serving this remote provider. */
  remoteHostName?: string;
}

export interface ProviderStatusPayload {
  providers: ProviderInfo[];
}

// Rate limit notification payload
export interface RateLimitPayload {
  provider: ProviderName;
  model: string;
  retryAfterMs: number;
  attempt: number;
  maxRetries: number;
}

/**
 * Native CLI slash command output, attributed to the CLI provider harness
 * the user is driving as the manager (e.g. Claude Code, Devin, Grok Build).
 * Emitted by the backend when a user invokes a provider's own `/command` from
 * the Koryphaios composer; the frontend renders it as a feed entry labeled
 * with the provider's display name so the user can see the harness's reply.
 */
export interface NativeCommandPayload {
  /** Koryphaios provider id (claude, codex, devin, grok, cursor, antigravity, kimicode). */
  provider: string;
  /** Display name of the provider harness (e.g. "Claude Code"). */
  providerLabel: string;
  /** Slash command name without the leading slash (e.g. "models", "status"). */
  command: string;
  /** Raw command line the user typed, including args (e.g. "/diff --stat"). */
  rawCommand: string;
  /** Output text for this chunk. Multiple chunks stream into one feed entry. */
  text: string;
  /** True for intermediate streaming chunks; absent/false on the final chunk. */
  isPartial?: boolean;
  /** True when the command could not run (e.g. binary missing, non-headless). */
  isError?: boolean;
  /** Stable id so the frontend can accumulate streaming chunks into one entry. */
  messageId: string;
}

/** `session.forked`: published on the source chat (sessionId = source) when a
 *  fork is created. `session` is the new fork; `copiedMessageCount` its history. */
export interface SessionForkedPayload {
  sourceSessionId: string;
  forkMessageId: string;
  copiedMessageCount: number;
  session: import('../types/SessionTypes').Session;
}

/** `session.merged`: published on the source chat (sessionId = source) after a
 *  fork's result was appended to its transcript. `messageId` is that entry. */
export interface SessionMergedPayload {
  sourceSessionId: string;
  forkSessionId: string;
  mode: 'summary' | 'messages';
  messageId: string;
}

/** `session.history_pruned`: ordered events through `throughSequence` of
 *  `epoch` were deleted by retention and can never be replayed. */
export interface SessionHistoryPrunedPayload {
  epoch: number;
  throughSequence: number;
}
