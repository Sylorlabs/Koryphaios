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
  ContextBreakdown,
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
import { detectJulesApiKey } from '../providers/auth-utils';
import { runJulesTask } from '../providers/jules-runner';
import { JULES_SYNC_INSTRUCTIONS, getProviderDisplay } from '../providers/provider-display';
import { ToolRegistry, type ToolCallInput, type ToolContext, type ToolCallOutput } from '../tools';
import { wsBroker } from '../pubsub';
import { koryLog } from '../logger';
import { initContextArchive, getContextArchive } from './context-archive';
import { nanoid } from 'nanoid';
import { sanitizeForPrompt } from '../security';
import {
  checkNoteToolPermission,
  filterToolDefsForNotesPermissions,
  buildNotesNetworkSystemHint,
  hasAnyVisibleNoteTools,
  formatNoteToolApprovalSummary,
} from '../notes/notes-settings';
import { isNoteToolName } from '@koryphaios/shared';
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
import {
  EventEmitterService,
  WorkerLifecycleService,
  SessionStateService,
  WorkerPipelineService,
} from './services';
import { TimeTravelService } from '../services';
import { RoutingServiceEnhanced } from './services/RoutingServiceEnhanced';
import {
  parseCriticVerdict,
  formatMessagesForCritic as formatMessagesForCriticUtil,
} from './critic-util';
import { AutoCommitService } from './auto-commit-service';
import { getModeManager } from '../mode';
import type { WorkerPipelineConfig } from './services/WorkerPipelineService';
import type { UIMode } from '@koryphaios/shared';
import { collaborationManager } from '../collaboration/manager';

// ─── Internal Types ─────────────────────────────────────────────────────────

interface CompletedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface InternalMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | import('../providers/types').ProviderContentBlock[];
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

/** Parse a JSON string into an object, tolerating malformed input (returns {}). */
function safeParseJson(s?: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const KORY_SYSTEM_PROMPT = `You are Kory, the manager agent. The user talks to you only. Sub-agents (workers) run only when you explicitly call delegate_to_worker—never automatically.

• Handle requests yourself: answer questions, use tools (read_file, grep, bash, web_search, etc.), do small edits. For conversation, clarification, or straightforward work, you are the sole agent.
• FILE EDITS: ALWAYS create files with the write_file tool and modify files with the edit_file tool. NEVER use bash (cat >, tee, echo >, sed, heredocs, apply_patch) to create or modify files — those bypass the live code preview the user watches. Use bash only for running commands, never for writing file content.
• You may run terminals in the background: use the bash tool with isBackground: true (and optional processName) to start long-lived processes (e.g. dev servers). Use shell_manage to list stored background processes, view their logs, or kill them. Only you can manage these background terminals.
• Sub-agents (workers: general, ui, backend, test, review) exist only for you to invoke when you decide a task needs a specialist coder. Call delegate_to_worker only for substantial implementation, refactoring, or multi-step coding—not for chat, simple questions, or minor edits.
• When you delegate, the worker reports back; you verify and synthesize.
• IMPORTANT: If you decide to delegate, call delegate_to_worker IMMEDIATELY without generating any explanatory text first. Do not write "I'll delegate this" or similar—just call the tool directly.
• delegate_to_jules: Offload substantial repo work to Google Jules — a CLOUD-ONLY async agent (API). Jules runs in remote Google VMs (not locally), often takes minutes, and may open GitHub PRs. Never use for quick local edits or chat. Jules never writes to the local working tree — after it finishes you MUST sync remote work locally (\`git fetch && git pull\`, or \`gh pr checkout <n>\`) before continuing.
• If you have successfully completed a task or edit and are ready to save the work, use the commit_and_create_pr tool to commit and create a pull request automatically.`;
const WORKER_SYSTEM_PROMPT = `You are a specialist Worker Agent. EXECUTE the assigned task using tools. QUALITY FIRST. VERIFY. If you have successfully completed a task, you may use the commit_and_create_pr tool to save the work.
FILE EDITS: ALWAYS create files with write_file and modify files with edit_file. NEVER use bash (cat >, tee, echo >, sed, heredocs) to write or modify file content — that bypasses the live code preview. Use bash only for running commands.`;
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
  /** AbortController for the current manager run per session (so cancelSessionWorkers can abort manager too). */
  private managerAbortBySession = new Map<string, AbortController>();
  /** In-memory worker/critic chat threads keyed by agentId. */
  private agentThreads = new Map<string, AgentThreadState>();
  /** Services */
  private events: EventEmitterService;
  private routing: RoutingServiceEnhanced;
  private workers: WorkerLifecycleService;
  private state: SessionStateService;
  private workerPipeline: WorkerPipelineService;
  private autoCommitService: AutoCommitService;

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
    initContextArchive(workingDirectory);

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
    this.routing = new RoutingServiceEnhanced({ config: this.config, providers: this.providers });
    this.workers = new WorkerLifecycleService({ events: this.events });
    this.state = new SessionStateService();
    this.autoCommitService = new AutoCommitService(this.workingDirectory, this.git);

    const pipelineConfig: WorkerPipelineConfig = {
      getIsYoloMode: () => this.isYoloMode,
      getWorkingDirectory: () => this.workingDirectory,
      getWorkerReasoningLevel: () => this.getWorkerReasoningLevel(),
      waitForUserInput: (sessionId, question, options) =>
        this.waitForUserInputInternal(sessionId, question, options),
      emitThought: (sessionId, phase, thought) => this.emitThought(sessionId, phase, thought),
      updateWorkflowState: (sessionId, state) => this.updateWorkflowState(sessionId, state),
      handleAutoCommit: (sessionId, taskDescription) =>
        this.handleAutoCommit(sessionId, taskDescription),
      resolveActiveRouting: (preferredModel, domain, avoidLegacy, prompt, preferCheap) =>
        this.resolveActiveRouting(preferredModel, domain, avoidLegacy, prompt, preferCheap),
      executeWithProvider: (
        sessionId,
        provider,
        modelId,
        userMessage,
        domain,
        reasoningLevel,
        isAutoMode,
        allowedPaths,
        isSandboxed,
      ) =>
        this.executeWithProvider(
          sessionId,
          provider,
          modelId,
          userMessage,
          domain,
          reasoningLevel,
          isAutoMode,
          allowedPaths,
          isSandboxed,
        ),
      runCriticGate: (sessionId, workerMessages, preferredModel) =>
        this.runCriticGate(sessionId, workerMessages, preferredModel),
    };

    this.workerPipeline = new WorkerPipelineService({
      providers: this.providers,
      state: this.state,
      git: this.git,
      workspaceManager: this.workspaceManager,
      snapshotManager: this.snapshotManager,
      tasks: this.tasks,
      config: pipelineConfig,
    });

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
    return this.state.requestUserInput(sessionId, AGENT.USER_INPUT_TIMEOUT_MS);
  }

  /** Main entry point for processing a task. */
  async processTask(
    sessionId: string,
    userMessage: string,
    preferredModel?: string,
    reasoningLevel?: string,
    attachments?: Array<{ type: string; data: string; name: string }>,
  ): Promise<void> {
    this.isProcessing = true;
    this.state.clearChanges(sessionId);
    userMessage = sanitizeForPrompt(userMessage);

    // Resolve provider before any UI updates or work. No provider = manager responds once and returns.
    let routing = this.resolveActiveRouting(preferredModel, 'general', true, userMessage);
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

    // Broadcast the user message to relay guests
    collaborationManager.broadcastEvent({ type: 'chat', from: 'human', content: userMessage });

    await this.updateWorkflowState(sessionId, 'analyzing');
    try {
      koryLog.debug({ sessionId }, 'Calling handleDirectly');
      this.emitThought(sessionId, 'analyzing', `Analyzing request...`);

      // Global timeout: abort the task if it runs too long (prevents indefinite hangs)
      const TIMEOUT_MIN = AGENT.PROCESS_TASK_TIMEOUT_MS / 60_000;
      const processTimeout = setTimeout(() => {
        // Abort any active LLM stream
        const abort = this.managerAbortBySession.get(sessionId);
        if (abort) {
          abort.abort(
            new DOMException(`Process task timed out after ${TIMEOUT_MIN} minutes`, 'TimeoutError'),
          );
        }
        // Resolve any pending user input so the task doesn't hang forever
        this.state.resolveUserInput(sessionId, '__timeout__');
      }, AGENT.PROCESS_TASK_TIMEOUT_MS);

      try {
        await this.handleDirectly(sessionId, userMessage, reasoningLevel, preferredModel, attachments);
      } finally {
        clearTimeout(processTimeout);
      }

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
    prompt?: string,
    preferCheap?: boolean,
  ): { model: string; provider: ProviderName | undefined } {
    return this.routing.resolveActiveRouting(preferredModel, domain, avoidLegacy, prompt, preferCheap);
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
    return this.workerPipeline.runWorkerPipeline(
      sessionId,
      task,
      preferredModel,
      reasoningLevel,
      domainHint,
    );
  }

  private async handleAutoCommit(sessionId: string, taskDescription: string): Promise<void> {
    if (!getModeManager().shouldAutoCommit()) return;
    try {
      await this.autoCommitService.autoCommitAndCreatePR(taskDescription);
    } catch (err) {
      koryLog.warn({ err, sessionId }, 'Auto-commit failed after worker task');
    }
  }

  /** Whether Jules cloud delegation is configured (API key). */
  isJulesAvailable(): boolean {
    const jules = this.providers.get('jules');
    if (jules?.isAvailable()) return true;
    return !!detectJulesApiKey();
  }

  private resolveJulesApiKey(): string | null {
    const cfg = this.providers.getConfigs().jules;
    return cfg?.apiKey?.trim() || detectJulesApiKey();
  }

  /**
   * Delegate a task to Google Jules (cloud async agent). Used by delegate_to_jules tool.
   * Streams progress to the session feed while polling the Jules API.
   */
  async runJulesDelegation(
    sessionId: string,
    task: string,
    options?: { createPr?: boolean; branch?: string },
  ): Promise<string> {
    const apiKey = this.resolveJulesApiKey();
    if (!apiKey) {
      return 'Jules is not configured. Add JULES_API_KEY in Settings (https://jules.google.com/settings#api).';
    }

    if (!this.isYoloMode) {
      const selection = await this.waitForUserInputInternal(
        sessionId,
        'Delegate this task to Jules (cloud agent — runs remotely, may take minutes)?',
        ['Yes, send to Jules', 'Cancel'],
      );
      if (selection === '__timeout__') return 'Timed out waiting for user response.';
      if (selection.includes('Cancel')) return 'Jules delegation cancelled by user.';
    }

    this.emitThought(sessionId, 'executing', 'Jules cloud agent working…');
    await this.updateWorkflowState(sessionId, 'executing');

    let summary = '';
    const automationMode = options?.createPr === false ? undefined : 'AUTO_CREATE_PR';

    try {
      for await (const event of runJulesTask({
        apiKey,
        prompt: task,
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        korySessionId: sessionId,
        defaultBranch: options?.branch,
        automationMode,
        signal: this.state.getAbortController(sessionId).signal,
      })) {
        this.emitJulesProviderEvent(sessionId, event);
        if (event.type === 'content_delta' && event.content) summary += event.content;
        if (event.type === 'error') {
          await this.updateWorkflowState(sessionId, 'idle');
          return event.error ?? 'Jules cloud delegation failed.';
        }
        if (event.type === 'complete') break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.updateWorkflowState(sessionId, 'idle');
      return `Jules cloud delegation failed: ${msg}`;
    }

    await this.updateWorkflowState(sessionId, 'idle');
    const tail = summary.trim() || 'Jules cloud task finished. Check the session link or PR above.';
    return `${tail}\n\n**Sync locally:** ${JULES_SYNC_INSTRUCTIONS}`;
  }

  private emitJulesProviderEvent(sessionId: string, event: ProviderEvent): void {
    if (event.type === 'thinking_delta' && event.thinking) {
      this.emitWSMessage(sessionId, 'stream.thinking', {
        agentId: KORY_IDENTITY.id,
        thinking: event.thinking,
      } satisfies StreamThinkingPayload);
    } else if (event.type === 'content_delta' && event.content) {
      this.emitWSMessage(sessionId, 'stream.delta', {
        agentId: KORY_IDENTITY.id,
        content: event.content,
        model: 'jules',
      });
    } else if (event.type === 'tool_executed') {
      const callId = `jules-${nanoid(8)}`;
      this.emitWSMessage(sessionId, 'stream.tool_call', {
        agentId: KORY_IDENTITY.id,
        toolCall: {
          id: callId,
          name: event.toolName ?? 'jules_cloud',
          input: safeParseJson(event.toolInput),
        },
      });
      this.emitWSMessage(sessionId, 'stream.tool_result', {
        agentId: KORY_IDENTITY.id,
        toolResult: {
          callId,
          name: event.toolName ?? 'jules_cloud',
          output: event.toolOutput ?? '',
          isError: event.isError === true,
          durationMs: 0,
        },
      });
    } else if (event.type === 'file_edit' && event.filePath) {
      this.emitWSMessage(sessionId, 'stream.file_delta', {
        agentId: KORY_IDENTITY.id,
        path: event.filePath,
        delta: event.fileContent ?? '',
        totalLength: (event.fileContent ?? '').length,
        operation: event.fileOperation ?? 'edit',
      });
    }
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
    const criticSessionWd = await this.resolveSessionWorkingDirectory(sessionId);
    const criticCtx: ToolContext = {
      sessionId,
      workingDirectory: criticSessionWd,
      allowedPaths: [criticSessionWd],
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

  /** Manager handles simple tasks directly with full tool access (unsandboxed). Asks user before first tool run unless YOLO. Manager never uses legacy models. */
  private async handleDirectly(
    sessionId: string,
    userMessage: string,
    reasoningLevel?: string,
    preferredModel?: string,
    attachments?: Array<{ type: string; data: string; name: string }>,
  ): Promise<void> {
    koryLog.debug({ sessionId, reasoningLevel, preferredModel }, 'Entering handleDirectly');
    let routing = this.resolveActiveRouting(preferredModel, 'general', true, userMessage);
    let provider = await this.providers.resolveProvider(routing.model, routing.provider);
    // Mirror processTask's fallback: for "auto" (or no model), if the routed model has no
    // available provider, fall back to the first available one — otherwise a configured
    // session spuriously fails with "No provider." even though providers are connected.
    if (!provider && (!preferredModel || preferredModel === 'auto')) {
      const fallback = this.providers.getFirstAvailableRouting();
      if (fallback) {
        routing = { model: fallback.model, provider: fallback.provider };
        provider = this.providers.resolveProvider(routing.model, routing.provider);
      }
    }
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
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
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
        delegateToJules: (task: string, opts) => this.runJulesDelegation(sessionId, task, opts),
      };

      const history = await this.loadHistory(sessionId);
      koryLog.debug({ historyCount: history.length }, 'Loaded history');
      
      let finalContent: string | import('../providers/types').ProviderContentBlock[] = userMessage;
      if (attachments && attachments.length > 0) {
        const imageAttachments = attachments.filter(a => a.type === 'image');
        if (imageAttachments.length > 0) {
          finalContent = [
            { type: 'text', text: userMessage },
            ...imageAttachments.map((att) => {
              let mime = 'image/png';
              const lowerName = att.name.toLowerCase();
              if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mime = 'image/jpeg';
              if (lowerName.endsWith('.webp')) mime = 'image/webp';
              if (lowerName.endsWith('.gif')) mime = 'image/gif';
              return {
                type: 'image' as const,
                imageData: att.data,
                imageMimeType: mime,
              };
            })
          ];
        }
      }

      const messages: InternalMessage[] = [...history, { role: 'user', content: finalContent }];
      // Auto-run tools by default so the app "just works" on launch (changes stay reviewable
      // after the fact + Critic-gated). Set autoRunTools:false to confirm before each run.
      const { loadAgentSettings: loadAgentSettingsForRun } = await import('../agent-settings');
      const autoRunTools = loadAgentSettingsForRun(this.workingDirectory).autoRunTools !== false;
      let turnCount = 0;
      let firstAskForDirectTools = true;
      let stoppedByUser = false;
      // Track whether the run produced anything user-visible — so an empty LLM response
      // surfaces a clear message instead of a silent "weird stop".
      let streamedAnyContent = false;
      let executedAnyTool = false;

      while (turnCount < 25) {
        if (abort.signal.aborted) {
          stoppedByUser = true;
          break;
        }
        turnCount++;
        koryLog.debug({ turnCount }, 'Starting manager turn');
        // Reclaim context: stub out tool outputs the user hid from the agent
        // or that are old enough to be dead weight (recoverable via fetch_context).
        await this.applyContextPruning(sessionId, messages, turnCount);
        let result: LLMTurnResult;
        try {
          result = await this.processManagerTurn(
            sessionId,
            routing.model,
            provider,
            messages,
            managerCtx,
            abort.signal,
            reasoningLevel,
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
        if (result.content && result.content.trim()) streamedAnyContent = true;

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (!completedToolCalls || completedToolCalls.length === 0) break;

        if (completedToolCalls && completedToolCalls.length > 0) {
          if (!autoRunTools && !this.isYoloMode && firstAskForDirectTools) {
            const selection = await this.waitForUserInputInternal(
              sessionId,
              'Manager will run tools to complete this task. Proceed?',
              ['Yes, proceed', 'Cancel'],
            );
            firstAskForDirectTools = false;
            if (selection === '__timeout__' || selection.includes('Cancel')) {
              if (this.messages)
                await this.messages.add(sessionId, {
                  id: nanoid(12),
                  sessionId,
                  role: 'assistant',
                  content: selection === '__timeout__'
                    ? '[Timed out waiting for user response.]'
                    : '[Cancelled by user.]',
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
            // Archive the full output locally so pruning never loses anything —
            // fetch_context can recover the exact content by this id.
            const archiveId = await this.archiveToolResult(sessionId, tc, toolResult);
            this.emitWSMessage(sessionId, 'stream.tool_result', {
              agentId: KORY_IDENTITY.id,
              toolResult: archiveId ? { ...toolResult, archiveId } : toolResult,
            });
            executedAnyTool = true;
            const toolMsg: InternalMessage = {
              role: 'tool',
              content: JSON.stringify(toolResult),
              tool_call_id: tc.id,
            };
            if (archiveId)

              Object.assign(toolMsg, { archiveId, archiveTurn: turnCount });
            messages.push(toolMsg);
          }
        }
      }

      // A stop that lands between turns (or breaks out of the stream loop)
      // must still be reported as user-stopped, not a normal completion.
      if (abort.signal.aborted) stoppedByUser = true;

      const assistants = messages.filter((m) => m.role === 'assistant');
      koryLog.debug(
        { assistantCount: assistants.length },
        'Filtering assistant messages for persistence',
      );
      const lastAssistant = assistants.pop();
      const rawContent = lastAssistant?.content ?? '';
      const content = (typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)).trim();

      // No silent stops: if the model returned nothing user-visible (no streamed text, no
      // tools), say so live instead of leaving the user staring at a finished spinner.
      const emptyResponse = !stoppedByUser && !streamedAnyContent && !executedAnyTool && !content;
      const EMPTY_NOTICE = 'The model returned an empty response. Please resend or rephrase your request.';
      if (emptyResponse) {
        this.emitWSMessage(sessionId, 'stream.delta', {
          agentId: KORY_IDENTITY.id,
          content: EMPTY_NOTICE,
          model: routing.model,
        });
      }

      // Stopping must never erase work: persist whatever the model produced
      // as Kory's message, and record the stop as a separate system marker so
      // it renders as plain text — not as something Kory said.
      const toPersist = stoppedByUser
        ? content
        : content || (emptyResponse ? EMPTY_NOTICE : '[Task completed using tools.]');
      koryLog.debug({ toPersist, sessionId }, 'Attempting to persist assistant message');
      let finalMessageId: string | undefined;
      if (this.messages && toPersist) {
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
      if (this.messages && stoppedByUser) {
        await this.messages.add(sessionId, {
          id: nanoid(12),
          sessionId,
          role: 'system',
          content: 'Stopped by user.',
          model: routing.model,
          provider: providerName,
          createdAt: Date.now(),
        });
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



  private async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext,
    signal?: AbortSignal,
    reasoningLevel?: string,
  ): Promise<LLMTurnResult> {
    if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');

    // Load agent settings to apply experimental overrides
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(this.workingDirectory);

    let systemPrompt = KORY_SYSTEM_PROMPT;
    // Chars contributed by injected memory/notes — tracked separately so the
    // context-usage bar can show memory as its own segment.
    let memoryChars = 0;

    if (hasAnyVisibleNoteTools(this.workingDirectory)) {
      const beforeNotes = systemPrompt.length;
      const hint = buildNotesNetworkSystemHint(this.workingDirectory);
      if (hint) systemPrompt += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        systemPrompt += await buildNotesNetworkPrompt(2500, this.workingDirectory);
      } catch {
        // Notes DB may be unavailable — continue without network context
      }
      memoryChars = systemPrompt.length - beforeNotes;
    }

    // Multi-source research instruction
    if (settings.multiSourceResearch) {
      systemPrompt +=
        '\n\n• DEEP RESEARCH: When researching complex topics, do not rely on a single source. Use the web_search tool to find multiple perspectives and fetch/read at least 3-5 different pages to verify information and identify consensus or contradictions.';
    }

    // Filter tools based on local web search setting
    let tools = filterToolDefsForNotesPermissions(
      this.tools.getToolDefsForRole('manager'),
      this.workingDirectory,
    );
    if (settings.localWebSearch === 'off') {
      tools = tools.filter((t) => t.name !== 'web_search');
    }

    if (!this.isJulesAvailable()) {
      tools = tools.filter((t) => t.name !== 'delegate_to_jules');
    } else {
      systemPrompt +=
        `\n\n• JULES (cloud): delegate_to_jules sends work to Google Jules — remote VMs, async, may take minutes, produces PRs. Never substitute for local tools on quick edits.\n• ${JULES_SYNC_INSTRUCTIONS}`;
    }

    if (provider.name === 'jules') {
      const julesMeta = getProviderDisplay('jules');
      systemPrompt +=
        `\n\n• You are chatting through Jules (cloud provider). All code changes happen on Google's remote infrastructure and GitHub — not in this local workspace until synced.\n• ${julesMeta?.managerHint ?? JULES_SYNC_INSTRUCTIONS}`;
    }

    // Agent execution mode (the composer pill, persisted in agent settings): gate delegation.
    //  • single → never delegate (remove the tool entirely — guaranteed solo)
    //  • multi  → actively prefer delegating substantial coding to specialist workers
    //  • auto   → Kory decides per-task (default)
    const execMode = settings.agentExecutionMode ?? 'auto';
    if (execMode === 'single') {
      tools = tools.filter((t) => t.name !== 'delegate_to_worker' && t.name !== 'delegate_to_jules');
      systemPrompt +=
        '\n\n• AGENT MODE: SOLO — Do NOT delegate. Complete the entire task yourself; delegate_to_worker and delegate_to_jules are unavailable this turn.';
    } else if (execMode === 'multi') {
      systemPrompt +=
        '\n\n• AGENT MODE: MULTI-AGENT — The user explicitly wants a coordinated team. Prefer delegating substantial implementation, refactoring, or multi-step coding to specialist workers via delegate_to_worker, and synthesize their results. Still answer trivial questions yourself.';
    }
    // If "fallback", we keep it in the list. The model can choose to use it if its native search fails or is unavailable.

    const providerMessages = this.toProviderMessages(messages);
    // Estimated context composition at dispatch (chars/4) — segment ratios for
    // the context-usage bar; the provider's usage_update stays the real total.
    // Agentic CLI harnesses (claude/grok/antigravity) run their OWN tools —
    // Koryphaios tool schemas are never sent to them, so counting our defs as
    // "Tools" misattributes the CLI's harness overhead. Their real overhead
    // shows up as the gap between this estimate and provider-reported usage
    // (rendered as "Provider harness" in the context bar).
    const NATIVE_TOOL_PROVIDERS = new Set(['claude', 'grok', 'antigravity']);
    const contextBreakdown: ContextBreakdown = {
      system: Math.ceil(Math.max(0, systemPrompt.length - memoryChars) / 4),
      memory: Math.ceil(memoryChars / 4),
      tools: NATIVE_TOOL_PROVIDERS.has(provider.name)
        ? 0
        : Math.ceil(JSON.stringify(tools ?? []).length / 4),
      chat: Math.ceil(estimateProviderMessagesChars(providerMessages) / 4),
    };

    const estTokens =
      contextBreakdown.system +
      contextBreakdown.memory +
      contextBreakdown.tools +
      contextBreakdown.chat;
    // Real context data at dispatch time — the bar updates the moment a turn
    // starts (reflecting prunes/hides), instead of trusting a stale usage
    // event from a previous turn or model. Provider usage refines it later.
    this.emitUsageUpdate(
      sessionId,
      KORY_IDENTITY.id,
      modelId,
      provider.name,
      estTokens,
      0,
      true,
      contextBreakdown,
    );

    // Context self-awareness: tell the model what its window looks like and
    // what's prunable, so it can decide on its own to free space or compact.
    if (settings.contextSelfAwareness !== false) {
      const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
      const win = resolveTrustedContextWindow(modelId, provider.name);
      const pct = win.contextWindow ? Math.round((estTokens / win.contextWindow) * 100) : null;
      const bulky = messages
        .filter(
          (m): m is InternalMessage & { archiveId: string; content: string } =>
            m.role === 'tool' &&
            typeof (m as { archiveId?: string }).archiveId === 'string' &&
            !(m as { pruneApplied?: boolean }).pruneApplied &&
            typeof m.content === 'string' &&
            m.content.length > 400,
        )
        .map((m) => ({ id: m.archiveId, tok: Math.ceil(m.content.length / 4) }))
        .sort((a, b) => b.tok - a.tok)
        .slice(0, 5);
      systemPrompt +=
        `

[CONTEXT STATUS] ~${k(estTokens)} tokens in your context` +
        (pct !== null ? ` (~${pct}% of a ${k(win.contextWindow!)} window)` : '') +
        ` — system ${k(contextBreakdown.system)}, memory ${k(contextBreakdown.memory)}, tools ${k(contextBreakdown.tools)}, chat/tool-results ${k(contextBreakdown.chat)}.` +
        (bulky.length
          ? ` Largest prunable tool outputs: ${bulky.map((b) => `${b.id} (~${k(b.tok)})`).join(', ')}.`
          : '') +
        ` You own this window: fetch_context with no arguments lists everything you did (with timestamps); ` +
        `prune_context drops outputs you no longer need (always recoverable)` +
        (pct !== null && pct >= 70
          ? `. Note: your context is filling up. It's your call — prune stale outputs, keep going if you're nearly done, or if nothing is prunable, suggest the user compact the session.`
          : `.`);
    }

    // The composer's reasoning tier MUST reach the provider — this was silently
    // dropped for the main chat turn (only worker threads forwarded it).
    const resolvedReasoning =
      reasoningLevel === 'auto'
        ? determineAutoReasoningLevel(
            typeof messages[messages.length - 1]?.content === 'string'
              ? (messages[messages.length - 1].content as string)
              : '',
          )
        : reasoningLevel;
    const normalizedReasoning = normalizeReasoningLevel(
      provider.name,
      modelId,
      resolvedReasoning,
    );

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: providerMessages,
        tools,
        maxTokens: 16384,
        signal: streamSignal,
        ...(normalizedReasoning !== undefined && { reasoningLevel: normalizedReasoning }),
        // Agentic CLI providers (claude-code) run + edit files in the session's project directory.
        workingDirectory: await this.resolveSessionWorkingDirectory(sessionId),
        sessionId,
      },
      provider.name,
    );

    let assistantContent = '';
    let pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: CompletedToolCall[] = [];
    let hasToolCalls = false;
    let tokensIn = 0;
    let tokensOut = 0;

    try {
    for await (const event of stream) {
      // On user stop, keep everything accumulated so far — breaking (instead of
      // throwing) lets the partial response flow into `messages` and get
      // persisted. Throwing here erased the user's proof-of-work on Stop.
      if (signal?.aborted) break;
      if (event.type === 'error') {
        throw new Error(event.error ?? 'LLM stream error');
      }
      if (event.type === 'content_delta') {
        const delta = event.content ?? '';
        assistantContent += delta;
        // Stream live, token-by-token — so the user sees text appear immediately (no
        // "thinks then dumps" pause) and partial output survives a mid-stream error.
        if (delta) {
          this.emitWSMessage(sessionId, 'stream.delta', {
            agentId: KORY_IDENTITY.id,
            content: delta,
            model: modelId,
          });
        }
      } else if (event.type === 'thinking_delta') {
        if (event.thinking || typeof event.thinkingTokens === 'number') {
          this.emitWSMessage(sessionId, 'stream.thinking', {
            agentId: KORY_IDENTITY.id,
            thinking: event.thinking ?? '',
            ...(typeof event.thinkingTokens === 'number'
              ? { thinkingTokens: event.thinkingTokens }
              : {}),
          } satisfies StreamThinkingPayload);
        }
      } else if (event.type === 'file_edit') {
        // Agentic provider (claude-code) already wrote the file — surface it in the live
        // diff preview (it's done, not a tool for us to execute).
        if (event.filePath) {
          this.streamAgentFileEdit(ctx, event.filePath, event.fileContent ?? '', event.fileOperation ?? 'edit', event.fileOldContent);
          // Archive the edit so fetch_context can recall exactly what was written.
          await getContextArchive()?.record(
            sessionId,
            'file_edit',
            `${event.fileOperation ?? 'edit'} ${event.filePath}`,
            event.fileContent ?? '',
          );
        }
      } else if (event.type === 'tool_executed') {
        // Agentic provider already ran a non-file tool — surface it in the tool feed.
        const callId = `agent-${nanoid(8)}`;
        const agenticArchiveId = await getContextArchive()?.record(
          sessionId,
          'tool_result',
          `${event.toolName ?? 'tool'} ${(event.toolInput ?? '').slice(0, 140)}`,
          event.toolOutput ?? '',
        );
        this.emitWSMessage(sessionId, 'stream.tool_call', {
          agentId: KORY_IDENTITY.id,
          toolCall: { id: callId, name: event.toolName ?? 'tool', input: safeParseJson(event.toolInput) },
        });
        this.emitWSMessage(sessionId, 'stream.tool_result', {
          agentId: KORY_IDENTITY.id,
          toolResult: { callId, name: event.toolName ?? 'tool', output: event.toolOutput ?? '', isError: event.isError === true, durationMs: 0, ...(agenticArchiveId ? { archiveId: agenticArchiveId } : {}) },
        });
      } else if (event.type === 'usage_update') {
        // Cached prompt tokens still occupy the context window — fold them in
        // so the context bar reflects real occupancy, not just billed input.
        if (typeof event.tokensIn === 'number')
          tokensIn = Math.max(tokensIn, event.tokensIn + (event.tokensCache ?? 0));
        if (typeof event.tokensOut === 'number') tokensOut = Math.max(tokensOut, event.tokensOut);
        this.emitUsageUpdate(
          sessionId,
          KORY_IDENTITY.id,
          modelId,
          provider.name,
          tokensIn,
          tokensOut,
          true,
          contextBreakdown,
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
    } catch (err) {
      // Provider streams can throw on abort (fetch AbortError) — salvage the
      // partial response instead of discarding the turn. Real errors rethrow.
      const aborted =
        signal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (!aborted) throw err;
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

  /**
   * Surface a file edit an AGENTIC provider (claude-code) already performed, via the live
   * diff preview pipeline (stream.file_delta/file_complete) + change tracking. The agent
   * did the write; we only display it.
   */
  private streamAgentFileEdit(
    ctx: ToolContext,
    path: string,
    content: string,
    operation: 'create' | 'edit',
    oldStr?: string,
  ): void {
    ctx.emitFileEdit?.({
      path,
      delta: content,
      totalLength: content.length,
      operation,
      ...(operation === 'edit' && oldStr !== undefined ? { oldStr } : {}),
    });
    ctx.emitFileComplete?.({ path, totalLines: content.split('\n').length, operation });
    ctx.recordChange?.({
      path,
      linesAdded: content ? content.split('\n').length : 0,
      linesDeleted: oldStr ? oldStr.split('\n').length : 0,
      operation,
    });
  }

  private async gateNoteToolCall(
    sessionId: string,
    tc: CompletedToolCall,
  ): Promise<ToolCallOutput | null> {
    if (!isNoteToolName(tc.name)) return null;

    const check = checkNoteToolPermission(tc.name, this.workingDirectory, {
      yoloMode: this.isYoloMode,
    });

    if (!check.allowed) {
      // Tool was hidden from the schema — treat as unknown if the model hallucinates a call
      return {
        callId: tc.id,
        name: tc.name,
        output: `Unknown tool: ${tc.name}`,
        isError: true,
        durationMs: 0,
      };
    }

    if (check.requiresApproval) {
      const summary = formatNoteToolApprovalSummary(
        tc.name,
        (tc.input ?? {}) as Record<string, unknown>,
      );
      const selection = await this.waitForUserInputInternal(
        sessionId,
        `Allow agent to ${summary}?`,
        ['Allow', 'Deny'],
      );
      if (selection === '__timeout__' || selection.includes('Deny') || selection.includes('Cancel')) {
        return {
          callId: tc.id,
          name: tc.name,
          output:
            selection === '__timeout__'
              ? 'Note action denied: timed out waiting for approval'
              : 'Note action denied by user',
          isError: true,
          durationMs: 0,
        };
      }
    }

    return null;
  }

  /** Archive a manager tool result for later recovery via fetch_context. */
  private async archiveToolResult(
    sessionId: string,
    tc: CompletedToolCall,
    toolResult: ToolCallOutput,
  ): Promise<string | undefined> {
    // The context meta-tools manage the archive; archiving them is noise.
    if (tc.name === 'fetch_context' || tc.name === 'prune_context') return undefined;
    const archive = getContextArchive();
    if (!archive) return undefined;
    try {
      let inputSummary = '';
      try {
        inputSummary = JSON.stringify(tc.input ?? {}).slice(0, 140);
      } catch {
        /* unstringifiable input */
      }
      return await archive.record(
        sessionId,
        tc.name === 'bash' || tc.name === 'shell_manage' ? 'terminal' : 'tool_result',
        `${tc.name} ${inputSummary}`,
        toolResult.output ?? '',
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Replace stale/hidden tool outputs in the in-flight message array with tiny
   * stubs pointing at the archive. Frees the context window without losing
   * anything — the agent (or user) can always recover via fetch_context.
   */
  private async applyContextPruning(
    sessionId: string,
    messages: InternalMessage[],
    currentTurn: number,
  ): Promise<void> {
    const archive = getContextArchive();
    if (!archive) return;
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(this.workingDirectory);
    const KEEP_FULL_TURNS = settings.contextKeepRecentTurns ?? 3; // recent turns keep full outputs
    const MIN_PRUNE_CHARS = settings.contextPruneMinChars ?? 600; // tiny outputs aren't worth stubbing
    const autoPrune = settings.contextPruningEnabled !== false;
    for (const m of messages) {
      const meta = m as InternalMessage & {
        archiveId?: string;
        archiveTurn?: number;
        pruneApplied?: boolean;
      };
      if (m.role !== 'tool' || !meta.archiveId || meta.pruneApplied) continue;
      if (typeof m.content !== 'string') continue;
      const hiddenByUserOrAgent = await archive.isPrunedForAgent(sessionId, meta.archiveId);
      const stale =
        autoPrune &&
        typeof meta.archiveTurn === 'number' &&
        currentTurn - meta.archiveTurn > KEEP_FULL_TURNS &&
        m.content.length > MIN_PRUNE_CHARS;
      if (!hiddenByUserOrAgent && !stale) continue;
      const entry = await archive.get(sessionId, meta.archiveId);
      let original: Record<string, unknown> = {};
      try {
        original = JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        /* keep empty shell */
      }
      m.content = JSON.stringify({
        callId: original.callId ?? meta.tool_call_id,
        name: original.name,
        output: `[Output pruned to save context: ${entry?.label ?? 'tool output'}${entry ? ` at ${new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. Recover the exact content with fetch_context id=${meta.archiveId}]`,
        isError: false,
        durationMs: 0,
      });
      meta.pruneApplied = true;
    }
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
    const gated = await this.gateNoteToolCall(sessionId, tc);
    if (gated) return gated;
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }

  /**
   * Runs a worker (sub-agent). Invoked by WorkerPipelineService when the manager calls delegate_to_worker.
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
    const workerWorkingDirectory =
      allowedPaths[0] ?? (await this.resolveSessionWorkingDirectory(sessionId));
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
    let workerSystemPrompt = WORKER_SYSTEM_PROMPT;
    if (hasAnyVisibleNoteTools(this.workingDirectory)) {
      const hint = buildNotesNetworkSystemHint(this.workingDirectory);
      if (hint) workerSystemPrompt += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        workerSystemPrompt += await buildNotesNetworkPrompt(2500, this.workingDirectory);
      } catch {
        // Notes DB may be unavailable
      }
    }

    const thread: AgentThreadState = {
      sessionId,
      identity,
      kind: 'worker',
      status: 'thinking',
      providerName: provider.name,
      modelId,
      systemPrompt: workerSystemPrompt,
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
        // Include cached prompt tokens — they occupy the context window.
        usage.tokensIn = Math.max(usage.tokensIn, event.tokensIn + (event.tokensCache ?? 0));
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
    const gated = await this.gateNoteToolCall(sessionId, tc);
    if (gated) return gated;
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

  /** Re-baseline the session's context bar for a model the user just picked:
   *  emits (and persists) a usage snapshot with the new model's trusted
   *  window and the session's last-known occupancy. Backend stays the single
   *  source of truth — works for every provider and CLI. */
  async previewModelContext(sessionId: string, modelId: string, providerName: ProviderName) {
    const last = await getContextArchive()?.getLastUsage(sessionId);
    this.emitUsageUpdate(
      sessionId,
      KORY_IDENTITY.id,
      modelId,
      providerName,
      last?.used ?? 0,
      0,
      true,
      last?.breakdown,
    );
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

  private async loadHistory(sessionId: string): Promise<InternalMessage[]> {
    return (
      (await this.messages?.getRecent(sessionId, 10))
        // System rows are UI markers (e.g. "Stopped by user.") — never part of
        // the conversation sent back to the model.
        ?.filter((m) => m.role !== 'system')
        .map((m) => ({
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
        tools: filterToolDefsForNotesPermissions(
          this.tools.getToolDefsForRole(thread.toolRole),
          this.workingDirectory,
        ),
        maxTokens: thread.maxTokens,
        signal: streamSignal,
        workingDirectory: thread.ctx.workingDirectory,
        sessionId: thread.sessionId,
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
      } else if (event.type === 'thinking_delta') {
        // Workers reason too — without this branch their thinking text was
        // silently dropped and never reached the agent thread feed.
        if (event.thinking) {
          thread.status = 'thinking';
          thread.updatedAt = Date.now();
          this.emitWSMessage(thread.sessionId, 'stream.thinking', {
            agentId: thread.identity.id,
            thinking: event.thinking,
          } satisfies StreamThinkingPayload);
        }
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
  // Per-session project folders: a chat created with a project open runs in THAT
  // folder (tools, providers, workers), not the backend's launch directory.
  private sessionWorkingDirs = new Map<string, string>();

  private async resolveSessionWorkingDirectory(sessionId: string): Promise<string> {
    const cached = this.sessionWorkingDirs.get(sessionId);
    if (cached !== undefined) return cached;
    let resolved = this.workingDirectory;
    try {
      const session = await this.sessions?.get(sessionId);
      const wd = session?.workingDirectory?.trim();
      if (wd && existsSync(wd)) resolved = wd;
    } catch {
      /* fall back to the global root */
    }
    this.sessionWorkingDirs.set(sessionId, resolved);
    return resolved;
  }

  private emitUsageUpdate(
    sessionId: string,
    agentId: string,
    model: string,
    provider: ProviderName,
    tokensIn: number,
    tokensOut: number,
    usageKnown: boolean,
    breakdown?: ContextBreakdown,
  ) {
    this.events.emitUsageUpdate(
      sessionId,
      agentId,
      model,
      provider,
      tokensIn,
      tokensOut,
      usageKnown,
      breakdown,
    );
    // Persist the manager's latest snapshot so a reloaded session's context
    // bar has real data immediately (instead of waiting for the next turn).
    if (agentId === KORY_IDENTITY.id) {
      const win = resolveTrustedContextWindow(model, provider);
      void getContextArchive()?.recordUsage(sessionId, {
        used: tokensIn + tokensOut,
        max: win.contextWindow ?? 0,
        contextKnown: win.contextKnown,
        ...(breakdown ? { breakdown } : {}),
        ts: Date.now(),
      });
    }
  }
  private emitWSMessage(sessionId: string, type: string, payload: WSMessage['payload']) {
    this.events.emit(sessionId, type, payload);
  }
}

/** Character weight of a provider message list — feeds the context bar's
 *  "chat" segment estimate (images weighted as ~1k tokens' worth of chars). */
function estimateProviderMessagesChars(messages: ProviderMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text?.length ?? 0;
      else if (b.type === 'tool_use')
        chars += (b.toolName?.length ?? 0) + JSON.stringify(b.toolInput ?? {}).length;
      else if (b.type === 'tool_result') chars += b.toolOutput?.length ?? 0;
      else if (b.type === 'image') chars += 4000;
    }
  }
  return chars;
}
