// Internal Message Types
// Shared types for message processing across backend services

/**
 * Internal message format used within KoryManager and services
 * This is the canonical representation before conversion to provider-specific formats
 */
export interface InternalMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
}

/**
 * Represents a completed tool call with parsed input
 */
export interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Result of processing a single LLM turn
 */
export interface LLMTurnResult {
  success: boolean;
  content?: string;
  usage?: {
    tokensIn: number;
    tokensOut: number;
  };
  completedToolCalls?: CompletedToolCall[];
}

/**
 * Result of processing a provider turn for workers
 */
export interface ProcessTurnResult {
  success: boolean;
  content?: string;
  usage?: {
    tokensIn: number;
    tokensOut: number;
  };
  completedToolCalls?: CompletedToolCall[];
  error?: string;
}
