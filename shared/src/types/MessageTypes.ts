// Message Types
// Domain: Message and content block structures

import type { ProviderName, ToolCall, ToolResult } from '../index';
import type { TranscriptPart } from '../transcript/TranscriptParts';

export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';

export interface ContentBlock {
  type: ContentBlockType;
  text?: string;
  thinking?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  imageUrl?: string;
  data?: string;
  name?: string;
  mimeType?: string;
}

export interface MessageAttachment {
  type: 'image' | 'file';
  data: string;
  name: string;
  mimeType?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  variantGroupId?: string;
  variantIndex?: number;
  attachments?: MessageAttachment[];
  createdAt: number;
}

/** Token usage an imported chat recorded in its source CLI. Display-only:
 *  never written to `tokensIn`/`tokensOut`/`cost`, so imported history can
 *  never count toward spend caps or analytics. */
export interface ImportedTokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Counted by Koryphaios at import (the shared chars/4 planning estimate)
   *  because the source CLI recorded no usage. Never provider-reported. */
  estimated?: true;
}

/** Flattened message structure for database storage */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string; // JSON string of ContentBlock[] or raw text
  /** Verbatim assistant reasoning, persisted as a thinking content block. */
  reasoningContent?: string;
  /** Ordered display parts for an assistant turn (reasoning/text/tool). Display only;
   *  reasoningContent stays the provider replay input. See docs/architecture/transcript-integrity.md. */
  parts?: TranscriptPart[];
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  variantGroupId?: string;
  variantIndex?: number;
  attachments?: MessageAttachment[];
  /** Conversation generation used for manager context. Older revisions remain visible/auditable. */
  contextRevision?: number;
  /** Display projection only: true when this retained row belongs to the durable active lineage. */
  isActiveBranch?: boolean;
  /** The source of an imported row recorded no time for it. `createdAt` then only
   *  orders the row; the UI must show "Time unknown" rather than a clock time. */
  timeUnknown?: true;
  /** Token usage recorded by the source CLI for an imported row. Display-only. */
  importedUsage?: ImportedTokenUsage;
  createdAt: number;
}
