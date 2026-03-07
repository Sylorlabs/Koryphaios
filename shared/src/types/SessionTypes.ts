// Session Types
// Domain: Session management and state tracking

import type { AgentRole, AgentStatus, WorkerDomain } from "./AgentTypes";
import type { ProviderName } from "../providers/ProviderNames";

export interface Session {
  id: string;
  userId?: string;
  title: string;
  parentSessionId?: string;
  messageCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionStatus = "active" | "archived" | "deleted";

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
  status: "pending" | "in_progress" | "completed" | "failed";
  assignedTo?: string;
  startTime?: number;
  endTime?: number;
}

// Import StoredMessage to avoid circular dependency
import type { StoredMessage } from "./MessageTypes";
