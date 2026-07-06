/**
 * EventEmitterService
 *
 * Wraps WebSocket event emission logic extracted from KoryManager.
 * This is a thin wrapper that centralizes all event emission calls.
 *
 * Note: This is NOT a standalone service - it requires wsBroker from pubsub.
 */

import type {
  WSMessage,
  WorkerDomain,
  ProviderName,
  StreamUsagePayload,
  ContextBreakdown,
  KoryAskUserPayload,
} from '@koryphaios/shared';
import { resolveTrustedContextWindow } from '../../providers';
import { wsBroker } from '../../pubsub';
import { koryLog } from '../../logger';

export interface EventEmitterServiceConfig {
  managerAgentId: string;
}

/**
 * Centralized event emission service.
 *
 * Extracted from KoryManager to reduce its line count and centralize
 * all WebSocket event emission logic.
 */
export class EventEmitterService {
  private managerAgentId: string;

  constructor(config: EventEmitterServiceConfig) {
    this.managerAgentId = config.managerAgentId;
  }

  // ─── Kory Events ─────────────────────────────────────────────────────────────

  emitThought(sessionId: string, phase: string, thought: string): void {
    this.emit(sessionId, 'kory.thought', { thought, phase });
  }

  emitRouting(sessionId: string, domain: WorkerDomain, model: string, provider: string): void {
    this.emit(sessionId, 'kory.routing', {
      domain,
      selectedModel: model,
      selectedProvider: provider,
      reasoning: `Routing to ${model} via ${provider}`,
    });
  }

  emitAskUser(sessionId: string, question: string, options: string[], allowOther = true): void {
    this.emit(sessionId, 'kory.ask_user', {
      question,
      options,
      allowOther,
    } satisfies KoryAskUserPayload);
  }

  // ─── Agent Events ────────────────────────────────────────────────────────────

  emitAgentStatus(sessionId: string, agentId: string, status: string, detail?: string): void {
    this.emit(sessionId, 'agent.status', { agentId, status, detail });
  }

  emitAgentSpawned(
    sessionId: string,
    agent: {
      id: string;
      name: string;
      role: string;
      model: string;
      provider: string;
      domain: string;
    },
  ): void {
    this.emit(sessionId, 'agent.spawned', { agent });
  }

  // ─── Stream Events ───────────────────────────────────────────────────────────

  emitStreamDelta(sessionId: string, agentId: string, content: string, model: string): void {
    this.emit(sessionId, 'stream.delta', { agentId, content, model });
  }

  emitStreamComplete(
    sessionId: string,
    agentId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
  ): void {
    this.emit(sessionId, 'stream.complete', { agentId, model, tokensIn, tokensOut });
  }

  emitStreamClear(sessionId: string, agentId: string): void {
    this.emit(sessionId, 'stream.clear_content', { agentId });
  }

  emitToolCall(
    sessionId: string,
    agentId: string,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
  ): void {
    this.emit(sessionId, 'stream.tool_call', { agentId, toolCall });
  }

  emitToolResult(
    sessionId: string,
    agentId: string,
    toolResult: { id: string; output: string; isError?: boolean },
  ): void {
    this.emit(sessionId, 'stream.tool_result', { agentId, toolResult });
  }

  emitFileEdit(sessionId: string, agentId: string, edit: { path: string; patch: string }): void {
    this.emit(sessionId, 'stream.file_delta', { agentId, ...edit });
  }

  emitFileComplete(
    sessionId: string,
    agentId: string,
    file: { path: string; content: string },
  ): void {
    this.emit(sessionId, 'stream.file_complete', { agentId, ...file });
  }

  // ─── Usage & System Events ───────────────────────────────────────────────────

  emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean,
    breakdown?: ContextBreakdown,
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
      ...(context.contextSource ? { contextSource: context.contextSource } : {}),
      ...(context.contextWindow ? { contextWindow: context.contextWindow } : {}),
      ...(breakdown ? { breakdown } : {}),
    };
    this.emit(sessionId, 'stream.usage', payload);
  }

  emitError(sessionId: string, error: string): void {
    this.emit(sessionId, 'system.error', { error });
  }

  emitNotification(sessionId: string, type: 'info' | 'warning' | 'success', message: string): void {
    this.emit(sessionId, 'system.notification', { type, message });
  }

  // ─── Session Events ──────────────────────────────────────────────────────────

  emitSessionChanges(
    sessionId: string,
    changes: Array<{ type: string; path: string; description: string }>,
  ): void {
    this.emit(sessionId, 'session.changes', { changes });
  }

  emitContextDetected(sessionId: string, files: Array<{ path: string; relevance: number }>): void {
    this.emit(sessionId, 'context.detected', { files });
  }

  // ─── Generic Emit ────────────────────────────────────────────────────────────

  /**
   * Emit a WebSocket message to a session.
   * This is the core method all other emit methods use.
   */
  emit(sessionId: string, type: string, payload: WSMessage['payload']): void {
    wsBroker.publish('custom', {
      type: type as WSMessage['type'],
      payload,
      timestamp: Date.now(),
      sessionId,
      agentId: this.managerAgentId,
    });
  }

  // ─── Logging Utilities ───────────────────────────────────────────────────────

  info(msg: string, meta?: Record<string, unknown>): void {
    koryLog.info(meta, msg);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    koryLog.warn(meta, msg);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    koryLog.debug(meta, msg);
  }
}

// Singleton instance (for gradual migration)
let globalEmitter: EventEmitterService | null = null;

export function getGlobalEmitter(managerAgentId: string): EventEmitterService {
  if (!globalEmitter) {
    globalEmitter = new EventEmitterService({ managerAgentId });
  }
  return globalEmitter;
}
