export type FeedEntryType =
  | 'user_message'
  | 'thought'
  | 'content'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'routing'
  | 'skill'
  | 'error'
  | 'system'
  | 'compaction'
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
  /** Thinking block: provider signalled reasoning is over — timer is final. */
  thinkingFinalized?: boolean;
  /** Hidden from the user's view only (agent keeps it in context). */
  userHidden?: boolean;
  /** Stubbed out of the agent's context (user still sees it). */
  agentHidden?: boolean;
  /** The row's source recorded no clock time (imported chats). `timestamp` then
   *  only orders the row; the UI shows "Time unknown", never a clock time. */
  timeUnknown?: true;
  /** The source recorded no duration for this reasoning block / tool call.
   *  The UI must never render a duration (and never "0.0s") for it. */
  durationUnknown?: true;
}

/** Alias used by store modules */
export type FeedEntry = FeedEntryLocal;
