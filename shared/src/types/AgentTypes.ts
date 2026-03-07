// Agent Types
// Domain: Agent roles, status, and identity

import type { ProviderName } from "../providers/ProviderNames";

export type AgentRole = "manager" | "coder" | "task" | "reviewer" | "title" | "summarizer" | "critic";

export type AgentStatus = "idle" | "thinking" | "analyzing" | "tool_calling" | "streaming" | "verifying" | "compacting" | "waiting_user" | "error" | "done" | "reading" | "writing" | "criticizing";

export type WorkerDomain = "ui" | "frontend" | "backend" | "general" | "review" | "test" | "critic";

export interface AgentIdentity {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  provider: ProviderName;
  domain: WorkerDomain;
  /** CSS glow color for the UI */
  glowColor: string;
}
