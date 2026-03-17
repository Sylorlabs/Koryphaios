// Message Formatter Utility
// Converts internal message format to provider-specific formats

import type { InternalMessage, CompletedToolCall } from "@koryphaios/shared";
import type { ProviderMessage } from "../../providers/types";

/**
 * Convert internal message format to provider format.
 * Handles tool_call_id for tool results and tool_calls for assistant messages.
 *
 * @param messages - Internal message format
 * @returns Provider message format
 */
export function toProviderMessages(messages: InternalMessage[]): ProviderMessage[] {
  return messages.map((m) => {
    const out: ProviderMessage = { role: m.role, content: m.content };
    if (m.role === "tool" && m.tool_call_id != null) {
      out.tool_call_id = m.tool_call_id;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.tool_calls = m.tool_calls;
    }
    return out;
  });
}

/**
 * Format messages for critic review - truncates to limit and creates readable transcript
 *
 * @param messages - Messages to format
 * @param maxChars - Maximum characters for the transcript
 * @returns Formatted transcript string
 */
export function formatMessagesForCritic(
  messages: InternalMessage[],
  maxChars: number = 12_000
): string {
  const formatted = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = m.content.slice(0, 500); // Per-message limit
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  if (formatted.length > maxChars) {
    return formatted.slice(0, maxChars) + "\n\n[... truncated]";
  }
  return formatted;
}

/**
 * Parse and validate a raw LLM response as JSON.
 * Handles fenced code blocks and extracts the first complete object.
 *
 * @param raw - Raw LLM response text
 * @returns Parsed JSON object or null if invalid
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Handle fenced code blocks (```json ... ```)
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) return fenced;
  }

  // Handle plain JSON object
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  // Try to extract object from mixed content
  const objectStarts = (trimmed.match(/\{/g) ?? []).length;
  const objectEnds = (trimmed.match(/\}/g) ?? []).length;

  // Ambiguous: multiple objects
  if (objectStarts > 1 && objectEnds > 1) return "";

  // Extract first complete object
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

/**
 * Format tool call input for display/logging
 *
 * @param input - Tool call input object
 * @returns Truncated string representation
 */
export function formatToolInput(input: Record<string, unknown>): string {
  const str = JSON.stringify(input);
  if (str.length > 200) {
    return str.slice(0, 200) + "...";
  }
  return str;
}

/**
 * Create a system message for the given content
 */
export function createSystemMessage(content: string): InternalMessage {
  return { role: "system", content };
}

/**
 * Create a user message for the given content
 */
export function createUserMessage(content: string): InternalMessage {
  return { role: "user", content };
}

/**
 * Create an assistant message for the given content
 */
export function createAssistantMessage(
  content: string,
  toolCalls?: CompletedToolCall[]
): InternalMessage {
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls,
  };
}

/**
 * Create a tool message for the given result
 */
export function createToolMessage(
  content: string,
  toolCallId: string
): InternalMessage {
  return {
    role: "tool",
    content,
    tool_call_id: toolCallId,
  };
}
