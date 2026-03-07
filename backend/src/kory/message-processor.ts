// Message Processor
// Domain: LLM turn processing and streaming
// Extracted from manager.ts lines 699-905, 1000-1008

import type { ProviderName, StreamUsagePayload } from "@koryphaios/shared";
import type { ProviderMessage } from "../providers/types";
import { withTimeoutSignal, resolveTrustedContextWindow, type ProviderRegistry, type ProviderEvent, type ToolRegistry } from "../providers";
import { AGENT } from "../constants";
import type { ToolContext } from "../tools";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ProcessTurnResult {
  success: boolean;
  content?: string;
  usage?: { tokensIn: number; tokensOut: number };
  completedToolCalls?: CompletedToolCall[];
  error?: string;
}

export interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MessageProcessorDependencies {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  managerAgentId: string;
  systemPrompt: string;
  emitUsageUpdate: (sessionId: string, agentId: string, model: string, provider: ProviderName, tokensIn: number, tokensOut: number, usageKnown: boolean) => void;
  emitWSMessage: (sessionId: string, type: string, payload: unknown) => void;
}

// ─── MessageProcessor Class ─────────────────────────────────────────────────────

export class MessageProcessor {
  private providers: ProviderRegistry;
  private tools: ToolRegistry;
  private managerAgentId: string;
  private systemPrompt: string;
  private emitUsageUpdate: MessageProcessorDependencies["emitUsageUpdate"];
  private emitWSMessage: MessageProcessorDependencies["emitWSMessage"];

  constructor(deps: MessageProcessorDependencies) {
    this.providers = deps.providers;
    this.tools = deps.tools;
    this.managerAgentId = deps.managerAgentId;
    this.systemPrompt = deps.systemPrompt;
    this.emitUsageUpdate = deps.emitUsageUpdate;
    this.emitWSMessage = deps.emitWSMessage;
  }

  /**
   * Process a manager turn with streaming and tool execution.
   *
   * @param sessionId - Session identifier
   * @param modelId - Model to use
   * @param provider - Provider instance
   * @param messages - Conversation history
   * @param ctx - Tool execution context
   * @param signal - Optional abort signal
   * @returns Turn processing result
   */
  async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: { name: ProviderName },
    messages: any[],
    ctx: ToolContext,
    signal?: AbortSignal
  ): Promise<ProcessTurnResult> {
    if (signal?.aborted) {
      throw new DOMException("Manager run aborted", "AbortError");
    }

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: this.systemPrompt,
        messages: this.toProviderMessages(messages),
        tools: this.tools.getToolDefsForRole("manager"),
        maxTokens: 16384,
        signal: streamSignal,
      },
      provider.name
    );

    let assistantContent = "";
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let contentBuffer = ""; // Buffer to avoid streaming if turn only delegates to worker

    for await (const event of stream) {
      if (signal?.aborted) {
        throw new DOMException("Manager run aborted", "AbortError");
      }

      if (event.type === "error") {
        throw new Error((event as any).error ?? "LLM stream error");
      }

      if (event.type === "content_delta") {
        assistantContent += event.content ?? "";
        contentBuffer += event.content ?? "";
      } else if (event.type === "usage_update") {
        if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
        if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
        this.emitUsageUpdate(sessionId, this.managerAgentId, modelId, provider.name, tokensIn, tokensOut, true);
      } else if (event.type === "tool_use_start") {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, {
          name: event.toolName!,
          input: ""
        });
        this.emitWSMessage(sessionId, "stream.tool_call", {
          agentId: this.managerAgentId,
          toolCall: { id: event.toolCallId, name: event.toolName, input: {} }
        });
      } else if (event.type === "tool_use_delta") {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? "";
      } else if (event.type === "tool_use_stop") {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || "{}");
          } catch {
            parsedInput = {};
          }
          completedToolCalls.push({
            id: event.toolCallId!,
            name: call.name,
            input: parsedInput
          });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    // Only emit content if this turn doesn't solely delegate to a worker
    const isDelegationOnly = hasToolCalls &&
      completedToolCalls.length === 1 &&
      completedToolCalls[0]!.name === "delegate_to_worker";

    if (!isDelegationOnly && contentBuffer) {
      this.emitWSMessage(sessionId, "stream.delta", {
        agentId: this.managerAgentId,
        content: contentBuffer,
        model: modelId
      });
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: hasToolCalls && completedToolCalls.length > 0
        ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
        : undefined,
    });

    if (hasToolCalls && completedToolCalls.length > 0) {
      return { success: true, content: assistantContent, usage: { tokensIn, tokensOut }, completedToolCalls };
    }

    return { success: false, content: assistantContent, usage: { tokensIn, tokensOut } };
  }

  /**
   * Process a provider turn for a worker agent.
   *
   * @param sessionId - Session identifier
   * @param workerId - Worker agent ID
   * @param modelId - Model to use
   * @param provider - Provider instance
   * @param messages - Conversation history
   * @param ctx - Tool execution context
   * @param reasoningLevel - Optional reasoning level
   * @param signal - Optional abort signal
   * @returns Turn processing result
   */
  async processProviderTurn(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: { name: ProviderName },
    messages: any[],
    ctx: ToolContext,
    reasoningLevel?: string,
    signal?: AbortSignal
  ): Promise<ProcessTurnResult> {
    if (signal?.aborted) {
      throw new DOMException("Worker run aborted", "AbortError");
    }

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: "You are a helpful coding assistant.",
        messages: this.toProviderMessages(messages),
        tools: this.tools.getToolDefsForRole("coder"),
        maxTokens: 8192,
        reasoningLevel,
        signal: streamSignal,
      },
      provider.name
    );

    let assistantContent = "";
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;
    let tokensIn = 0;
    let tokensOut = 0;

    for await (const event of stream) {
      if (signal?.aborted) {
        throw new DOMException("Worker run aborted", "AbortError");
      }

      if (event.type === "error") {
        throw new Error((event as any).error ?? "LLM stream error");
      }

      if (event.type === "content_delta") {
        assistantContent += event.content ?? "";
        this.emitWSMessage(sessionId, "stream.delta", {
          agentId: workerId,
          content: event.content ?? "",
          model: modelId
        });
      } else if (event.type === "usage_update") {
        if (typeof event.tokensIn === "number") tokensIn = Math.max(tokensIn, event.tokensIn);
        if (typeof event.tokensOut === "number") tokensOut = Math.max(tokensOut, event.tokensOut);
        this.emitUsageUpdate(sessionId, workerId, modelId, provider.name, tokensIn, tokensOut, true);
      } else if (event.type === "tool_use_start") {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        this.emitWSMessage(sessionId, "stream.tool_call", {
          agentId: workerId,
          toolCall: { id: event.toolCallId, name: event.toolName, input: {} }
        });
      } else if (event.type === "tool_use_delta") {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? "";
      } else if (event.type === "tool_use_stop") {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || "{}");
          } catch {
            parsedInput = {};
          }
          completedToolCalls.push({
            id: event.toolCallId!,
            name: call.name,
            input: parsedInput
          });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: hasToolCalls && completedToolCalls.length > 0
        ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
        : undefined,
    });

    return {
      success: !hasToolCalls,
      content: assistantContent,
      usage: { tokensIn, tokensOut },
      completedToolCalls
    };
  }

  /**
   * Convert internal message format to provider format.
   * Handles tool_call_id for tool results and tool_calls for assistant messages.
   *
   * @param messages - Internal message format
   * @returns Provider message format
   */
  toProviderMessages(messages: any[]): ProviderMessage[] {
    return messages.map((m: any) => {
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
}
