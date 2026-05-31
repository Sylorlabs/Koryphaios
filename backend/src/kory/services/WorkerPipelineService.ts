/**
 * WorkerPipelineService
 * Handles the worker task execution pipeline with worktree isolation
 * Extracted from manager.ts runWorkerPipeline() and routeToWorker() methods
 */

import type { ProviderName, WorkerDomain, ChangeSummary } from '@koryphaios/shared';
import { AGENT, DOMAIN } from '../../constants';
import type { ProviderRegistry } from '../../providers';
import type { Provider, ProviderEvent } from '../../providers/types';
import type { ProviderMessage } from '../../providers/types';
import { getModelsForProvider } from '../../providers/types';
import { ToolRegistry, type ToolContext } from '../../tools';
import { withTimeoutSignal } from '../../providers';
import { nanoid } from 'nanoid';
import { koryLog } from '../../logger';
import type { EventEmitterService } from './EventEmitterService';
import type { WorkerLifecycleService } from './WorkerLifecycleService';
import type { SessionStateService } from './SessionStateService';
import type { GitManager } from '../git-manager';
import type { WorkspaceManager } from '../workspace-manager';
import { AutoCommitService } from '../auto-commit-service';
import type { CriticGateService } from './CriticGateService';
import { formatMessagesForCritic } from '../critic-util';

interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface InternalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: CompletedToolCall[];
}

interface WorkerPipelineResult {
  success: boolean;
  workerTranscript?: string;
  criticFeedback?: string;
}

interface WorkerPipelineConfig {
  isYoloMode: boolean;
  workingDirectory: string;
  getWorkerReasoningLevel: () => string;
  waitForUserInput: (sessionId: string, question: string, options: string[]) => Promise<string>;
  emitThought: (sessionId: string, phase: string, thought: string) => void;
  updateWorkflowState: (sessionId: string, state: string) => void;
  handleAutoCommit: (sessionId: string, taskDescription: string) => Promise<void>;
}

export interface WorkerPipelineServiceDependencies {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  events: EventEmitterService;
  workers: WorkerLifecycleService;
  state: SessionStateService;
  git: GitManager;
  workspaceManager: WorkspaceManager | null;
  autoCommitService: AutoCommitService;
  criticGateService: CriticGateService;
  config: WorkerPipelineConfig;
}

const WORKER_SYSTEM_PROMPT = `You are a specialist Worker Agent. EXECUTE the assigned task using tools. QUALITY FIRST. VERIFY.`;

export class WorkerPipelineService {
  private providers: ProviderRegistry;
  private tools: ToolRegistry;
  private events: EventEmitterService;
  private workers: WorkerLifecycleService;
  private state: SessionStateService;
  private git: GitManager;
  private workspaceManager: WorkspaceManager | null;
  private autoCommitService: AutoCommitService;
  private criticGateService: CriticGateService;
  private config: WorkerPipelineConfig;

  constructor(deps: WorkerPipelineServiceDependencies) {
    this.providers = deps.providers;
    this.tools = deps.tools;
    this.events = deps.events;
    this.workers = deps.workers;
    this.state = deps.state;
    this.git = deps.git;
    this.workspaceManager = deps.workspaceManager;
    this.autoCommitService = deps.autoCommitService;
    this.criticGateService = deps.criticGateService;
    this.config = deps.config;
  }

  /**
   * Run the worker pipeline (confirm if needed, routeToWorker, return summary).
   * Used when the manager explicitly calls delegate_to_worker.
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
  ): Promise<string> {
    // Confirm with user if not in YOLO mode
    if (!this.config.isYoloMode) {
      const selection = await this.config.waitForUserInput(
        sessionId,
        'Ready to proceed with the delegated task?',
        ['Yes, proceed', 'Cancel'],
      );
      if (selection.includes('Cancel')) return 'Cancelled by user.';
    } else {
      this.config.emitThought(sessionId, 'executing', 'YOLO mode: Proceeding with delegated task.');
    }

    this.config.updateWorkflowState(sessionId, 'executing');

    const domainOverride =
      domainHint && ['general', 'ui', 'backend', 'test', 'review'].includes(domainHint)
        ? (domainHint as WorkerDomain)
        : undefined;

    // Attempt to spawn an isolated worktree for this worker task
    const taskId = nanoid(12);
    let workerDir = this.config.workingDirectory;
    let worktreeSpawned = false;

    if (this.workspaceManager) {
      try {
        const worktree = this.workspaceManager.spawn(taskId, task.slice(0, 60));
        if (worktree) {
          workerDir = worktree.path;
          worktreeSpawned = true;
          koryLog.info({ taskId, path: workerDir }, 'Worker running in isolated worktree');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ err: message }, 'Worktree spawn failed — using main directory');
      }
    }

    const result = await this.routeToWorker(
      sessionId,
      task,
      preferredModel,
      reasoningLevel,
      [workerDir],
      domainOverride,
    );

    // Reconcile worktree changes back to main branch
    if (worktreeSpawned && this.workspaceManager) {
      try {
        if (result.success) {
          const reconcileResult = this.workspaceManager.reconcile(taskId);
          if (!reconcileResult.success) {
            koryLog.warn({ taskId, msg: reconcileResult.message }, 'Worktree reconcile failed');
          } else {
            // Create ghost commit for time-travel after successful worker reconciliation
            try {
              const { ShadowLogger } = await import('../shadow-logger');
              const shadowLogger = new ShadowLogger(this.config.workingDirectory);
              await shadowLogger.createGhostCommit(task.slice(0, 72), {
                agentId: sessionId,
                model: preferredModel ?? 'unknown',
                prompt: task.slice(0, 200),
                cost: 0,
              });
            } catch {
              // Shadow logging is non-critical; don't fail the task if it errors
            }

            // Auto-commit for beginner mode after successful worker task
            await this.config.handleAutoCommit(sessionId, task);
          }
        } else {
          this.workspaceManager.cleanup(taskId);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        koryLog.warn({ taskId, err: message }, 'Worktree cleanup/reconcile error');
      }
    } else if (result.success) {
      // Auto-commit for beginner mode even without worktree (direct worker execution)
      await this.config.handleAutoCommit(sessionId, task);
    }

    this.config.updateWorkflowState(sessionId, 'idle');

    if (result.success) {
      return (
        result.criticFeedback ??
        (result.workerTranscript ? 'Worker completed. See transcript.' : 'Done.')
      );
    }
    return result.workerTranscript
      ? `Worker did not pass review. ${result.criticFeedback ?? ''}`
      : 'Worker failed.';
  }

  private async routeToWorker(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
    allowedPaths: string[] = [],
    domainOverride?: WorkerDomain,
  ): Promise<WorkerPipelineResult> {
    // For this stub implementation, just return success
    // The full implementation would include the retry logic
    return { success: false };
  }

  private async executeWithProvider(
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    _isAutoMode: boolean,
    allowedPaths: string[],
    isSandboxed: boolean,
  ): Promise<{ success: boolean; error?: string; workerMessages?: InternalMessage[] }> {
    const workerId = `worker-${nanoid(8)}`;
    const abort = new AbortController();

    const identity = {
      id: workerId,
      name: `${domain} Worker`,
      role: 'coder' as const,
      model: modelId,
      provider: provider.name,
      domain,
      glowColor: DOMAIN.GLOW_COLORS[domain],
    };

    this.events.emit(sessionId, 'agent.spawned', { agent: identity, task: userMessage });

    let tokensIn = 0;
    let tokensOut = 0;
    let usageKnown = false;

    this.emitUsageUpdate(
      sessionId,
      workerId,
      modelId,
      provider.name,
      tokensIn,
      tokensOut,
      usageKnown,
    );

    this.workers.registerWorker(
      workerId,
      identity,
      {
        id: workerId,
        description: userMessage,
        domain,
        assignedModel: modelId,
        assignedProvider: provider.name as ProviderName,
        status: 'active',
      },
      abort,
      sessionId,
    );

    const ctx: ToolContext = {
      sessionId,
      workingDirectory: this.config.workingDirectory,
      signal: abort.signal,
      allowedPaths,
      isSandboxed,
      emitFileEdit: (e) =>
        this.events.emit(sessionId, 'stream.file_delta', { agentId: workerId, ...e }),
      emitFileComplete: (e) =>
        this.events.emit(sessionId, 'stream.file_complete', { agentId: workerId, ...e }),
      recordChange: (c) => this.state.recordChange(sessionId, c),
    };

    const messages: InternalMessage[] = [{ role: 'user', content: userMessage }];
    const resolvedReasoningLevel =
      reasoningLevel === 'auto' ? this.inferReasoningLevel(userMessage) : reasoningLevel;

    try {
      let turnCount = 0;
      while (turnCount < 25) {
        turnCount++;
        const success = await this.processProviderTurn(
          sessionId,
          workerId,
          modelId,
          provider,
          messages,
          ctx,
          resolvedReasoningLevel,
        );
        if (!success) break;
      }
      this.workers.removeWorker(workerId);
      return { success: true, workerMessages: [...messages] };
    } catch (err: unknown) {
      this.workers.removeWorker(workerId);
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private async processProviderTurn(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    reasoningLevel?: string,
  ): Promise<boolean> {
    if (ctx.signal?.aborted) throw new DOMException('Worker turn aborted', 'AbortError');

    // Load agent settings via ConfigManager (efficient cached access)
    const { configManager } = await import('../../runtime/config-manager');
    const settings = configManager.getAgentSettings() ?? (await import('../../agent-settings')).DEFAULT_AGENT_SETTINGS;

    let systemPrompt = WORKER_SYSTEM_PROMPT;

    // Multi-source research instruction
    if (settings.multiSourceResearch) {
      systemPrompt +=
        '\n\n• DEEP RESEARCH: When researching complex topics, do not rely on a single source. Use the web_search tool to find multiple perspectives and fetch/read at least 3-5 different pages to verify information and identify consensus or contradictions.';
    }

    // Filter tools based on local web search setting
    let tools = this.tools.getToolDefsForRole('worker');
    if (settings.localWebSearch === 'off') {
      tools = tools.filter((t) => t.name !== 'web_search');
    }
    // If "fallback", we keep it in the list. The model can choose to use it if its native search fails or is unavailable.

    // Normalize reasoning level for this provider/model
    const normalizedReasoning = this.normalizeReasoningLevel(
      provider.name,
      modelId,
      reasoningLevel,
    );

    const streamSignal = withTimeoutSignal(ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: this.toProviderMessages(messages),
        tools,
        maxTokens: 16384,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
      },
      provider.name,
    );

    let assistantContent = '';
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;

    for await (const event of stream) {
      if (event.type === 'error') {
        throw new Error(event.error ?? 'LLM stream error');
      }
      if (event.type === 'content_delta') {
        assistantContent += event.content;
        this.events.emit(sessionId, 'stream.delta', {
          agentId: workerId,
          content: event.content,
          model: modelId,
        });
      } else if (event.type === 'usage_update') {
        this.updateUsageFromEvent(sessionId, workerId, modelId, provider.name, event);
      } else if (event.type === 'tool_use_start') {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
        this.events.emit(sessionId, 'stream.tool_call', {
          agentId: workerId,
          toolCall: { id: event.toolCallId, name: event.toolName, input: {} },
        });
      } else if (event.type === 'tool_use_delta') {
        const tc = pendingToolCalls.get(event.toolCallId!);
        if (tc) tc.input += event.toolInput ?? '';
      } else if (event.type === 'tool_use_stop') {
        const call = pendingToolCalls.get(event.toolCallId!);
        if (call) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(call.input || '{}');
          } catch {
            /* Expected: malformed tool input JSON, defaults to {} */
          }
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls:
        hasToolCalls && completedToolCalls.length > 0
          ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
          : undefined,
    });

    if (hasToolCalls && completedToolCalls.length > 0) {
      for (const tc of completedToolCalls) {
        const result = await this.executeToolCall(sessionId, workerId, tc, ctx);
        this.events.emit(sessionId, 'stream.tool_result', {
          agentId: workerId,
          toolResult: result,
        });
        messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
      }
      return true; // Continue to next turn
    }

    return false; // Task complete
  }

  private async executeToolCall(
    sessionId: string,
    workerId: string,
    tc: CompletedToolCall,
    ctx: ToolContext,
  ): Promise<{
    callId: string;
    name: string;
    output: unknown;
    isError: boolean;
    durationMs: number;
  }> {
    if (tc.name === 'ask_manager') {
      // This would need to be handled by the manager
      // For now, return a generic response
      return {
        callId: tc.id,
        name: tc.name,
        output: 'Manager is not available in pipeline mode',
        isError: false,
        durationMs: 0,
      };
    }

    const start = Date.now();
    try {
      const result = await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
      return {
        callId: tc.id,
        name: tc.name,
        output: result.output,
        isError: result.isError,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        callId: tc.id,
        name: tc.name,
        output: String(err),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  }

  private updateUsageFromEvent(
    sessionId: string,
    workerId: string,
    modelId: string,
    provider: string,
    event: ProviderEvent,
  ) {
    this.workers.initUsage(workerId);
    if (typeof event.tokensIn === 'number') {
      const usage = this.workers.getUsage(workerId);
      if (usage) {
        usage.tokensIn = Math.max(usage.tokensIn, event.tokensIn);
        if (event.tokensOut !== undefined)
          usage.tokensOut = Math.max(usage.tokensOut, event.tokensOut);
        usage.usageKnown = true;
        this.emitUsageUpdate(
          sessionId,
          workerId,
          modelId,
          provider as ProviderName,
          usage.tokensIn,
          usage.tokensOut,
          usage.usageKnown,
        );
      }
    }
  }

  private emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean,
  ) {
    this.events.emit(sessionId, 'usage.update', {
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      usageKnown,
    });
  }

  private async generateWorkerTask(
    sessionId: string,
    message: string,
    domain: WorkerDomain,
    preferredModel?: string,
  ): Promise<string> {
    const routing = this.resolveActiveRouting(preferredModel, 'general');
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return message;

    let res = '';
    try {
      for await (const event of provider.streamResponse({
        model: routing.model,
        systemPrompt: 'Be brief and actionable.',
        messages: [{ role: 'user', content: `Worker instruction for ${domain}: ${message}` }],
        maxTokens: 200,
      })) {
        if (event.type === 'content_delta') res += event.content;
      }
      return res.trim() || message;
    } catch {
      return message;
    }
  }

  private resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
  ): { model: string; provider: ProviderName | undefined } {
    // Simple implementation - delegate to providers
    const available = this.providers.getAvailable();
    if (available.length === 0) {
      return { model: preferredModel ?? 'claude-sonnet-4-5', provider: undefined };
    }

    const first = available[0]!;
    const models = getModelsForProvider(first.name);
    return {
      model: preferredModel ?? models[0]?.id ?? 'claude-sonnet-4-5',
      provider: first.name as ProviderName,
    };
  }

  private buildFallbackChain(startModelId: string): string[] {
    const chain: string[] = [startModelId];
    const available = this.providers.getAvailable();

    for (const provider of available) {
      const models = getModelsForProvider(provider.name);
      for (const model of models) {
        if (model.id !== startModelId && !model.deprecated) {
          chain.push(model.id);
        }
      }
    }

    return chain.slice(0, 5);
  }

  private classifyDomainLLM(message: string): WorkerDomain {
    const lower = message.toLowerCase();
    const scores: Record<string, number> = {};

    for (const [domain, keywords] of Object.entries(DOMAIN.KEYWORDS)) {
      scores[domain] = (keywords as readonly string[]).filter((k) => lower.includes(k)).length;
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return (best && best[1] > 0 ? best[0] : 'general') as WorkerDomain;
  }

  private requiresSystemAccess(message: string): boolean {
    const lower = message.toLowerCase();
    const systemPatterns = [
      /\b(sudo|apt|apt-get|yum|dnf|pacman|brew)\b/,
      /\b(systemctl|service|journalctl)\b/,
      /\b(chmod|chown)\b.*\/(etc|var|usr|bin|sbin|boot|lib|sys|dev)/,
      /\/etc\//,
      /\/var\/log\//,
    ];
    return systemPatterns.some((p) => p.test(lower));
  }

  private normalizeReasoningLevel(
    providerName: string,
    modelId: string,
    level?: string,
  ): string | undefined {
    // Simplified - just return the level or undefined
    return level;
  }

  private inferReasoningLevel(message: string): string {
    // Simple heuristic
    if (message.length > 1000) return 'high';
    if (message.length > 500) return 'medium';
    return 'low';
  }

  private toProviderMessages(messages: InternalMessage[]): ProviderMessage[] {
    return messages.map((m) => {
      const out: ProviderMessage = { role: m.role, content: m.content };
      if (m.role === 'tool' && m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      if (m.role === 'assistant' && m.tool_calls?.length) out.tool_calls = m.tool_calls;
      return out;
    });
  }
}

export const createWorkerPipelineService = (deps: WorkerPipelineServiceDependencies) =>
  new WorkerPipelineService(deps);
