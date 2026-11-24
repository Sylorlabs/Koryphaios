// Session Types
// Domain: Session management and state tracking

import type { AgentRole, AgentStatus, WorkerDomain } from './AgentTypes';
import type { ProviderName } from '../providers/ProviderNames';
import type { AgentFallbackStep } from '../agent-controls';
import type { CreatedGitWorkspace } from '../git-workspace';

/**
 * Per-chat overrides for the composer controls that must not leak between
 * conversations. Anything omitted here falls back to the project-wide agent
 * settings in `koryphaios.json`, so a chat that never touched a control keeps
 * the project default while a chat that did keeps its own choice.
 */
export interface SessionManagerControl {
  model: string;
  provider?: ProviderName;
  reasoningLevel?: string;
  fallbacks: AgentFallbackStep[];
}

export interface SessionAgentOverrides {
  criticMode?: import('../critic-mode').CriticMode;
  /** Approval preset (yolo / guarded / accept-edits / ask / custom). */
  permissionMode?: 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom';
  /** Delegation mode (Kory decides / solo / multi-agent). */
  agentExecutionMode?: 'auto' | 'single' | 'multi';
  /** Worker isolation preset: Auto lets the manager decide per task (default),
   *  Always forces worktrees, Never writes straight into this chat's checkout. */
  worktreeMode?: 'auto' | 'always' | 'never';
  /** Legacy boolean form of worktreeMode: true → 'auto', false → 'never'. */
  worktreeIsolation?: boolean;
  /** Legacy compatibility input; criticMode takes precedence within this layer. */
  criticGateEnabled?: boolean;
  /** Durable manager controls keyed by manager agent id. The live manager is
   *  not special-cased in the record shape, so a peer manager can carry its own
   *  route without adding a second chat-wide field. */
  managerControls?: Record<string, SessionManagerControl>;
  /** Skill names the agent blocked from the prompt feeder for this chat
   *  (manage_skill_feeding). Durable so a block survives idle-runtime disposal
   *  and app restarts; dies with the chat row when it is deleted or erased. */
  blockedSkillFeeds?: string[];
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
  /** Lineage of a forked chat. Absent for an original chat. */
  forkedFromSessionId?: string;
  /** The source message the fork was taken from (the source's own id). */
  forkedFromMessageId?: string;
  /** Epoch ms when the fork was created. */
  forkedAt?: number;
  /** Epoch ms when this fork's result was merged back into its source; absent until then. */
  forkMergedAt?: number;
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
