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
import { detectJulesApiKey } from '../providers/auth-utils';
import { runJulesTask } from '../providers/jules-runner';
import { JULES_SYNC_INSTRUCTIONS, getProviderDisplay } from '../providers/provider-display';
import { ToolRegistry, type ToolCallInput, type ToolContext, type ToolCallOutput } from '../tools';
import { wsBroker } from '../pubsub';
import { koryLog } from '../logger';
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
        workingDirectory: this.workingDirectory,
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
            this.emitWSMessage(sessionId, 'stream.tool_result', {
              agentId: KORY_IDENTITY.id,
              toolResult,
            });
            executedAnyTool = true;
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

      const toPersist = stoppedByUser
        ? '[Stopped by user.]'
        : content || (emptyResponse ? EMPTY_NOTICE : '[Task completed using tools.]');
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
  ): Promise<LLMTurnResult> {
    if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');

    // Load agent settings to apply experimental overrides
    const { loadAgentSettings } = await import('../agent-settings');
    const settings = loadAgentSettings(this.workingDirectory);

    let systemPrompt = KORY_SYSTEM_PROMPT;

    if (hasAnyVisibleNoteTools(this.workingDirectory)) {
      const hint = buildNotesNetworkSystemHint(this.workingDirectory);
      if (hint) systemPrompt += `\n\n${hint}`;
      try {
        const { buildNotesNetworkPrompt } = await import('../memory/unified-memory');
        systemPrompt += await buildNotesNetworkPrompt(2500, this.workingDirectory);
      } catch {
        // Notes DB may be unavailable — continue without network context
      }
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

    const streamSignal = withTimeoutSignal(signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt,
        messages: this.toProviderMessages(messages),
        tools,
        maxTokens: 16384,
        signal: streamSignal,
        // Agentic CLI providers (claude-code) run + edit files in the project directory.
        workingDirectory: this.workingDirectory,
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

    for await (const event of stream) {
      if (signal?.aborted) throw new DOMException('Manager run aborted', 'AbortError');
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
        if (event.thinking) {
          this.emitWSMessage(sessionId, 'stream.thinking', {
            agentId: KORY_IDENTITY.id,
            thinking: event.thinking,
          } satisfies StreamThinkingPayload);
        }
      } else if (event.type === 'file_edit') {
        // Agentic provider (claude-code) already wrote the file — surface it in the live
        // diff preview (it's done, not a tool for us to execute).
        if (event.filePath) {
          this.streamAgentFileEdit(ctx, event.filePath, event.fileContent ?? '', event.fileOperation ?? 'edit', event.fileOldContent);
        }
      } else if (event.type === 'tool_executed') {
        // Agentic provider already ran a non-file tool — surface it in the tool feed.
        const callId = `agent-${nanoid(8)}`;
        this.emitWSMessage(sessionId, 'stream.tool_call', {
          agentId: KORY_IDENTITY.id,
          toolCall: { id: callId, name: event.toolName ?? 'tool', input: safeParseJson(event.toolInput) },
        });
        this.emitWSMessage(sessionId, 'stream.tool_result', {
          agentId: KORY_IDENTITY.id,
          toolResult: { callId, name: event.toolName ?? 'tool', output: event.toolOutput ?? '', isError: event.isError === true, durationMs: 0 },
        });
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
