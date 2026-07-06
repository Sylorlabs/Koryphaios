export type FeedEntryType =
  | 'user_message'
  | 'thought'
  | 'content'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'routing'
  | 'error'
  | 'system'
  | 'tool_group'
  | 'agent_group';

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
  ghostHash?: string;
  /** Hidden from the user's view only (agent keeps it in context). */
  userHidden?: boolean;
  /** Stubbed out of the agent's context (user still sees it). */
  agentHidden?: boolean;
}

/** Alias used by store modules */
export type FeedEntry = FeedEntryLocal;
