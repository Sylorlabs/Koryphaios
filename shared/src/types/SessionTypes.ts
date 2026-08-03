// Session Types
// Domain: Session management and state tracking

import type { AgentRole, AgentStatus, WorkerDomain } from './AgentTypes';
import type { ProviderName } from '../providers/ProviderNames';

export interface Session {
  id: string;
  userId?: string;
  title: string;
  parentSessionId?: string;
  /** Absolute path of the project folder this chat belongs to. Sessions without
   *  one are "global" (created before project scoping, or with no folder open). */
  workingDirectory?: string;
  /** Conversation workflow. Plan is deliberately separate from the workspace
   * permission preset so one planning chat cannot change every other chat. */
  interactionMode?: 'act' | 'plan';
  messageCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  version?: number; // For optimistic locking
  /** Monotonic counter bumped every time the conversation is rewritten
   *  (message edit, time-travel rewind, compaction). Stateful CLI adapters
   *  compare this to decide whether their cached conversation is stale. */
  conversationRevision?: number;
  /** Runtime state machine: idle | processing | compacting | waiting | error | paused.
   *  The single source of truth for what a session is doing right now. */
  runtimeState?: SessionRuntimeState;
  createdAt: number;
  updatedAt: number;
}

/** Runtime state machine for a session. Stored in the sessions table
 *  workflow_state column and emitted to the frontend via WS events. */
export type SessionRuntimeState =
  | 'idle'
  | 'processing'
  | 'compacting'
  | 'waiting'
  | 'error'
  | 'paused';

export type SessionStatus = 'active' | 'archived' | 'deleted';

/** Per-session runtime state machine states. */
export type SessionRuntimeState =
  | 'idle'
  | 'processing'
  | 'compacting'
  | 'waiting'
  | 'error'
  | 'paused';

export interface JulesSessionLink {
  sessionId: string;
  url?: string;
  updatedAt: number;
}

export interface SessionMetadata {
  agentCount?: number;
  messageCount?: number;
  totalTokens?: number;
  totalCost?: number;
  providerUsage?: Record<string, number>;
  lastActivityAt?: number;
  /** Active Google Jules cloud session for continuity across turns */
  jules?: JulesSessionLink;
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
