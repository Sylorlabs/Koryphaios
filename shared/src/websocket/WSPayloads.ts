// WebSocket Message Payloads
// Domain: Payload structures for all WebSocket event types

import type { ProviderName, ModelDef } from '../providers/ModelDefs';
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
};

export type StreamUsage = {
  agentId: string;
  model: string;
  provider: ProviderName;
  tokensIn: number;
  tokensOut: number;
  tokensUsed: number;
  usageKnown: boolean;
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

export interface ThinkingPayload {
  agentId: string;
  thinking: string;
  /** Estimated reasoning tokens so far — used when the provider redacts the
   *  thinking text (Claude Code headless) but reports progress. */
  thinkingTokens?: number;
}
export type StreamThinkingPayload = ThinkingPayload;

export interface StreamDeltaPayload {
  agentId: string;
  content: string;
  model: string;
}

export interface StreamClearContentPayload {
  agentId: string;
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
  toolCall: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}
export type StreamToolCallPayload = ToolCallPayload;

export interface StreamToolResultPayload {
  agentId: string;
  sourceProvider?: string;
  toolResult: {
    callId: string;
    name: string;
    output: string;
    isError: boolean;
    durationMs: number;
  };
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

export interface CompactionProgressPayload {
  compactionId: string;
  sessionId: string;
  phase: 'preparing' | 'summarizing' | 'validating' | 'committing' | 'complete' | 'failed';
  progress: number;
  provider: string;
  model: string;
  automatic: boolean;
  message: string;
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
  authSource?: 'API Key' | 'Subscription' | 'CLI session';
  models: string[];
  allAvailableModels: ModelDef[];
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
  /** Human-friendly name (e.g. "Google Jules") */
  label?: string;
  /** Static icon path served by the frontend (e.g. /provider-icons/jules.svg) */
  iconPath?: string;
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
  /** Koryphaios provider id (claude, codex, devin, grok, cursor, cline, antigravity, kimicode). */
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
