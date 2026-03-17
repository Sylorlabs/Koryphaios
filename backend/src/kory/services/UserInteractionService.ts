// UserInteractionService - Handles user input prompts and WebSocket emissions
// Extracted from KoryManager to separate concerns

import { wsBroker } from "../../pubsub";
import type {
  KoryAskUserPayload,
  ChangeSummary,
  StreamUsagePayload,
  KoryThoughtPayload,
  AgentIdentity,
  AgentStatus,
} from "@koryphaios/shared";
import { koryLog } from "../../logger";

export class UserInteractionService {
  private pendingUserInputs = new Map<string, (selection: string) => void>();

  /**
   * Request user input with a question and options
   */
  async requestInput(sessionId: string, question: string, options: string[]): Promise<string> {
    this.emitWSMessage(sessionId, "kory.ask_user", { question, options, allowOther: true } satisfies KoryAskUserPayload);
    
    return new Promise<string>((resolve) => {
      this.pendingUserInputs.set(sessionId, resolve);
    });
  }

  /**
   * Handle user input response
   */
  handleInput(sessionId: string, selection: string, text?: string): void {
    const resolver = this.pendingUserInputs.get(sessionId);
    if (resolver) {
      resolver(text || selection);
      this.pendingUserInputs.delete(sessionId);
    }
  }

  /**
   * Emit thought/status message
   */
  emitThought(sessionId: string, phase: KoryThoughtPayload["phase"] | "planning" | "executing", message: string): void {
    this.emitWSMessage(sessionId, "kory.thinking", { thought: message, phase } as KoryThoughtPayload);
  }

  /**
   * Emit error message
   */
  emitError(sessionId: string, error: string): void {
    this.emitWSMessage(sessionId, "error", { message: error, code: "MANAGER_ERROR" });
  }

  /**
   * Emit agent status update
   */
  emitAgentStatus(sessionId: string, agentId: string, status: AgentStatus): void {
    this.emitWSMessage(sessionId, "agent.status", { agentId, status });
  }

  /**
   * Emit agent spawned event
   */
  emitAgentSpawned(sessionId: string, agent: AgentIdentity, task: string): void {
    this.emitWSMessage(sessionId, "agent.spawned", { agent, task });
  }

  /**
   * Emit stream delta
   */
  emitStreamDelta(sessionId: string, agentId: string, content: string, model?: string): void {
    this.emitWSMessage(sessionId, "stream.delta", { agentId, content, model });
  }

  /**
   * Emit tool call
   */
  emitToolCall(sessionId: string, agentId: string, toolCall: { id: string; name: string; input: Record<string, unknown> }): void {
    this.emitWSMessage(sessionId, "stream.tool_call", { agentId, toolCall });
  }

  /**
   * Emit tool result
   */
  emitToolResult(sessionId: string, agentId: string, toolResult: unknown): void {
    this.emitWSMessage(sessionId, "stream.tool_result", { agentId, toolResult });
  }

  /**
   * Emit file edit delta
   */
  emitFileDelta(sessionId: string, agentId: string, edit: { path: string; delta: string; totalLength: number; operation: "create" | "edit" }): void {
    this.emitWSMessage(sessionId, "stream.file_delta", { agentId, ...edit });
  }

  /**
   * Emit file edit complete
   */
  emitFileComplete(sessionId: string, agentId: string, fileInfo: { path: string }): void {
    this.emitWSMessage(sessionId, "stream.file_complete", { agentId, ...fileInfo });
  }

  /**
   * Emit session changes summary
   */
  emitChanges(sessionId: string, changes: ChangeSummary[]): void {
    this.emitWSMessage(sessionId, "session.changes", { changes });
  }

  /**
   * Emit usage update
   */
  emitUsage(
    sessionId: string,
    agentId: string,
    model: string,
    provider: string,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean
  ): void {
    const payload: StreamUsagePayload = {
      agentId,
      model,
      provider: provider as any,
      tokensIn,
      tokensOut,
      tokensUsed: tokensIn + tokensOut,
      usageKnown,
      contextKnown: true,
    };
    this.emitWSMessage(sessionId, "stream.usage", payload);
  }

  /**
   * Generic WebSocket message emitter
   */
  emitWSMessage<T>(sessionId: string, type: string, payload: T): void {
    try {
      wsBroker.publish(type as any, {
        sessionId,
        ...payload as any,
      });
    } catch (err) {
      koryLog.debug({ error: err instanceof Error ? err.message : String(err), type, sessionId }, "Failed to emit WS message");
    }
  }

  /**
   * Cleanup pending inputs for a session
   */
  cleanupSession(sessionId: string): void {
    this.pendingUserInputs.delete(sessionId);
  }

  /**
   * Check if session has pending input
   */
  hasPendingInput(sessionId: string): boolean {
    return this.pendingUserInputs.has(sessionId);
  }

  /**
   * Get count of pending user inputs
   */
  getPendingInputCount(): number {
    return this.pendingUserInputs.size;
  }
}
