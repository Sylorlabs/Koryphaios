// Session Types
// Domain: Session management and state tracking

import type { AgentRole, AgentStatus, WorkerDomain } from './AgentTypes';
import type { ProviderName } from '../providers/ProviderNames';
import type { CreatedGitWorkspace } from '../git-workspace';

/**
 * Per-chat overrides for the composer controls that must not leak between
 * conversations. Anything omitted here falls back to the project-wide agent
 * settings in `koryphaios.json`, so a chat that never touched a control keeps
 * the project default while a chat that did keeps its own choice.
 */
export interface SessionAgentOverrides {
  criticMode?: import('../critic-mode').CriticMode;
  /** Approval preset (yolo / guarded / accept-edits / ask / custom). */
  permissionMode?: 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom';
  /** Delegation mode (Kory decides / solo / multi-agent). */
  agentExecutionMode?: 'auto' | 'single' | 'multi';
  /** Legacy compatibility input; criticMode takes precedence within this layer. */
  criticGateEnabled?: boolean;
}

export interface Session {
  id: string;
  userId?: string;
  title: string;
  /** Nullable durable archive marker. Archived chats retain their complete
   * history and can be restored; permanent deletion is a separate operation. */
  archivedAt?: number;
  /** Convenience projection derived from archivedAt. */
  status?: 'active' | 'archived';
  parentSessionId?: string;
  /** Absolute path of the project folder this chat belongs to. Sessions without
   *  one are "global" (created before project scoping, or with no folder open). */
  workingDirectory?: string;
  /** Immutable origin of a persistent isolated revision chat workspace, when selected. */
  gitWorkspace?: CreatedGitWorkspace;
  /** Persisted per-conversation interaction mode. Plan mode is read-only apart
   * from its dedicated planning note and explicit durable-preference writes. */
  interactionMode?: 'act' | 'plan';
  /** Stable note owned by this planning conversation. */
  planNoteId?: string;
  /** Per-chat approval preset, agent mode, and critic toggle. */
  agentOverrides?: SessionAgentOverrides;
  messageCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  version?: number; // For optimistic locking
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = 'active' | 'archived' | 'deleted';

/** Per-session runtime state machine states. */
export type SessionRuntimeState =
  'idle' | 'processing' | 'compacting' | 'waiting' | 'error' | 'paused';

export interface SessionMetadata {
  agentCount?: number;
  messageCount?: number;
  totalTokens?: number;
  totalCost?: number;
  providerUsage?: Record<string, number>;
  lastActivityAt?: number;
}

export interface SessionSnapshot {
  sessionId: string;
  snapshotId: string;
  timestamp: number;
  state: SessionState;
  commitHash?: string;
  parentSnapshotId?: string;
}

export interface SessionState {
  messages: StoredMessage[];
  activeAgents: AgentInfo[];
  taskQueue: TaskInfo[];
  metadata?: SessionMetadata;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  provider: ProviderName;
  domain: WorkerDomain;
  status: AgentStatus;
  startTime?: number;
}

export interface TaskInfo {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  assignedTo?: string;
  startTime?: number;
  endTime?: number;
}

// Import StoredMessage to avoid circular dependency
import type { StoredMessage } from './MessageTypes';
