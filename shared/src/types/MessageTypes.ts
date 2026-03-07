// Message Types
// Domain: Message and content block structures

import type { ProviderName, ToolCall, ToolResult } from "../index";

export type ContentBlockType = "text" | "thinking" | "tool_use" | "tool_result" | "image";

export interface ContentBlock {
  type: ContentBlockType;
  text?: string;
  thinking?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  imageUrl?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
}

/** Flattened message structure for database storage */
export interface StoredMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string; // JSON string of ContentBlock[] or raw text
  model?: string;
  provider?: ProviderName;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  createdAt: number;
}
