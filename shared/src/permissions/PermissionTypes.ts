// Permission System Types
// Domain: User permission requests and responses

// Re-export ToolName to avoid circular dependency
export type { ToolName } from "../types/ToolTypes";

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: ToolName;
  action: string;
  path?: string;
  description: string;
  createdAt: number;
}

export type PermissionResponse = "granted" | "denied" | "granted_session";

import type { ToolName } from "../types/ToolTypes";
