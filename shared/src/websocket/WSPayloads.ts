// WebSocket Message Payloads
// Domain: Payload structures for all WebSocket event types

import type { ProviderName, ModelDef } from "../providers/ModelDefs";
import type { AgentRole, AgentStatus, WorkerDomain } from "../types/AgentTypes";

// Re-export these types to avoid circular dependency
export type ChangeSummary = {
  path: string;
  linesAdded: number;
  linesDeleted: number;
  operation: "create" | "edit" | "delete";
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

export interface ThinkingPayload {
  agentId: string;
  thinking: string;
}
export type StreamThinkingPayload = ThinkingPayload;

export interface StreamDeltaPayload {
  agentId: string;
  content: string;
  model: string;
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
  toolCall: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}
export type StreamToolCallPayload = ToolCallPayload;

export interface StreamToolResultPayload {
  agentId: string;
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
  operation: "create" | "edit";
}

export interface StreamFileCompletePayload {
  agentId: string;
  path: string;
  totalLines: number;
  operation: "create" | "edit";
}

export interface ErrorPayload {
  sessionId: string;
  agentId?: string;
  error: string;
  code?: string;
  details?: string;
}

export interface NotificationPayload {
  type: "info" | "warning" | "success" | "error";
  title: string;
  message: string;
  duration?: number;
}

// Kory-specific payloads
export interface KoryThoughtPayload {
  thought: string;
  phase: "analyzing" | "routing" | "delegating" | "verifying" | "synthesizing";
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
    status: "pending" | "active" | "done" | "failed";
  }>;
}

export interface KoryAskUserPayload {
  question: string;
  options: string[];
  allowOther: boolean;
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
  authenticated: boolean;
  authSource?: "API Key" | "Subscription" | "CLI session" | "Antigravity";
  models: string[];
  allAvailableModels: ModelDef[];
  selectedModels: string[];
  hideModelSelector: boolean;
  authMode: string | {
    id: string;
    label: string;
    description: string;
  };
  supportsApiKey: boolean;
  supportsAuthToken: boolean;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  extraAuthModes?: Array<{ id: string; label: string; description: string }>;
  error?: string;
  circuitOpen?: boolean;
}

export interface ProviderStatusPayload {
  providers: ProviderInfo[];
}
