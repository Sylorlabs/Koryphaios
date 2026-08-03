// Message Types
// Domain: Message and content block structures

import type { ProviderName, ToolCall, ToolResult } from '../index';

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

/** Flattened message structure for database storage */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string; // JSON string of ContentBlock[] or raw text
  /** Durable user-supplied attachments. The database stores these alongside
   *  the text blocks so a reload, regeneration, or edited-history replay does
   *  not silently turn a multimodal message into text-only context. */
  attachments?: Array<{
    type: 'image' | 'file';
    data: string;
    name: string;
    mimeType?: string;
  }>;
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  variantGroupId?: string;
  variantIndex?: number;
  /** Typed classifier for system messages (e.g. 'cancelled', 'compacted').
   *  Stored inside the first content block's `kind` field so no DB migration
   *  is needed. Lets the frontend render system rows by type instead of
   *  pattern-matching their text. */
  kind?: string;
  createdAt: number;
}
