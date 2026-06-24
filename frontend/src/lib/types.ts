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
  | 'tool_group';

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
  /** DB message ID — set for user/assistant turns that are persisted; undefined for ephemeral entries */
  storageId?: string;
  /** True when this entry is soft-hidden from agent context but still visible to the user */
  hiddenFromAgent?: boolean;
}

/** Alias used by store modules */
export type FeedEntry = FeedEntryLocal;
