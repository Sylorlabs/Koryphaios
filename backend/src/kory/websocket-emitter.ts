// WebSocket Emitter
// Domain: Real-time event broadcasting to frontend
// Extracted from manager.ts lines 1019-1046

import type {
  WSMessage,
  ProviderName,
  WorkerDomain,
  KoryThoughtPayload,
  KoryRoutingPayload,
  ErrorPayload,
  StreamUsagePayload,
} from "@koryphaios/shared";
import { resolveTrustedContextWindow } from "../providers";
import { wsBroker } from "../pubsub";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface WebSocketEmitterDependencies {
  managerAgentId: string;
}

// ─── WebSocketEmitter Class ────────────────────────────────────────────────────

export class WebSocketEmitter {
  private managerAgentId: string;

  constructor(deps: WebSocketEmitterDependencies) {
    this.managerAgentId = deps.managerAgentId;
  }

  /**
   * Broadcast a thought/process update from the manager.
   *
   * @param sessionId - Session identifier
   * @param phase - Current phase (analyzing, routing, delegating, verifying, synthesizing)
   * @param thought - The thought content to broadcast
   */
  emitThought(sessionId: string, phase: string, thought: string): void {
    const payload: KoryThoughtPayload = { thought, phase: phase as KoryThoughtPayload["phase"] };
    this.emitWSMessage(sessionId, "kory.thought", payload);
  }

  /**
   * Broadcast a routing decision (model/provider selection).
   *
   * @param sessionId - Session identifier
   * @param domain - Worker domain being routed to
   * @param model - Selected model
   * @param provider - Selected provider
   * @param reasoning - Explanation for the routing decision
   */
  emitRouting(
    sessionId: string,
    domain: WorkerDomain,
    model: string,
    provider: ProviderName,
    reasoning?: string
  ): void {
    const payload: KoryRoutingPayload = {
      domain,
      selectedModel: model,
      selectedProvider: provider,
      reasoning: reasoning ?? `Routing to ${model} via ${provider}`,
    };
    this.emitWSMessage(sessionId, "kory.routing", payload);
  }

  /**
   * Broadcast an error message.
   *
   * @param sessionId - Session identifier
   * @param error - Error message
   * @param code - Optional error code
   * @param details - Optional error details
   */
  emitError(sessionId: string, error: string, code?: string, details?: string): void {
    const payload: ErrorPayload = { sessionId, error, ...(code && { code }), ...(details && { details }) };
    this.emitWSMessage(sessionId, "system.error", payload);
  }

  /**
   * Broadcast token usage update after an LLM turn.
   *
   * @param sessionId - Session identifier
   * @param agentId - Agent that used the tokens
   * @param model - Model that was used
   * @param provider - Provider that was used
   * @param tokensIn - Input tokens consumed
   * @param tokensOut - Output tokens consumed
   * @param usageKnown - Whether usage counters are reliable
   */
  emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean
  ): void {
    const context = resolveTrustedContextWindow(model, provider);

    const payload: StreamUsagePayload = {
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      tokensUsed: tokensIn + tokensOut,
      usageKnown,
      contextKnown: context.contextKnown,
      ...(context.contextWindow ? { contextWindow: context.contextWindow } : {}),
    };

    this.emitWSMessage(sessionId, "stream.usage", payload);
  }

  /**
   * Generic WebSocket message broadcaster.
   *
   * @param sessionId - Session identifier
   * @param type - WebSocket event type
   * @param payload - Message payload
   */
  emitWSMessage<T = unknown>(sessionId: string, type: WSMessage["type"], payload: T): void {
    wsBroker.publish("custom", {
      type,
      payload,
      timestamp: Date.now(),
      sessionId,
      agentId: this.managerAgentId,
    } as WSMessage<T>);
  }

  /**
   * Broadcast agent status update.
   *
   * @param sessionId - Session identifier
   * @param agentId - Agent identifier
   * @param status - New agent status
   * @param detail - Optional status detail
   */
  emitAgentStatus(sessionId: string, agentId: string, status: string, detail?: string): void {
    this.emitWSMessage(sessionId, "agent.status", {
      agentId,
      status,
      ...(detail && { detail }),
    });
  }

  /**
   * Broadcast that an agent was spawned.
   *
   * @param sessionId - Session identifier
   * @param agentId - New agent's ID
   * @param name - Agent name
   * @param role - Agent role
   * @param domain - Worker domain
   * @param glowColor - UI glow color
   */
  emitAgentSpawned(
    sessionId: string,
    agentId: string,
    name: string,
    role: string,
    domain: string,
    glowColor: string
  ): void {
    this.emitWSMessage(sessionId, "agent.spawned", {
      agent: {
        id: agentId,
        name,
        role,
        model: "unknown", // Will be updated when model is selected
        provider: "unknown" as ProviderName,
        domain,
        glowColor,
      },
      task: "Task delegation",
    });
  }

  /**
   * Broadcast a message delta (streaming content).
   *
   * @param sessionId - Session identifier
   * @param agentId - Agent generating the content
   * @param content - Delta content
   * @param model - Model being used
   */
  emitStreamDelta(sessionId: string, agentId: string, content: string, model: string): void {
    this.emitWSMessage(sessionId, "stream.delta", {
      agentId,
      content,
      model,
    });
  }

  /**
   * Broadcast that a stream is complete.
   *
   * @param sessionId - Session identifier
   * @param messageId - Message that was completed
   * @param agentId - Agent that completed
   * @param tokensIn - Input tokens used
   * @param tokensOut - Output tokens generated
   */
  emitStreamComplete(
    sessionId: string,
    messageId: string,
    agentId: string,
    tokensIn?: number,
    tokensOut?: number
  ): void {
    this.emitWSMessage(sessionId, "stream.complete", {
      messageId,
      agentId,
      ...(tokensIn !== undefined && { tokensIn }),
      ...(tokensOut !== undefined && { tokensOut }),
    });
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

let globalEmitter: WebSocketEmitter | null = null;

export function initWebSocketEmitter(managerAgentId: string): WebSocketEmitter {
  if (!globalEmitter) {
    globalEmitter = new WebSocketEmitter({ managerAgentId });
  }
  return globalEmitter;
}

export function getWebSocketEmitter(): WebSocketEmitter | null {
  return globalEmitter;
}
