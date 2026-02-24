export type FeedEntryType = "user_message" | "thought" | "content" | "thinking" | "tool_call" | "tool_result" | "routing" | "error" | "system" | "tool_group";

export interface FeedEntryLocal {
  id: string;
  timestamp: number;
  type: FeedEntryType;
  agentId: string;
  agentName: string;
  glowClass: string;
  text: string;
  durationMs?: number;
  thinkingStartedAt?: number;
  isCollapsed?: boolean;
  entries?: FeedEntryLocal[];
  metadata?: Record<string, unknown>;
}
