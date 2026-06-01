// Kory Manager Agent — the orchestrator brain.
// The manager is the only agent the user talks to. Sub-agents (workers) run only when the manager
// explicitly calls the delegate_to_worker tool; the code never auto-spawns workers.

import type {
  AgentIdentity,
  AgentStatus,
  WorkerDomain,
  WSMessage,
  ProviderName,
  KoryphaiosConfig,
  KoryAskUserPayload,
  ChangeSummary,
  StreamUsagePayload,
  StreamThinkingPayload,
} from '@koryphaios/shared';
import { normalizeReasoningLevel, determineAutoReasoningLevel } from '@koryphaios/shared';
import { AGENT, DOMAIN } from '../constants';
import {
  ProviderRegistry,
  resolveModel,
  resolveTrustedContextWindow,
  isLegacyModel,
  getNonLegacyModels,
  withTimeoutSignal,
  type StreamRequest,
  type ProviderEvent,
  type Provider,
} from '../providers';
import type { ProviderMessage } from '../providers/types';
import { ToolRegistry, type ToolCallInput, type ToolContext, type ToolCallOutput } from '../tools';
import { wsBroker } from '../pubsub';
import { koryLog } from '../logger';
import { nanoid } from 'nanoid';
import { sanitizeForPrompt } from '../security';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import { db, sessions } from '../db';
import { eq } from 'drizzle-orm';
import type { ISessionStore } from '../stores/session-store';
import type { IMessageStore } from '../stores/message-store';
import type { ITaskStore } from '../stores/task-store';
import { SnapshotManager } from './snapshot-manager';
import { GitManager } from './git-manager';
import { WorkspaceManager } from './workspace-manager';
import { EventEmitterService, WorkerLifecycleService, SessionStateService } from './services';
import { TimeTravelService } from '../services';
import { RoutingServiceEnhanced } from './services/RoutingServiceEnhanced';
import {
  parseCriticVerdict,
  formatMessagesForCritic as formatMessagesForCriticUtil,
} from './critic-util';
import { AutoCommitService } from './auto-commit-service';
import { getModeManager } from '../mode';
import type { UIMode } from '@koryphaios/shared';

// ─── Internal Types ─────────────────────────────────────────────────────────

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

interface LLMTurnResult {
  success: boolean;
  content?: string;
  usage?: { tokensIn: number; tokensOut: number };
  completedToolCalls?: CompletedToolCall[];
}

export interface AgentThreadEntry {
  id: string;
  role: 'manager' | 'user' | 'assistant';
  content: string;
  createdAt: number;
}

interface AgentThreadState {
  sessionId: string;
  identity: AgentIdentity;
  kind: 'worker' | 'critic';
  status: AgentStatus;
  providerName: ProviderName;
  modelId: string;
  systemPrompt: string;
  toolRole: 'worker' | 'critic';
  reasoningLevel?: string;
  maxTurns: number;
  maxTokens: number;
  messages: InternalMessage[];
  threadEntries: AgentThreadEntry[];
  ctx: ToolContext;
  abort?: AbortController;
  busy: boolean;
  updatedAt: number;
}

// ─── Default Model Assignments per Domain ───────────────────────────────────

for (const [domain, modelId] of Object.entries(DOMAIN.DEFAULT_MODELS)) {
  const def = resolveModel(modelId);
  if (!def) {
    throw new Error(`DOMAIN.DEFAULT_MODELS["${domain}"] references unknown model: "${modelId}".`);
  }
}

// ─── Clarification Gate ─────────────────────────────────────────────────────


// ─── Kory Identity ──────────────────────────────────────────────────────────

let KORY_IDENTITY: AgentIdentity = {
  id: 'kory-manager',
  name: 'Kory',
  role: 'manager',
  model: 'pending',
  provider: 'copilot',
  domain: 'general',
  glowColor: 'rgba(255,215,0,0.6)', // Gold
};

function koryIdentityWithModel(model: string, provider: ProviderName): AgentIdentity {
  KORY_IDENTITY = { ...KORY_IDENTITY, model, provider };
  return KORY_IDENTITY;
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const KORY_SYSTEM_PROMPT = `You are Kory, the manager agent. The user talks to you only. Sub-agents (workers) run only when you explicitly call delegate_to_worker—never automatically.

• Handle requests yourself: answer questions, use tools (read_file, grep, bash, web_search, etc.), do small edits. For conversation, clarification, or straightforward work, you are the sole agent.
• You may run terminals in the background: use the bash tool with isBackground: true (and optional processName) to start long-lived processes (e.g. dev servers). Use shell_manage to list stored background processes, view their logs, or kill them. Only you can manage these background terminals.
• Sub-agents (workers: general, ui, backend, test, review) exist only for you to invoke when you decide a task needs a specialist coder. Call delegate_to_worker only for substantial implementation, refactoring, or multi-step coding—not for chat, simple questions, or minor edits.
• When you delegate, the worker reports back; you verify and synthesize.
• IMPORTANT: If you decide to delegate, call delegate_to_worker IMMEDIATELY without generating any explanatory text first. Do not write "I'll delegate this" or similar—just call the tool directly.`;
const WORKER_SYSTEM_PROMPT = `You are a specialist Worker Agent. EXECUTE the assigned task using tools. QUALITY FIRST. VERIFY.`;
const CRITIC_SYSTEM_PROMPT = `You are an independent, fresh Critic AI model evaluating the work of a DIFFERENT agent (the Worker). You must evaluate their work objectively. You may only use read_file, grep, glob, and ls to inspect the codebase. Review the Worker's output and output either PASS or FAIL. If FAIL, give brief, actionable feedback. Your final message must end with a line that starts with exactly PASS or exactly FAIL (e.g. "PASS" or "FAIL: missing tests").`;

// ─── Kory Manager Class ─────────────────────────────────────────────────────

export interface KoryTask {
  id: string;
  description: string;
  domain: WorkerDomain;
  assignedModel: string;
  assignedProvider: ProviderName;
  status: 'pending' | 'active' | 'done' | 'failed';
  result?: string;
  error?: string;
}

export class KoryManager {
  private memoryDir: string;
  private isProcessing = false;
  private isYoloMode = false;
  private snapshotManager: SnapshotManager;
  public readonly git: GitManager;
  private workspaceManager: WorkspaceManager | null = null;
  private autoCommitService: AutoCommitService;
  /** AbortController for the current manager run per session (so cancelSessionWorkers can abort manager too). */
  private managerAbortBySession = new Map<string, AbortController>();
  /** In-memory worker/critic chat threads keyed by agentId. */
  private agentThreads = new Map<string, AgentThreadState>();
  /** Services */
  private events: EventEmitterService;
  private routing: RoutingServiceEnhanced;
  private workers: WorkerLifecycleService;
  private state: SessionStateService;

  constructor(
    private providers: ProviderRegistry,
    private tools: ToolRegistry,
    private workingDirectory: string,
    private config: KoryphaiosConfig,
    private sessions?: ISessionStore,
    private messages?: IMessageStore,
    private tasks?: ITaskStore,
    private timeTravel?: TimeTravelService,
  ) {
    this.memoryDir = join(workingDirectory, '.koryphaios/memory');
    mkdirSync(this.memoryDir, { recursive: true });
    this.snapshotManager = new SnapshotManager(workingDirectory);
    this.git = new GitManager(workingDirectory);
    this.autoCommitService = new AutoCommitService(workingDirectory, this.git);

    // Initialize WorkspaceManager if git is available
    try {
      if (this.git.isGitRepo()) {
        this.workspaceManager = new WorkspaceManager(workingDirectory, config.workspace);
        koryLog.info('WorkspaceManager initialized for parallel agent isolation');
      }
    } catch {
      koryLog.warn('WorkspaceManager unavailable — workers will share the main directory');
    }

    // Initialize services
    this.events = new EventEmitterService({ managerAgentId: KORY_IDENTITY.id });
    this.routing = new RoutingServiceEnhanced({ config: this.config });
    this.workers = new WorkerLifecycleService({ events: this.events });
    this.state = new SessionStateService();

    // Recover state from persistent stores
    this.recoverState();
  }

  private async recoverState() {
    if (!this.tasks) return;
    try {
      const activeTasks = await this.tasks.listActive();
      if (activeTasks.length > 0) {
        koryLog.info({ count: activeTasks.length }, 'Recovered active tasks from store');
        // Note: We can't easily resume the LLM turns, but we mark them as failed
        // if they were active, so the user knows they were interrupted.
        for (const task of activeTasks) {
          if (task.status === 'active') {
            await this.tasks.update(task.id, {
              status: 'failed',
              error: 'Process interrupted (server restart)',
            });
          }
        }
      }
    } catch (err) {
      koryLog.warn({ err }, 'Failed to recover tasks from store');
    }
  }

  setYoloMode(enabled: boolean) {
    this.isYoloMode = enabled;
    koryLog.info({ enabled }, 'YOLO mode state updated');
  }

  /** Reasoning level the manager uses for delegated workers (from config). */
  private getWorkerReasoningLevel(): string {
    return (
      (this.config.agents?.manager as { reasoningLevel?: string } | undefined)?.reasoningLevel ??
      AGENT.DEFAULT_REASONING_LEVEL
    );
  }

  private async extractAllowedPaths(
    sessionId: string,
    plan: string,
    preferredModel?: string,
  ): Promise<string[]> {
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return [];

    const prompt = `Identify paths to modify or read. PLAN: ${plan}. Return ONLY JSON array.`;
    let result = '';
    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: 'JSON only.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
      });
      for await (const event of stream)
        if (event.type === 'content_delta') result += event.content ?? '';
      return JSON.parse(result.trim().match(/\[.*\]/s)?.[0] || '[]');
    } catch {
      return [];
    }
  }

  private async updateWorkflowState(sessionId: string, state: string) {
    await db.update(sessions).set({ workflowState: state }).where(eq(sessions.id, sessionId));
  }

  handleUserInput(sessionId: string, selection: string, text?: string) {
    this.state.resolveUserInput(sessionId, text || selection);
  }

  async handleSessionResponse(sessionId: string, accepted: boolean) {
    if (accepted) {
      this.emitThought(sessionId, 'synthesizing', 'User accepted changes.');
    } else {
      this.emitThought(sessionId, 'synthesizing', 'User rejected changes. Rolling back...');
      const prevHash = this.state.getCheckpoint(sessionId);
      if (prevHash && this.git.isGitRepo()) {
        this.git.rollback(prevHash);
      } else {
        await this.snapshotManager.restoreSnapshot(sessionId, 'latest', this.workingDirectory);
      }
    }
    this.state.clearCheckpoint(sessionId);
    this.state.clearChanges(sessionId);
  }

  private async handleManagerInquiry(
    sessionId: string,
    agentId: string,
    question: string,
    preferredModel?: string,
  ): Promise<string> {
    this.emitThought(sessionId, 'analyzing', `Worker help: "${question}"`);
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return 'Error.';

    let decision = 'ANSWER';
    try {
      const stream = provider.streamResponse({
        model: routing.model,
        systemPrompt: 'You are helping route an inquiry. You must call exactly one tool to indicate your choice.',
        messages: [{ role: 'user', content: question }],
        tools: [{
          name: 'route_inquiry',
          description: 'Route the inquiry',
          inputSchema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['WEB_SEARCH', 'ANSWER'] } },
            required: ['decision']
          }
        }],
        maxTokens: 50,
      });

      for await (const event of stream) {
        if (event.type === 'tool_use_stop' && event.toolName === 'route_inquiry') {
           try {
             const args = JSON.parse(event.toolInput || '{}');
             if (args.decision) decision = args.decision;
           } catch { /* default to ANSWER */ }
        }
      }
    } catch (err) {
      koryLog.warn({ err }, 'Manager inquiry routing failed, defaulting to ANSWER');
    }

    if (decision === 'WEB_SEARCH') {
      const toolCtx: ToolContext = { sessionId, workingDirectory: this.workingDirectory };
      const searchResult = await this.tools.execute(toolCtx, {
        id: nanoid(10),
        name: 'web_search',
        input: { query: question },
      });
      return `MANAGER ADVICE: ${searchResult.output}`;
    }
    return `MANAGER ANSWER: I recommend proceeding with the current task.`;
  }

  private async waitForUserInputInternal(
    sessionId: string,
    question: string,
    options: string[],
  ): Promise<string> {
    this.emitWSMessage(sessionId, 'kory.ask_user', {
      question,
      options,
      allowOther: true,
    } satisfies KoryAskUserPayload);
    return this.state.requestUserInput(sessionId);
  }

  /** Main entry point for processing a task. */
  async processTask(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
  ): Promise<void> {
    this.isProcessing = true;
    this.state.clearChanges(sessionId);
    userMessage = sanitizeForPrompt(userMessage);

    // Resolve provider before any UI updates or work. No provider = manager responds once and returns.
    let routing = this.resolveActiveRouting(preferredModel, 'general', true);
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider && (!preferredModel || preferredModel === 'auto')) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
    if (!provider) {
      await this.updateWorkflowState(sessionId, 'idle');
      this.emitError(sessionId, this.getModelConfigurationError(preferredModel));
      this.isProcessing = false;
      return;
    }

    koryLog.debug(
      { sessionId, routing, providerName: provider.name },
      'Resolved provider for task',
    );

    await this.updateWorkflowState(sessionId, 'analyzing');
    try {
      koryLog.debug({ sessionId }, 'Calling handleDirectly');
      this.emitThought(sessionId, 'analyzing', `Analyzing request...`);
      await this.handleDirectly(sessionId, userMessage, reasoningLevel, preferredModel);
      koryLog.debug({ sessionId }, 'handleDirectly completed');

      await this.updateWorkflowState(sessionId, 'idle');
      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) this.emitWSMessage(sessionId, 'session.changes', { changes });
    } catch (err) {
      koryLog.error({ sessionId, err }, 'Error in processTask');
      await this.updateWorkflowState(sessionId, 'error');
      this.emitError(sessionId, `Error: ${String(err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private buildFallbackChain(startModelId: string): string[] {
    return this.routing.buildFallbackChain(startModelId);
  }

  private resolveActiveRouting(
    preferredModel?: string,
    domain: WorkerDomain = 'general',
    avoidLegacy = false,
  ): { model: string; provider: ProviderName | undefined } {
    return this.routing.resolveActiveRouting(preferredModel, domain, avoidLegacy);
  }

  private formatProviderName(provider: string): string {
    if (provider === 'openai') return 'OpenAI';
    if (provider === 'codex') return 'Codex';
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'google') return 'Google';
    if (provider === 'xai') return 'xAI';
    if (provider === 'openrouter') return 'OpenRouter';
    if (provider === 'vertexai') return 'Vertex AI';
    if (provider === 'copilot') return 'Copilot';
    if (provider === 'kimicode') return 'Kimi Code';
    if (provider === 'moonshot') return 'Moonshot AI / Kimi API';
    return provider.charAt(0).toUpperCase() + provider.slice(1);
  }

  private getModelConfigurationError(preferredModel?: string): string {
    const statuses = this.providers.getStatus();
    const authenticated = statuses.filter((provider) => provider.authenticated);

    if (authenticated.length === 0) {
      return 'No model provider is configured. Open Settings and connect a provider before chatting.';
    }

    if (preferredModel && preferredModel !== 'auto' && preferredModel.includes(':')) {
      const [providerName, modelId] = preferredModel.split(':');
      if (providerName && modelId) {
        const selectedProvider = authenticated.find((provider) => provider.name === providerName);
        if (!selectedProvider) {
          return `${this.formatProviderName(providerName)} is not configured. Open Settings and connect it, or switch back to Auto.`;
        }
        if (!selectedProvider.models.includes(modelId)) {
          return `${modelId} is not enabled for ${this.formatProviderName(providerName)}. Open Settings -> Manage Models and enable it, or switch back to Auto.`;
        }
      }
    }

    const enabledModelCount = authenticated.reduce(
      (count, provider) => count + provider.models.length,
      0,
    );
    if (enabledModelCount === 0) {
      return 'No models are enabled for your configured providers. Open Settings -> Manage Models and enable at least one model.';
    }

    return 'No usable model is configured. Open Settings and connect a provider or enable at least one model.';
  }

  /**
   * Run the worker pipeline (confirm if needed, routeToWorker, return summary).
   * Used when the manager explicitly calls delegate_to_worker. Only the manager LLM decides to spawn a worker.
   */
  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string,
  ): Promise<string> {
    if (!this.isYoloMode) {
      const selection = await this.waitForUserInputInternal(
        sessionId,
        'Ready to proceed with the delegated task?',
        ['Yes, proceed', 'Cancel'],
      );
      if (selection.includes('Cancel')) return 'Cancelled by user.';
    } else {
      this.emitThought(sessionId, 'executing', 'YOLO mode: Proceeding with delegated task.');
    }
    await this.updateWorkflowState(sessionId, 'executing');
    const domainOverride =
      domainHint && ['general', 'ui', 'backend', 'test', 'review'].includes(domainHint)
        ? (domainHint as WorkerDomain)
        : undefined;

    // Attempt to spawn an isolated worktree for this worker task
    const taskId = nanoid(12);

    // Create task in persistent store
    const routing = this.resolveActiveRouting(preferredModel, domainOverride || 'general');
    if (this.tasks) {
      await this.tasks.create({
        id: taskId,
        sessionId,
        description: task,
        domain: domainOverride || 'general',
        assignedModel: routing.model,
        assignedProvider: routing.provider || 'copilot',
      });
    }

    let workerDir = this.workingDirectory;
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

    let result = await this.routeToWorker(
      sessionId,
      task,
      preferredModel,
      reasoningLevel,
      [workerDir],
      domainOverride,
      taskId,
    );

    // Reconcile worktree changes back to main branch
    if (worktreeSpawned && this.workspaceManager) {
      try {
        if (result.success) {
          const reconcileResult = this.workspaceManager.reconcile(taskId);
          if (!reconcileResult.success) {
            koryLog.warn({ taskId, msg: reconcileResult.message }, 'Worktree reconcile failed');
            result = {
              success: false,
              workerTranscript: result.workerTranscript,
              criticFeedback: `Worktree reconcile failed: ${reconcileResult.message}`,
            };
          } else {
            // Create ghost commit for time-travel after successful worker reconciliation
            try {
              const { ShadowLogger } = await import('./shadow-logger');
              const shadowLogger = new ShadowLogger(this.workingDirectory);
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
            await this.handleAutoCommit(sessionId, task);
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
      await this.handleAutoCommit(sessionId, task);
    }

    // Update task in persistent store after reconcile, so persisted state matches user-visible result.
    if (this.tasks) {
      await this.tasks.update(taskId, {
        status: result.success ? 'done' : 'failed',
        result: result.success ? result.criticFeedback || 'Done' : undefined,
        error: !result.success ? result.criticFeedback || 'Worker failed' : undefined,
      });
    }

    await this.updateWorkflowState(sessionId, 'idle');
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
    taskId?: string,
  ): Promise<{ success: boolean; workerTranscript?: string; criticFeedback?: string }> {
    let domain: WorkerDomain;
    if (domainOverride) domain = domainOverride;
    else
      try {
        domain = this.classifyDomainLLM(userMessage);
      } catch {
        domain = 'general';
      }
    const isSandboxed = this.isYoloMode ? false : !this.requiresSystemAccess(userMessage);
    const effectivePaths = allowedPaths.length > 0 ? allowedPaths : [this.workingDirectory];

    if (this.git.isGitRepo()) {
      const hash = await this.git.getCurrentHash();
      if (hash) this.state.saveCheckpoint(sessionId, hash);
    } else {
      await this.snapshotManager.createSnapshot(
        sessionId,
        'latest',
        effectivePaths,
        this.workingDirectory,
      );
    }

    let workerTask = await this.generateWorkerTask(sessionId, userMessage, domain, preferredModel);

    // Mark task as active in store
    if (taskId && this.tasks) {
      await this.tasks.update(taskId, { status: 'active' });
    }

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      this.emitThought(sessionId, 'delegating', `Delegating to ${domain} worker...`);
      const routing = this.resolveActiveRouting(preferredModel, domain);
      const provider = this.providers.getAvailable().find((p) => p.name === routing.provider);
      if (!provider) {
        const alt = this.providers.getAvailable()[0];
        if (!alt) return { success: false };
        const res = await this.executeWithProvider(
          sessionId,
          alt,
          routing.model,
          workerTask,
          domain,
          reasoningLevel,
          true,
          effectivePaths,
          isSandboxed,
        );
        if (res.success) {
          const criticResult = await this.runCriticGate(
            sessionId,
            res.workerMessages,
            preferredModel,
          );
          if (criticResult.passed)
            return {
              success: true,
              workerTranscript: formatMessagesForCriticUtil(res.workerMessages ?? []),
              criticFeedback: criticResult.feedback,
            };
          workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
        } else return { success: false };
        continue;
      }

      const result = await this.executeWithProvider(
        sessionId,
        provider,
        routing.model,
        workerTask,
        domain,
        reasoningLevel,
        true,
        effectivePaths,
        isSandboxed,
      );
      if (result.success) {
        const criticResult = await this.runCriticGate(
          sessionId,
          result.workerMessages,
          preferredModel,
        );
        if (criticResult.passed)
          return {
            success: true,
            workerTranscript: formatMessagesForCriticUtil(result.workerMessages ?? []),
            criticFeedback: criticResult.feedback,
          };
        workerTask = `QUALITY FAILURE. Fix these:\n${criticResult.feedback}`;
      }
      if (!this.providers.isQuotaError(result.error)) return { success: false };
    }
    return { success: false };
  }

  /** Critic can only read files and grep. It sees the full worker transcript (truncated) and outputs PASS or FAIL with feedback. */
  private async runCriticGate(
    sessionId: string,
    workerMessages: InternalMessage[] | undefined,
    preferredModel?: string,
  ): Promise<{ passed: boolean; feedback?: string }> {
    const hardCheckResult = await this.runHardChecks(sessionId);
    if (!hardCheckResult.passed) return { passed: false, feedback: hardCheckResult.output };

    const routing = this.resolveActiveRouting(preferredModel, 'critic');
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return { passed: true };

    const transcriptText = formatMessagesForCriticUtil(workerMessages ?? [], 12_000);
    const criticPrompt = `Worker transcript to review:\n\n${transcriptText}\n\nUse read_file/grep/glob/ls as needed. Then output PASS or FAIL and brief feedback.`;
    const criticId = `critic-${nanoid(8)}`;
    const identity: AgentIdentity = {
      id: criticId,
      name: 'Critic',
      role: 'critic',
      model: routing.model,
      provider: provider.name,
      domain: 'critic',
      glowColor: DOMAIN.GLOW_COLORS.critic,
    };
    this.emitWSMessage(sessionId, 'agent.spawned', { agent: identity, task: 'Review delegated work' });
    const criticAbort = new AbortController();
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: this.workingDirectory,
      allowedPaths: [this.workingDirectory],
      isSandboxed: true,
      signal: criticAbort.signal,
    };

    const thread: AgentThreadState = {
      sessionId,
      identity,
      kind: 'critic',
      status: 'thinking',
      providerName: provider.name,
      modelId: routing.model,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      toolRole: 'critic',
      maxTurns: 5,
      maxTokens: 2048,
      messages: [{ role: 'user', content: criticPrompt }],
      threadEntries: [],
      ctx: criticCtx,
      abort: criticAbort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(criticId, thread);
    this.appendAgentThreadEntry(thread, 'manager', criticPrompt);

    try {
      await this.runAgentThread(criticId, provider);
    } catch {
      return { passed: false, feedback: 'Critic failed to run.' };
    }

    const lastContent =
      [...thread.threadEntries].reverse().find((entry) => entry.role === 'assistant')?.content ?? '';
    const passed = parseCriticVerdict(lastContent);
    return { passed, feedback: lastContent.trim() };
  }

  private async runHardChecks(sessionId: string): Promise<{ passed: boolean; output: string }> {
    const pkgPath = join(this.workingDirectory, 'package.json');
    if (!existsSync(pkgPath)) return { passed: true, output: '' };
    const bash = this.tools.get('bash')!;
    const result = await bash.run(
      { sessionId, workingDirectory: this.workingDirectory, isSandboxed: true },
      { id: nanoid(), name: 'bash', input: { command: 'bun test', timeout: 60 } },
    );
    return { passed: !result.isError, output: result.output };
  }

  private requiresSystemAccess(m: string): boolean {
    const lower = m.toLowerCase();
    const systemPatterns = [
      /\b(sudo|apt|apt-get|yum|dnf|pacman|brew)\b/,
      /\b(systemctl|service|journalctl)\b/,
      /\b(chmod|chown)\b.*\/(etc|var|usr|bin|sbin|boot|lib|sys|dev)/,
      /\/etc\//,
      /\/var\/log\//,
    ];
    return systemPatterns.some((p) => p.test(lower));
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

  /** Manager handles simple tasks directly with full tool access (unsandboxed). Asks user before first tool run unless YOLO. Manager never uses legacy models. */
  private async handleDirectly(
    sessionId: string,
    userMessage: string,
    reasoningLevel?: string,
    preferredModel?: string,
  ): Promise<void> {
    koryLog.debug({ sessionId, reasoningLevel, preferredModel }, 'Entering handleDirectly');
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) throw new Error('No provider.');
    const providerName = provider.name as ProviderName;
    koryLog.debug({ routing, providerName }, 'Resolved routing and provider');

    const abort = new AbortController();
    this.managerAbortBySession.set(sessionId, abort);

    try {
      this.emitWSMessage(sessionId, 'agent.status', {
        agentId: KORY_IDENTITY.id,
        status: 'thinking',
      });
      let tokensIn = 0;
      let tokensOut = 0;
      let usageKnown = false;
      this.emitUsageUpdate(
        sessionId,
        KORY_IDENTITY.id,
        routing.model,
        providerName,
        tokensIn,
        tokensOut,
        usageKnown,
      );

      const managerCtx: ToolContext = {
        sessionId,
        workingDirectory: this.workingDirectory,
        allowedPaths: [],
        isSandboxed: false,
        signal: abort.signal,
        waitForUserInput: (question: string, options: string[]) =>
          this.waitForUserInputInternal(sessionId, question, options),
        emitFileEdit: (e) =>
          this.emitWSMessage(sessionId, 'stream.file_delta', { agentId: KORY_IDENTITY.id, ...e }),
        emitFileComplete: (e) =>
          this.emitWSMessage(sessionId, 'stream.file_complete', {
            agentId: KORY_IDENTITY.id,
            ...e,
          }),
        recordChange: (c) => {
          this.state.recordChange(sessionId, c);
        },
        delegateToWorker: (task: string, domainHint?: string) =>
          this.runWorkerPipeline(
            sessionId,
            task,
            preferredModel,
            this.getWorkerReasoningLevel(),
            domainHint,
          ),
      };

      const history = await this.loadHistory(sessionId);
      koryLog.debug({ historyCount: history.length }, 'Loaded history');
      const messages: InternalMessage[] = [...history, { role: 'user', content: userMessage }];
      let turnCount = 0;
      let firstAskForDirectTools = true;
      let stoppedByUser = false;

      while (turnCount < 25) {
        if (abort.signal.aborted) {
          stoppedByUser = true;
          break;
        }
        turnCount++;
        koryLog.debug({ turnCount }, 'Starting manager turn');
        let result: LLMTurnResult;
        try {
          result = await this.processManagerTurn(
            sessionId,
            routing.model,
            provider,
            messages,
            managerCtx,
            abort.signal,
          );
          koryLog.debug(
            {
              resultSuccess: result.success,
              hasContent: !!result.content,
              toolCallCount: result.completedToolCalls?.length,
            },
            'Turn completed',
          );
        } catch (err: unknown) {
          koryLog.error({ err }, 'Error in processManagerTurn');
          if (err instanceof DOMException && err.name === 'AbortError') {
            stoppedByUser = true;
            break;
          }
          throw err;
        }
        if (typeof result.usage?.tokensIn === 'number')
          tokensIn = Math.max(tokensIn, result.usage.tokensIn);
        if (typeof result.usage?.tokensOut === 'number')
          tokensOut = Math.max(tokensOut, result.usage.tokensOut);

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (!completedToolCalls || completedToolCalls.length === 0) break;

        if (completedToolCalls && completedToolCalls.length > 0) {
          if (!this.isYoloMode && firstAskForDirectTools) {
            const selection = await this.waitForUserInputInternal(
              sessionId,
              'Manager will run tools to complete this task. Proceed?',
              ['Yes, proceed', 'Cancel'],
            );
            firstAskForDirectTools = false;
            if (selection.includes('Cancel')) {
              if (this.messages)
                await this.messages.add(sessionId, {
                  id: nanoid(12),
                  sessionId,
                  role: 'assistant',
                  content: '[Cancelled by user.]',
                  model: routing.model,
                  provider: providerName,
                  createdAt: Date.now(),
                });
              break;
            }
          }
          for (const tc of completedToolCalls) {
            if (abort.signal.aborted) {
              stoppedByUser = true;
              break;
            }
            const toolResult = await this.executeManagerToolCall(sessionId, tc, managerCtx);
            this.emitWSMessage(sessionId, 'stream.tool_result', {
              agentId: KORY_IDENTITY.id,
              toolResult,
            });
            messages.push({
              role: 'tool',
              content: JSON.stringify(toolResult),
              tool_call_id: tc.id,
            });
          }
        }
      }

      const assistants = messages.filter((m) => m.role === 'assistant');
      koryLog.debug(
        { assistantCount: assistants.length },
        'Filtering assistant messages for persistence',
      );
      const lastAssistant = assistants.pop();
      const content = (lastAssistant?.content ?? '').trim();
      const toPersist = stoppedByUser
        ? '[Stopped by user.]'
        : content || '[Task completed using tools.]';
      koryLog.debug({ toPersist, sessionId }, 'Attempting to persist assistant message');
      let finalMessageId: string | undefined;
      if (this.messages) {
        finalMessageId = nanoid(12);
        await this.messages.add(sessionId, {
          id: finalMessageId,
          sessionId,
          role: 'assistant',
          content: toPersist,
          model: routing.model,
          provider: providerName,
          createdAt: Date.now(),
        });
        koryLog.debug('Assistant message persisted');
      }
      this.emitWSMessage(sessionId, 'agent.status', { agentId: KORY_IDENTITY.id, status: 'done' });

      // Create rewind point after final response
      if (finalMessageId) {
        await this.createRewindCheckpoint(
          sessionId,
          routing.model,
          userMessage,
          finalMessageId,
          tokensIn,
          tokensOut,
        );
      }

      const changes = this.state.getChanges(sessionId);
      if (changes.length > 0) {
        this.emitWSMessage(sessionId, 'session.changes', { changes });

        // Create ghost commit for time-travel after direct manager tool use
        try {
          const { ShadowLogger } = await import('./shadow-logger');
          const shadowLogger = new ShadowLogger(this.workingDirectory);
          await shadowLogger.createGhostCommit(userMessage.slice(0, 72), {
            agentId: sessionId,
            model: routing.model,
            prompt: userMessage.slice(0, 200),
            tokensIn,
            tokensOut,
            cost: 0,
          });
        } catch {
          // Shadow logging is non-critical; don't fail the task if it errors
        }

        // Auto-commit for beginner mode
        await this.handleAutoCommit(sessionId, userMessage);
      }
    } finally {
      this.managerAbortBySession.delete(sessionId);
      await this.updateWorkflowState(sessionId, 'idle');
    }
  }

  private async createRewindCheckpoint(
    sessionId: string,
    model: string,
    prompt: string,
    messageId: string,
    tokensIn = 0,
    tokensOut = 0,
  ) {
    if (!this.timeTravel) return;
    try {
      await this.timeTravel.checkpoint(prompt.slice(0, 72), {
        agentId: sessionId,
        model,
        prompt: prompt.slice(0, 200),
        tokensIn,
        tokensOut,
        cost: 0,
        messageId,
        checkpointType: 'turn_end',
      });
    } catch (err) {
      koryLog.warn({ err, sessionId }, 'Failed to create rewind checkpoint');
    }
  }

  /**
   * Handle auto-commit for beginner mode
   * Creates a branch, commits changes, and opens a PR
   */
  private async handleAutoCommit(sessionId: string, taskDescription: string): Promise<void> {
    try {
      const modeManager = getModeManager();
      const mode = modeManager.getMode();

      // Only auto-commit in beginner mode when enabled
      if (mode !== 'beginner' || !modeManager.shouldAutoCommit()) {
        return;
      }

      // Check if we have a git repo
      if (!this.git.isGitRepo()) {
        return;
      }

      koryLog.info({ sessionId }, 'Auto-committing changes for beginner mode');

      const result = await this.autoCommitService.autoCommitAndCreatePR(taskDescription);

      if (result.success) {
        // Emit a friendly message to the user
        const message = result.prUrl
          ? `✨ I've saved your work and created a pull request for review: ${result.prUrl}`
          : `✨ I've saved your work to branch "${result.branch}". You can merge it when you're ready!`;

        this.emitWSMessage(sessionId, 'system.notification', {
          type: 'success',
          title: 'Changes Saved',
          message,
          metadata: {
            branch: result.branch,
            commitHash: result.commitHash,
            prUrl: result.prUrl,
          },
        });

        koryLog.info(
          {
            sessionId,
            branch: result.branch,
            prUrl: result.prUrl,
          },
          'Auto-commit completed successfully',
        );
      } else {
        // Log the error but don't fail the task
        koryLog.warn(
          {
            sessionId,
            error: result.message,
          },
          'Auto-commit failed',
        );

        // Notify user that changes were made but not committed
        this.emitWSMessage(sessionId, 'system.notification', {
          type: 'warning',
          title: 'Changes Made',
          message:
            "Your changes are ready! I wasn't able to create a backup branch automatically, but your files have been updated.",
        });
      }
    } catch (error) {
      // Auto-commit should never fail the main task
      koryLog.error(
        {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Auto-commit error',
      );
    }
  }

  private async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    signal?: AbortSignal,
  ): Promise<LLMTurnResult> {
    if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');

    // Load agent settings to apply experimental overrides
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(this.workingDirectory);

    let systemPrompt = KORY_SYSTEM_PROMPT;

    // Multi-source research instruction
    if (settings.multiSourceResearch) {
      systemPrompt +=
        '\n\n• DEEP RESEARCH: When researching complex topics, do not rely on a single source. Use the web_search tool to find multiple perspectives and fetch/read at least 3-5 different pages to verify information and identify consensus or contradictions.';
    }

    // Filter tools based on local web search setting
    let tools = this.tools.getToolDefsForRole('manager');
    if (settings.localWebSearch === 'off') {
      tools = tools.filter((t) => t.name !== 'web_search');
    }
    // If "fallback", we keep it in the list. The model can choose to use it if its native search fails or is unavailable.

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: this.toProviderMessages(messages),
        tools,
        maxTokens: 16384,
        signal: streamSignal,
      },
      provider.name,
    );

    let assistantContent = '';
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;
    let tokensIn = 0;
    let tokensOut = 0;
    // Buffer content to avoid streaming if the turn only delegates to worker
    let contentBuffer = '';

    for await (const event of stream) {
      if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');
      if (event.type === 'error') {
        throw new Error(event.error ?? 'LLM stream error');
      }
      if (event.type === 'content_delta') {
        assistantContent += event.content ?? '';
        contentBuffer += event.content ?? '';
      } else if (event.type === 'thinking_delta') {
        if (event.thinking) {
          this.emitWSMessage(sessionId, 'stream.thinking', {
            agentId: KORY_IDENTITY.id,
            thinking: event.thinking,
          } satisfies StreamThinkingPayload);
        }
      } else if (event.type === 'usage_update') {
        if (typeof event.tokensIn === 'number') tokensIn = Math.max(tokensIn, event.tokensIn);
        if (typeof event.tokensOut === 'number') tokensOut = Math.max(tokensOut, event.tokensOut);
        this.emitUsageUpdate(
          sessionId,
          KORY_IDENTITY.id,
          modelId,
          provider.name,
          tokensIn,
          tokensOut,
          true,
        );
      } else if (event.type === 'tool_use_start') {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
        this.emitWSMessage(sessionId, 'stream.tool_call', {
          agentId: KORY_IDENTITY.id,
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

    // Only emit content if this turn doesn't solely delegate to a worker
    const isDelegationOnly =
      hasToolCalls &&
      completedToolCalls.length === 1 &&
      completedToolCalls[0]!.name === 'delegate_to_worker';
    if (!isDelegationOnly && contentBuffer) {
      this.emitWSMessage(sessionId, 'stream.delta', {
        agentId: KORY_IDENTITY.id,
        content: contentBuffer,
        model: modelId,
      });
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
      return {
        success: true,
        content: assistantContent,
        usage: { tokensIn, tokensOut },
        completedToolCalls,
      };
    }
    return {
      success: assistantContent.length > 0,
      content: assistantContent,
      usage: { tokensIn, tokensOut },
    };
  }

  private async executeManagerToolCall(
    sessionId: string,
    tc: CompletedToolCall,
    ctx: ToolContext,
  ): Promise<ToolCallOutput> {
    if (tc.name === 'ask_user') {
      const question = (tc.input?.question as string) ?? 'Proceed?';
      const options = (tc.input?.options as string[]) ?? ['Yes', 'No'];
      const selection = await this.waitForUserInputInternal(sessionId, question, options);
      return {
        callId: tc.id,
        name: tc.name,
        output: `User selected: ${selection}`,
        isError: false,
        durationMs: 0,
      };
    }
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }

  /**
   * Runs a worker (sub-agent). Only called from routeToWorker, which is only called from
   * runWorkerPipeline, which is invoked solely when the manager calls the delegate_to_worker tool.
   * The code never auto-spawns workers.
   */
  private async executeWithProvider(
    sessionId: string,
    provider: Provider,
    modelId: string,
    userMessage: string,
    domain: WorkerDomain,
    reasoningLevel: string | undefined,
    isAutoMode: boolean,
    allowedPaths: string[],
    isSandboxed: boolean,
  ): Promise<{ success: boolean; error?: string; workerMessages?: InternalMessage[] }> {
    const workerId = `worker-${nanoid(8)}`;
    const abort = new AbortController();
    const workerWorkingDirectory = allowedPaths[0] ?? this.workingDirectory;
    const identity: AgentIdentity = {
      id: workerId,
      name: `${domain} Worker`,
      role: 'coder',
      model: modelId,
      provider: provider.name,
      domain,
      glowColor: DOMAIN.GLOW_COLORS[domain],
    };
    this.emitWSMessage(sessionId, 'agent.spawned', { agent: identity, task: userMessage });
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
        assignedProvider: provider.name,
        status: 'active',
      },
      abort,
      sessionId,
    );

    const ctx: ToolContext = {
      sessionId,
      workingDirectory: workerWorkingDirectory,
      signal: abort.signal,
      allowedPaths,
      isSandboxed,
      emitFileEdit: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_delta', { agentId: workerId, ...e }),
      emitFileComplete: (e) =>
        this.emitWSMessage(sessionId, 'stream.file_complete', { agentId: workerId, ...e }),
      recordChange: (c) => this.state.recordChange(sessionId, c),
    };
    const history = await this.loadHistory(sessionId);
    const messages: InternalMessage[] = [...history, { role: 'user', content: userMessage }];
    const resolvedReasoningLevel =
      reasoningLevel === 'auto' ? determineAutoReasoningLevel(userMessage) : reasoningLevel;
    const thread: AgentThreadState = {
      sessionId,
      identity,
      kind: 'worker',
      status: 'thinking',
      providerName: provider.name,
      modelId,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      toolRole: 'worker',
      reasoningLevel: resolvedReasoningLevel,
      maxTurns: 25,
      maxTokens: 16384,
      messages,
      threadEntries: [],
      ctx,
      abort,
      busy: false,
      updatedAt: Date.now(),
    };
    this.agentThreads.set(workerId, thread);
    this.appendAgentThreadEntry(thread, 'manager', userMessage);

    try {
      await this.runAgentThread(workerId, provider);
      return { success: true, workerMessages: [...thread.messages] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
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

  private async executeToolCall(
    sessionId: string,
    workerId: string,
    tc: CompletedToolCall,
    ctx: ToolContext,
  ): Promise<ToolCallOutput> {
    if (tc.name === 'ask_manager') {
      const ans = await this.handleManagerInquiry(
        sessionId,
        workerId,
        String(tc.input.question ?? ''),
      );
      return { callId: tc.id, name: tc.name, output: ans, isError: false, durationMs: 0 };
    }
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }
  cancelWorker(agentId: string) {
    const thread = this.agentThreads.get(agentId);
    if (thread?.abort && thread.busy) {
      thread.abort.abort();
      thread.status = 'done';
      thread.busy = false;
      this.emitWSMessage(thread.sessionId, 'agent.status', { agentId, status: 'done' });
    }
    this.workers.cancelWorker(agentId);
  }

  cancelSessionWorkers(sessionId: string) {
    this.abortManagerRun(sessionId);
    this.workers.cancelSessionWorkers(sessionId);
  }

  /** True if the session has an active manager run or any worker. */
  isSessionRunning(sessionId: string): boolean {
    if (this.managerAbortBySession.has(sessionId)) return true;
    return this.workers.hasSessionWorkers(sessionId);
  }

  getStatus() {
    return this.workers.getStatus();
  }

  cancel() {
    const sessionIds = new Set(this.workers.cancelAll());
    this.managerAbortBySession.forEach((ac, sid) => {
      sessionIds.add(sid);
      ac.abort();
    });
    this.managerAbortBySession.clear();
    for (const sid of sessionIds) {
      this.emitWSMessage(sid, 'agent.status', { agentId: KORY_IDENTITY.id, status: 'done' });
    }
    this.isProcessing = false;
    koryLog.info('All workers cancelled via global cancel');
  }

  private async generateWorkerTask(
    sessionId: string,
    message: string,
    domain: WorkerDomain,
    preferredModel?: string,
  ): Promise<string> {
    const routing = this.resolveActiveRouting(preferredModel, 'general', true);
    const provider = await this.providers.resolveProvider(routing.model, routing.provider);
    if (!provider) return message;
    let res = '';
    try {
      for await (const event of provider.streamResponse({
        model: routing.model,
        systemPrompt: 'Be brief and actionable.',
        messages: [{ role: 'user', content: `Worker instruction for ${domain}: ${message}` }],
        maxTokens: 200,
      }))
        if (event.type === 'content_delta') res += event.content;
      return res.trim() || message;
    } catch {
      return message;
    }
  }

  private async loadHistory(sessionId: string): Promise<InternalMessage[]> {
    return (
      (await this.messages?.getRecent(sessionId, 10))?.map((m) => ({
        role: m.role as InternalMessage['role'],
        content: m.content,
      })) || []
    );
  }

  getAgentThreadsForSession(sessionId: string): Array<{
    agent: AgentIdentity;
    status: AgentStatus;
    kind: 'worker' | 'critic';
    updatedAt: number;
    lastMessage?: string;
  }> {
    return Array.from(this.agentThreads.values())
      .filter((thread) => thread.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => ({
        agent: thread.identity,
        status: thread.status,
        kind: thread.kind,
        updatedAt: thread.updatedAt,
        lastMessage: thread.threadEntries.at(-1)?.content,
      }));
  }

  getAgentThreadEntries(sessionId: string, agentId: string): AgentThreadEntry[] {
    const thread = this.agentThreads.get(agentId);
    if (!thread || thread.sessionId !== sessionId) return [];
    return [...thread.threadEntries];
  }

  async sendMessageToAgent(sessionId: string, agentId: string, content: string): Promise<void> {
    const thread = this.agentThreads.get(agentId);
    if (!thread || thread.sessionId !== sessionId) {
      throw new Error('Agent thread not found');
    }
    if (thread.busy) {
      throw new Error('Agent is already working');
    }
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('Message cannot be empty');
    }
    if (thread.abort?.signal.aborted) {
      const abort = new AbortController();
      thread.abort = abort;
      thread.ctx = { ...thread.ctx, signal: abort.signal };
    }
    thread.messages.push({ role: 'user', content: trimmed });
    this.appendAgentThreadEntry(thread, 'user', trimmed);
    void this.runAgentThread(agentId).catch((err) => {
      koryLog.error(
        { agentId, sessionId, err: err instanceof Error ? err.message : String(err) },
        'Direct agent message failed',
      );
    });
  }

  private appendAgentThreadEntry(
    thread: AgentThreadState,
    role: AgentThreadEntry['role'],
    content: string,
  ): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    const entry: AgentThreadEntry = {
      id: nanoid(12),
      role,
      content: trimmed,
      createdAt: Date.now(),
    };
    thread.threadEntries.push(entry);
    thread.updatedAt = entry.createdAt;
    this.emitWSMessage(thread.sessionId, 'agent.thread_message', {
      agentId: thread.identity.id,
      entry,
    });
  }

  private async runAgentThread(agentId: string, providerOverride?: Provider): Promise<void> {
    const thread = this.agentThreads.get(agentId);
    if (!thread) throw new Error('Agent thread not found');
    const provider =
      providerOverride ??
      (await this.providers.resolveProvider(thread.modelId, thread.providerName));
    if (!provider) throw new Error('Agent provider unavailable');

    thread.busy = true;
    thread.status = 'thinking';
    thread.updatedAt = Date.now();
    this.emitWSMessage(thread.sessionId, 'agent.status', {
      agentId: thread.identity.id,
      status: thread.status,
    });

    try {
      let turnCount = 0;
      while (turnCount < thread.maxTurns) {
        turnCount++;
        const shouldContinue =
          thread.kind === 'worker'
            ? await this.processProviderTurn(
                thread.sessionId,
                thread.identity.id,
                thread.modelId,
                provider,
                thread.messages,
                thread.ctx,
                thread.reasoningLevel,
              )
            : await this.processAgentThreadTurn(thread, provider);
        if (!shouldContinue) break;
      }
      thread.status = 'done';
      thread.updatedAt = Date.now();
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: 'done',
      });
    } catch (err) {
      thread.status = 'error';
      thread.updatedAt = Date.now();
      this.emitWSMessage(thread.sessionId, 'agent.error', {
        agentId: thread.identity.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emitWSMessage(thread.sessionId, 'agent.status', {
        agentId: thread.identity.id,
        status: 'error',
      });
      throw err;
    } finally {
      thread.busy = false;
      if (thread.kind === 'worker') {
        this.workers.removeWorker(agentId);
      }
    }
  }

  private async processAgentThreadTurn(
    thread: AgentThreadState,
    provider: Provider,
  ): Promise<boolean> {
    const normalizedReasoning = normalizeReasoningLevel(
      provider.name,
      thread.modelId,
      thread.reasoningLevel,
    );
    const streamSignal = withTimeoutSignal(thread.ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: thread.modelId,
        systemPrompt: thread.systemPrompt,
        messages: this.toProviderMessages(thread.messages),
        tools: this.tools.getToolDefsForRole(thread.toolRole),
        maxTokens: thread.maxTokens,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
      },
      provider.name,
    );

    let assistantContent = '';
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];

    for await (const event of stream) {
      if (event.type === 'error') {
        throw new Error(event.error ?? 'LLM stream error');
      }
      if (event.type === 'content_delta') {
        assistantContent += event.content ?? '';
        thread.status = 'streaming';
        thread.updatedAt = Date.now();
        this.emitWSMessage(thread.sessionId, 'stream.delta', {
          agentId: thread.identity.id,
          content: event.content,
          model: thread.modelId,
        });
      } else if (event.type === 'usage_update') {
        this.updateUsageFromEvent(
          thread.sessionId,
          thread.identity.id,
          thread.modelId,
          provider.name,
          event,
        );
      } else if (event.type === 'tool_use_start') {
        thread.status = 'tool_calling';
        thread.updatedAt = Date.now();
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: '' });
        this.emitWSMessage(thread.sessionId, 'stream.tool_call', {
          agentId: thread.identity.id,
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

    if (assistantContent.trim()) {
      this.appendAgentThreadEntry(thread, 'assistant', assistantContent);
    }

    thread.messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: completedToolCalls.length
        ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input }))
        : undefined,
    });

    if (completedToolCalls.length === 0) {
      return false;
    }

    for (const tc of completedToolCalls) {
      const result =
        thread.toolRole === 'critic'
          ? await this.tools.execute(thread.ctx, { id: tc.id, name: tc.name, input: tc.input })
          : await this.executeToolCall(thread.sessionId, thread.identity.id, tc, thread.ctx);
      this.emitWSMessage(thread.sessionId, 'stream.tool_result', {
        agentId: thread.identity.id,
        toolResult: result,
      });
      thread.messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
    }

    return true;
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
    const thread = this.agentThreads.get(workerId);
    if (thread) {
      thread.sessionId = sessionId;
      thread.modelId = modelId;
      thread.providerName = provider.name;
      thread.messages = messages;
      thread.ctx = ctx;
      thread.reasoningLevel = reasoningLevel;
      return this.processAgentThreadTurn(thread, provider);
    }

    const fallbackThread: AgentThreadState = {
      sessionId,
      identity: {
        id: workerId,
        name: 'Worker',
        role: 'coder',
        model: modelId,
        provider: provider.name,
        domain: 'general',
        glowColor: DOMAIN.GLOW_COLORS.general,
      },
      kind: 'worker',
      status: 'thinking',
      providerName: provider.name,
      modelId,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      toolRole: 'worker',
      reasoningLevel,
      maxTurns: 1,
      maxTokens: 16384,
      messages,
      threadEntries: [],
      ctx,
      busy: true,
      updatedAt: Date.now(),
    };
    return this.processAgentThreadTurn(fallbackThread, provider);
  }

  /** Build provider messages with tool_call_id for role "tool" and tool_calls for assistant so APIs accept tool results. */
  private toProviderMessages(messages: InternalMessage[]): ProviderMessage[] {
    return messages.map((m) => {
      const out: ProviderMessage = { role: m.role, content: m.content };
      if (m.role === 'tool' && m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
      if (m.role === 'assistant' && m.tool_calls?.length) out.tool_calls = m.tool_calls;
      return out;
    });
  }

  abortManagerRun(sessionId: string): void {
    const controller = this.managerAbortBySession.get(sessionId);
    if (controller) {
      controller.abort();
      this.managerAbortBySession.delete(sessionId);
      koryLog.info({ sessionId }, 'Manager run aborted');
    }
  }

  // ─── Memory Management & Cleanup ────────────────────────────────────────────────

  /**
   * Cleanup all resources for a specific session.
   * Call this when a session is closed or abandoned.
   */
  cleanupSession(sessionId: string): void {
    // Cancel any active workers for this session
    this.workers.cancelSessionWorkers(sessionId);

    // Abort any ongoing manager run
    this.abortManagerRun(sessionId);

    // Clear pending user inputs (reject with abort error)
    if (this.state.hasPendingInput(sessionId)) {
      this.state.resolveUserInput(sessionId, '');
    }

    // Clear session-specific data
    this.state.cleanupSession(sessionId);
    this.managerAbortBySession.delete(sessionId);
    for (const [agentId, thread] of this.agentThreads.entries()) {
      if (thread.sessionId === sessionId) this.agentThreads.delete(agentId);
    }

    koryLog.debug({ sessionId }, 'Session resources cleaned up');
  }

  /**
   * Get memory usage statistics for monitoring.
   */
  getMemoryStats(): {
    activeWorkers: number;
    pendingUserInputs: number;
    trackedSessions: number;
    workerUsageEntries: number;
  } {
    const workerStats = this.workers.getActiveCount();
    const sessionStats = this.state.getMemoryStats();
    return {
      activeWorkers: workerStats,
      pendingUserInputs: sessionStats.sessions,
      trackedSessions: this.workers.getActiveSessionIds().length,
      workerUsageEntries: workerStats,
    };
  }

  /**
   * Cleanup abandoned resources.
   * Call this periodically to prevent memory leaks from abandoned sessions.
   */
  cleanupAbandonedResources(_maxSessionAgeMs = 30 * 60 * 1000): void {
    const activeSessionIds = new Set(this.workers.getActiveSessionIds());

    // Clean up worker usage for workers that no longer exist
    this.workers.cleanupStaleWorkers();

    // Clean up old session data not associated with any active worker
    for (const sessionId of this.state.getSessionIds()) {
      if (!activeSessionIds.has(sessionId)) {
        this.state.cleanupSession(sessionId);
      }
    }

    koryLog.debug(
      {
        activeWorkers: this.workers.getActiveCount(),
        trackedSessions: activeSessionIds.size,
      },
      'Abandoned resources cleaned up',
    );
  }

  /**
   * Complete shutdown - cleanup all resources.
   * Call this during server shutdown.
   */
  shutdown(): void {
    koryLog.info('Shutting down KoryManager');

    // Cancel all active workers
    this.workers.shutdown();

    // Abort all manager runs
    for (const [sessionId, controller] of this.managerAbortBySession) {
      try {
        controller.abort();
      } catch (err) {
        koryLog.warn(
          { sessionId, error: String(err) },
          'Failed to abort manager run during shutdown',
        );
      }
    }
    this.managerAbortBySession.clear();

    // Clear all session state
    this.state.cleanupAll();
    this.agentThreads.clear();

    koryLog.info('KoryManager shutdown complete');
  }

  private emitThought(sessionId: string, phase: string, thought: string) {
    this.events.emitThought(sessionId, phase, thought);
  }
  private emitRouting(sessionId: string, d: WorkerDomain, m: string, p: string) {
    this.events.emitRouting(sessionId, d, m, p);
  }
  private emitError(sessionId: string, error: string) {
    this.events.emitError(sessionId, error);
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
    this.events.emitUsageUpdate(
      sessionId,
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      usageKnown,
    );
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage['payload']) {
    this.events.emit(sessionId, type, payload);
  }
}
