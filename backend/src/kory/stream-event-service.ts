/**
 * Stream Event Service
 * Domain: WebSocket event emission and streaming updates
 *
 * Extracted from manager.ts to separate event emission concerns
 * from orchestration logic.
 */

import type {
  WSMessage,
  WorkerDomain,
  ProviderName,
  StreamUsagePayload,
  ContextBreakdown,
} from '@koryphaios/shared';
import { wsBroker } from '../pubsub';
import { resolveTrustedContextWindow } from '../providers';
import { koryLog } from '../logger';
import { collaborationManager } from '../collaboration/manager';

export interface StreamEventServiceDependencies {
  managerAgentId: string;
}

/**
 * Service responsible for all WebSocket event emissions.
 * Centralizes stream updates, agent status changes, and system notifications.
 */
export class StreamEventService {
  private managerAgentId: string;

  constructor(deps: StreamEventServiceDependencies) {
    this.managerAgentId = deps.managerAgentId;
  }

  /**
   * Emit a thought event (manager reasoning update)
   */
  emitThought(sessionId: string, phase: string, thought: string): void {
    this.emitWSMessage(sessionId, 'kory.thought', { thought, phase });
    koryLog.debug({ sessionId, phase }, 'Thought emitted');
  }

  /**
   * Emit routing decision
   */
  emitRouting(sessionId: string, domain: WorkerDomain, model: string, provider: string): void {
    this.emitWSMessage(sessionId, 'kory.routing', {
      domain,
      selectedModel: model,
      selectedProvider: provider,
      reasoning: `Routing to ${model} via ${provider}`,
    });
  }

  /**
   * Emit error message
   */
  emitError(sessionId: string, error: string): void {
    this.emitWSMessage(sessionId, 'system.error', { error });
    koryLog.warn({ sessionId, error }, 'Error emitted');
  }

  /**
   * Emit usage update with token counts
   */
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
      ...(context.contextWindow ? { contextWindow: context.contextWindow } : {}),
      ...(breakdown ? { breakdown } : {}),
    };
    this.emitWSMessage(sessionId, 'stream.usage', payload);
  }

  /**
   * Emit agent status change
   */
  emitAgentStatus(sessionId: string, agentId: string, status: string, detail?: string): void {
    this.emitWSMessage(sessionId, 'agent.status', { agentId, status, detail });
  }

  /**
   * Emit agent spawned event
   */
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
    this.emitWSMessage(sessionId, 'agent.spawned', { agent });
  }

  /**
   * Emit streaming content delta
   */
  emitStreamDelta(sessionId: string, agentId: string, content: string, model: string): void {
    this.emitWSMessage(sessionId, 'stream.delta', { agentId, content, model });
  }

  /**
   * Emit tool call started
   */
  emitToolCall(
    sessionId: string,
    agentId: string,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
  ): void {
    this.emitWSMessage(sessionId, 'stream.tool_call', { agentId, toolCall });
  }

  /**
   * Emit tool call result
   */
  emitToolResult(
    sessionId: string,
    agentId: string,
    toolResult: { id: string; output: string; isError?: boolean },
  ): void {
    this.emitWSMessage(sessionId, 'stream.tool_result', { agentId, toolResult });
  }

  /**
   * Emit file edit delta
   */
  emitFileEdit(sessionId: string, agentId: string, edit: { path: string; patch: string }): void {
    this.emitWSMessage(sessionId, 'stream.file_delta', { agentId, ...edit });
  }

  /**
   * Emit file edit complete
   */
  emitFileComplete(
    sessionId: string,
    agentId: string,
    file: { path: string; content: string },
  ): void {
    this.emitWSMessage(sessionId, 'stream.file_complete', { agentId, ...file });
  }

  /**
   * Emit stream clear content
   */
  emitStreamClear(sessionId: string, agentId: string): void {
    this.emitWSMessage(sessionId, 'stream.clear_content', { agentId });
  }

  /**
   * Emit session changes
   */
  emitSessionChanges(
    sessionId: string,
    changes: Array<{ type: string; path: string; description: string }>,
  ): void {
    this.emitWSMessage(sessionId, 'session.changes', { changes });
  }

  /**
   * Emit context detection results
   */
  emitContextDetected(sessionId: string, files: Array<{ path: string; relevance: number }>): void {
    this.emitWSMessage(sessionId, 'context.detected', { files });
  }

  /**
   * Emit system notification
   */
  emitNotification(sessionId: string, type: 'info' | 'warning' | 'success', message: string): void {
    this.emitWSMessage(sessionId, 'system.notification', { type, message });
  }

  /**
   * Generic WebSocket message emission
   */
  emitWSMessage(sessionId: string, type: string, payload: WSMessage['payload']): void {
    wsBroker.publish('custom', {
      type: type as WSMessage['type'],
      payload,
      timestamp: Date.now(),
      sessionId,
      agentId: this.managerAgentId,
    });

    // Mirror relevant events to collaboration relay guests
    this.relayBroadcast(type, payload);
  }

  private relayBroadcast(type: string, payload: WSMessage['payload']): void {
    // Only forward meaningful events — skip usage counters, routing decisions, etc.
    if (type === 'stream.file_complete') {
      const p = payload as any;
      if (p?.diff) {
        collaborationManager.broadcastEvent({ type: 'diff', path: p.path ?? '', diff: p.diff });
      }
    } else if (type === 'agent.status') {
      const p = payload as any;
      collaborationManager.broadcastEvent({ type: 'agent-status', status: `${p?.agentId ?? 'agent'}: ${p?.status ?? ''}` });
    } else if (type === 'stream.delta') {
      const p = payload as any;
      if (p?.content) {
        collaborationManager.broadcastEvent({ type: 'log', content: p.content });
      }
    } else if (type === 'system.notification') {
      const p = payload as any;
      collaborationManager.broadcastEvent({ type: 'log', content: `[${p?.type ?? 'info'}] ${p?.message ?? ''}` });
    }
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

export const streamEventService = new StreamEventService({
  managerAgentId: 'kory-manager',
});
