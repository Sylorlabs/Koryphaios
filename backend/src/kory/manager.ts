// Kory Manager Agent — Refactored orchestrator using focused services
// The manager is the only agent the user talks to. Workers run only when explicitly delegated.

import type {
  ProviderName,
  KoryphaiosConfig,
  WorkerDomain,
  InternalMessage,
  LLMTurnResult,
} from "@koryphaios/shared";
import { sanitizeForPrompt } from "../security";
import { nanoid } from "nanoid";
import type { ISessionStore } from "../stores/session-store";
import type { IMessageStore } from "../stores/message-store";
import { GitManager } from "./git-manager";
import { WorkspaceManager } from "./workspace-manager";
import { AutoCommitService } from "./auto-commit-service";
import { getModeManager } from "../mode";
import type { ProviderRegistry } from "../providers";
import type { ToolRegistry, ToolContext } from "../tools";
import { koryLog } from "../logger";
import { AGENT, DOMAIN } from "../constants";
import { withTimeoutSignal, type Provider } from "../providers";
import type { KoryTask } from "./agent-lifecycle-manager";

// Import focused services
import {
  ClarificationService,
  RoutingService,
  SessionStateService,
  CriticReviewService,
  UserInteractionService,
  WorkerOrchestrationService,
  ConflictResolutionService,
  HumanInTheLoopService,
  AgentOpsService,
  MemoryManagerService,
  CostOptimizationService,
} from "./services";



let KORY_IDENTITY = {
  id: "kory-manager",
  name: "Kory",
  role: "manager" as const,
  model: "pending",
  provider: "copilot" as ProviderName,
  domain: "general" as WorkerDomain,
  glowColor: "rgba(255,215,0,0.6)",
};

/**
 * Refactored KoryManager using service decomposition
 * Each major responsibility is delegated to a focused service
 */
export class KoryManager {
  // Core dependencies
  private providers: ProviderRegistry;
  private tools: ToolRegistry;
  private workingDirectory: string;
  private config: KoryphaiosConfig;
  
  // State
  private isProcessing = false;
  private isYoloMode = false;
  private managerAbortBySession = new Map<string, AbortController>();
  
  // Services
  private clarificationService: ClarificationService;
  private routingService: RoutingService;
  private sessionState: SessionStateService;
  private criticService: CriticReviewService;
  private userInteraction: UserInteractionService;
  private workerOrchestration: WorkerOrchestrationService;
  
  // New services for improved functionality
  private conflictResolution: ConflictResolutionService;
  private humanInTheLoop: HumanInTheLoopService;
  private agentOps: AgentOpsService;
  private memoryManager: MemoryManagerService;
  private costOptimizer: CostOptimizationService;
  
  // Git and workspace
  public readonly git: GitManager;
  private workspaceManager: WorkspaceManager | null = null;
  private autoCommitService: AutoCommitService;

  constructor(
    providers: ProviderRegistry,
    tools: ToolRegistry,
    workingDirectory: string,
    config: KoryphaiosConfig,
    private sessions?: ISessionStore,
    private messages?: IMessageStore
  ) {
    this.providers = providers;
    this.tools = tools;
    this.workingDirectory = workingDirectory;
    this.config = config;
    
    // Initialize git and workspace
    this.git = new GitManager(workingDirectory);
    this.autoCommitService = new AutoCommitService(workingDirectory, this.git);
    
    try {
      if (this.git.isGitRepo()) {
        this.workspaceManager = new WorkspaceManager(workingDirectory, config.workspace);
      }
    } catch (err) {
      koryLog.warn({ error: err instanceof Error ? err.message : String(err) }, "WorkspaceManager unavailable");
    }
    
    // Initialize services
    this.clarificationService = new ClarificationService();
    this.routingService = new RoutingService(providers, config);
    this.sessionState = new SessionStateService(workingDirectory, sessions, messages);
    this.criticService = new CriticReviewService(providers, tools, workingDirectory, { fallbacks: config.fallbacks });
    this.userInteraction = new UserInteractionService();
    this.workerOrchestration = new WorkerOrchestrationService(
      providers,
      tools,
      workingDirectory,
      { fallbacks: config.fallbacks },
      this.routingService,
      this.userInteraction,
      this.sessionState,
      this.criticService,
      this.workspaceManager
    );
    
    // Initialize new services for improved functionality
    this.conflictResolution = new ConflictResolutionService(providers);
    this.humanInTheLoop = new HumanInTheLoopService();
    this.agentOps = new AgentOpsService(providers);
    this.memoryManager = new MemoryManagerService();
    this.costOptimizer = new CostOptimizationService(providers);
    
    koryLog.info("Manager initialized with new services: ConflictResolution, HITL, AgentOps, MemoryManager, CostOptimizer");
  }

  setYoloMode(enabled: boolean): void {
    this.isYoloMode = enabled;
    koryLog.info({ enabled }, "YOLO mode state updated");
  }

  handleUserInput(sessionId: string, selection: string, text?: string): void {
    this.userInteraction.handleInput(sessionId, selection, text);
  }

  async handleSessionResponse(sessionId: string, accepted: boolean): Promise<void> {
    if (accepted) {
      this.userInteraction.emitThought(sessionId, "synthesizing", "User accepted changes.");
    } else {
      this.userInteraction.emitThought(sessionId, "synthesizing", "User rejected changes. Rolling back...");
      const prevHash = this.sessionState.getCheckpoint(sessionId);
      if (prevHash && this.git.isGitRepo()) {
        this.git.rollback(prevHash);
      } else {
        await this.sessionState.restoreSnapshot(sessionId);
      }
    }
    this.sessionState.clearCheckpoint(sessionId);
    this.sessionState.clearChanges(sessionId);
  }

  async processTask(sessionId: string, userMessage: string, preferredModel?: string, reasoningLevel?: string): Promise<void> {
    this.isProcessing = true;
    this.sessionState.clearChanges(sessionId);
    const sanitizedMessage = sanitizeForPrompt(userMessage);

    // Resolve provider
    const { routing, provider } = await this.routingService.resolveProviderWithFallback(preferredModel, "general", true);
    
    if (!provider) {
      this.sessionState.updateWorkflowState(sessionId, "idle");
      this.userInteraction.emitError(sessionId, "No provider. Add a provider in Settings.");
      this.isProcessing = false;
      return;
    }

    this.sessionState.updateWorkflowState(sessionId, "analyzing");
    this.userInteraction.emitThought(sessionId, "analyzing", "Analyzing request...");

    try {
      await this.handleDirectly(sessionId, sanitizedMessage, provider, routing.model, reasoningLevel);
      this.sessionState.updateWorkflowState(sessionId, "idle");
      
      const changes = this.sessionState.getChanges(sessionId);
      if (changes.length > 0) {
        this.userInteraction.emitChanges(sessionId, changes);
        await this.handleAutoCommit(sessionId, userMessage);
      }
    } catch (err) {
      this.sessionState.updateWorkflowState(sessionId, "error");
      this.userInteraction.emitError(sessionId, `Error: ${String(err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async runWorkerPipeline(
    sessionId: string,
    task: string,
    preferredModel?: string,
    reasoningLevel?: string,
    domainHint?: string
  ): Promise<string> {
    this.sessionState.updateWorkflowState(sessionId, "executing");
    
    // Save checkpoint before worker runs
    if (this.git.isGitRepo()) {
      const hash = this.git.getCurrentHash();
      if (hash) this.sessionState.saveCheckpoint(sessionId, hash);
    } else {
      await this.sessionState.createSnapshot(sessionId, [this.workingDirectory]);
    }

    const result = await this.workerOrchestration.runWorkerPipeline(
      sessionId,
      task,
      preferredModel,
      reasoningLevel || this.routingService.getWorkerReasoningLevel(),
      domainHint,
      this.isYoloMode
    );

    this.sessionState.updateWorkflowState(sessionId, "idle");
    
    if (result.success) {
      await this.handleAutoCommit(sessionId, task);
      return result.criticFeedback ?? result.workerTranscript ?? "Done.";
    }
    return result.workerTranscript ?? "Worker failed.";
  }

  private async handleDirectly(
    sessionId: string,
    userMessage: string,
    provider: Provider,
    modelId: string,
    reasoningLevel?: string
  ): Promise<void> {
    const abort = new AbortController();
    this.managerAbortBySession.set(sessionId, abort);

    try {
      this.userInteraction.emitAgentStatus(sessionId, KORY_IDENTITY.id, "thinking");
      this.userInteraction.emitUsage(sessionId, KORY_IDENTITY.id, modelId, provider.name, 0, 0, false);

      const managerCtx: ToolContext = {
        sessionId,
        workingDirectory: this.workingDirectory,
        allowedPaths: [],
        isSandboxed: false,
        signal: abort.signal,
        waitForUserInput: (question: string, options: string[]) =>
          this.userInteraction.requestInput(sessionId, question, options),
        emitFileEdit: (e) => this.userInteraction.emitFileDelta(sessionId, KORY_IDENTITY.id, e),
        emitFileComplete: (e) => this.userInteraction.emitFileComplete(sessionId, KORY_IDENTITY.id, e),
        recordChange: (c) => this.sessionState.recordChange(sessionId, c),
        delegateToWorker: (task: string, domainHint?: string) =>
          this.runWorkerPipeline(sessionId, task, modelId, this.routingService.getWorkerReasoningLevel(), domainHint),
      };

      const messages: InternalMessage[] = [{ role: "user", content: userMessage }];
      let turnCount = 0;
      let firstAskForDirectTools = true;
      let stoppedByUser = false;

      while (turnCount < 25) {
        if (abort.signal.aborted) {
          stoppedByUser = true;
          break;
        }

        turnCount++;
        
        let result: LLMTurnResult;
        try {
          result = await this.processManagerTurn(sessionId, modelId, provider, messages, managerCtx);
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") {
            stoppedByUser = true;
            break;
          }
          throw err;
        }

        if (!result.success) break;

        const { completedToolCalls } = result;
        if (completedToolCalls && completedToolCalls.length > 0) {
          if (!this.isYoloMode && firstAskForDirectTools) {
            const selection = await this.userInteraction.requestInput(
              sessionId,
              "Manager will run tools to complete this task. Proceed?",
              ["Yes, proceed", "Cancel"]
            );
            firstAskForDirectTools = false;
            if (selection.includes("Cancel")) {
              await this.sessionState.persistMessage(sessionId, "assistant", "[Cancelled by user.]", modelId, provider.name);
              break;
            }
          }

          for (const tc of completedToolCalls) {
            if (abort.signal.aborted) {
              stoppedByUser = true;
              break;
            }
            const toolResult = await this.executeManagerToolCall(sessionId, tc, managerCtx);
            this.userInteraction.emitToolResult(sessionId, KORY_IDENTITY.id, toolResult);
            messages.push({ role: "tool", content: JSON.stringify(toolResult), tool_call_id: tc.id });
          }
        }
      }

      const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
      const content = (lastAssistant?.content ?? "").trim();
      const toPersist = stoppedByUser ? "[Stopped by user.]" : (content || "[Task completed using tools.]");
      
      await this.sessionState.persistMessage(sessionId, "assistant", toPersist, modelId, provider.name);
      this.userInteraction.emitAgentStatus(sessionId, KORY_IDENTITY.id, "done");
    } finally {
      this.managerAbortBySession.delete(sessionId);
      this.sessionState.updateWorkflowState(sessionId, "idle");
    }
  }

  private async processManagerTurn(
    sessionId: string,
    modelId: string,
    provider: Provider,
    messages: InternalMessage[],
    ctx: ToolContext
  ): Promise<LLMTurnResult> {
    if (ctx.signal?.aborted) throw new Error("Manager run aborted");
    
    const streamSignal = withTimeoutSignal(ctx.signal, AGENT.LLM_STREAM_TIMEOUT_MS);
    const stream = this.providers.executeWithRetry(
      {
        model: modelId,
        systemPrompt: `You are Kory, the manager agent. The user talks to you only. Sub-agents (workers) run only when you explicitly call delegate_to_worker—never automatically.

• Handle requests yourself: answer questions, use tools (read_file, grep, bash, web_search, etc.), do small edits.
• You may run terminals in the background using bash with isBackground: true.
• Sub-agents exist only for substantial implementation, refactoring, or multi-step coding.
• IMPORTANT: If you decide to delegate, call delegate_to_worker IMMEDIATELY without generating explanatory text first.`,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
          ...(m.tool_calls && { tool_calls: m.tool_calls }),
        })),
        tools: this.tools.getToolDefsForRole("manager"),
        maxTokens: 16384,
        signal: streamSignal,
      },
      provider.name
    );

    let assistantContent = "";
    const pendingToolCalls = new Map<string, { name: string; input: string }>();
    const completedToolCalls: LLMTurnResult["completedToolCalls"] = [];
    let hasToolCalls = false;
    let contentBuffer = "";

    for await (const event of stream) {
      if (ctx.signal?.aborted) throw new Error("Manager run aborted");
      
      if (event.type === "error") {
        throw new Error(event.error ?? "LLM stream error");
      }
      
      if (event.type === "content_delta") {
        assistantContent += event.content ?? "";
        contentBuffer += event.content ?? "";
      } else if (event.type === "tool_use_start") {
        hasToolCalls = true;
        pendingToolCalls.set(event.toolCallId!, { name: event.toolName!, input: "" });
        this.userInteraction.emitToolCall(sessionId, KORY_IDENTITY.id, { id: event.toolCallId!, name: event.toolName!, input: {} });
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
            // Malformed input defaults to empty
          }
          completedToolCalls.push({ id: event.toolCallId!, name: call.name, input: parsedInput });
          pendingToolCalls.delete(event.toolCallId!);
        }
      }
    }

    // Only emit content if not solely delegating to worker
    const isDelegationOnly = hasToolCalls &&
      completedToolCalls?.length === 1 &&
      completedToolCalls[0]?.name === "delegate_to_worker";
      
    if (!isDelegationOnly && contentBuffer) {
      this.userInteraction.emitStreamDelta(sessionId, KORY_IDENTITY.id, contentBuffer, modelId);
    }

    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: hasToolCalls && completedToolCalls?.length ? completedToolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })) : undefined,
    });

    if (hasToolCalls && completedToolCalls?.length) {
      return { success: true, content: assistantContent, completedToolCalls };
    }
    return { success: false, content: assistantContent };
  }

  private async executeManagerToolCall(
    sessionId: string,
    tc: { id: string; name: string; input: Record<string, unknown> },
    ctx: ToolContext
  ): Promise<unknown> {
    if (tc.name === "ask_user") {
      const question = (tc.input?.question as string) ?? "Proceed?";
      const options = (tc.input?.options as string[]) ?? ["Yes", "No"];
      const selection = await this.userInteraction.requestInput(sessionId, question, options);
      return { callId: tc.id, name: tc.name, output: `User selected: ${selection}`, isError: false, durationMs: 0 };
    }
    return await this.tools.execute(ctx, { id: tc.id, name: tc.name, input: tc.input });
  }

  private async handleAutoCommit(sessionId: string, taskDescription: string): Promise<void> {
    try {
      const modeManager = getModeManager();
      if (modeManager.getMode() !== "beginner" || !modeManager.shouldAutoCommit()) return;
      if (!this.git.isGitRepo()) return;

      koryLog.info({ sessionId }, "Auto-committing changes for beginner mode");
      const result = await this.autoCommitService.autoCommitAndCreatePR(taskDescription);

      if (result.success) {
        this.userInteraction.emitWSMessage?.(sessionId, "system.notification", {
          type: "success",
          title: "Changes Saved",
          message: result.prUrl
            ? `✨ I've saved your work and created a pull request: ${result.prUrl}`
            : `✨ I've saved your work to branch "${result.branch}"`,
          metadata: { branch: result.branch, commitHash: result.commitHash, prUrl: result.prUrl },
        });
      }
    } catch (error) {
      koryLog.error({ sessionId, error: error instanceof Error ? error.message : String(error) }, "Auto-commit error");
    }
  }

  cancel(): void {
    this.workerOrchestration.cancelAll();
    for (const [, abort] of this.managerAbortBySession) {
      abort.abort();
    }
    this.managerAbortBySession.clear();
  }

  cancelSessionWorkers(sessionId: string): void {
    this.workerOrchestration.cancelSessionWorkers(sessionId);
    const abort = this.managerAbortBySession.get(sessionId);
    if (abort) {
      abort.abort();
      this.managerAbortBySession.delete(sessionId);
    }
  }

  /**
   * Cancel a specific worker by ID
   */
  cancelWorker(workerId: string): void {
    this.workerOrchestration.cancelWorker(workerId);
  }

  /**
   * Get status of all active workers
   */
  getStatus(): Array<{ id: string; agent: import("@koryphaios/shared").AgentIdentity; status: import("@koryphaios/shared").AgentStatus; sessionId: string }> {
    return this.workerOrchestration.getStatus();
  }

  isSessionRunning(sessionId: string): boolean {
    return this.managerAbortBySession.has(sessionId);
  }

  /**
   * Get memory and resource statistics
   */
  getMemoryStats(): {
    activeWorkers: number;
    pendingUserInputs: number;
  } {
    return {
      activeWorkers: this.workerOrchestration.getStatus().length,
      pendingUserInputs: this.userInteraction.getPendingInputCount?.() ?? 0,
    };
  }

  /**
   * Cleanup abandoned resources (workers that have been running too long)
   */
  cleanupAbandonedResources(maxSessionAgeMs = 30 * 60 * 1000): void {
    const now = Date.now();
    const workers = this.workerOrchestration.getStatus();
    
    for (const worker of workers) {
      // Workers are cleaned up automatically by the orchestration service
      // This method exists for API compatibility with background-cleanup
      koryLog.debug({ workerId: worker.id }, "Checking worker for cleanup");
    }
  }

  /**
   * Cleanup session resources
   */
  cleanupSession(sessionId: string): void {
    this.userInteraction.cleanupSession?.(sessionId);
    this.sessionState.cleanupSession?.(sessionId);
    koryLog.debug({ sessionId }, "Session cleanup completed");
  }

  /**
   * Resolve active routing for a domain
   */
  resolveActiveRouting(preferredModel?: string, domain: string = "general"): { model: string; provider?: string } {
    return this.routingService.resolveActiveRouting(preferredModel, domain as any);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW SERVICE METHODS - Conflict Resolution
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a file change for conflict tracking
   */
  registerFileChange(change: import("./services").FileChange): void {
    this.conflictResolution.registerChange(change);
  }

  /**
   * Detect and resolve file conflicts across workers
   */
  async resolveConflicts(): Promise<import("./services").ResolutionResult> {
    return this.conflictResolution.resolveConflicts();
  }

  /**
   * Get pending file conflicts
   */
  getPendingConflicts(): import("./services").Conflict[] {
    return this.conflictResolution.detectConflicts();
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW SERVICE METHODS - Human-in-the-Loop
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Request human approval for a high-risk operation
   */
  async requestApproval(
    operation: Omit<import("./services").Operation, "id" | "requestedAt">
  ): Promise<import("./services").ApprovalDecision> {
    return this.humanInTheLoop.requestApproval(operation);
  }

  /**
   * Submit human decision for an approval request
   */
  submitApprovalDecision(operationId: string, approved: boolean, reason?: string): boolean {
    return this.humanInTheLoop.submitDecision(operationId, approved, reason);
  }

  /**
   * Get pending approval requests
   */
  getPendingApprovals(sessionId?: string): import("./services").ApprovalRequest[] {
    return this.humanInTheLoop.getPendingApprovals(sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW SERVICE METHODS - AgentOps
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Register a new prompt version
   */
  registerPromptVersion(
    prompt: Omit<import("./services").PromptVersion, "id" | "createdAt">
  ): import("./services").PromptVersion {
    return this.agentOps.registerPrompt(prompt);
  }

  /**
   * Create an A/B test experiment
   */
  createExperiment(
    experiment: Omit<import("./services").Experiment, "id" | "status" | "metrics" | "statisticalSignificance">
  ): import("./services").Experiment {
    return this.agentOps.createExperiment(experiment);
  }

  /**
   * Run evaluation on a prompt version
   */
  async evaluatePrompt(
    promptVersionId: string, 
    datasetId: string
  ): Promise<import("./services").EvaluationResult> {
    return this.agentOps.runEvaluation(promptVersionId, datasetId);
  }

  /**
   * Run a simulation scenario
   */
  async runSimulation(
    scenario: import("./services").SimulationScenario,
    promptVersionId: string
  ): Promise<import("./services").SimulationResult> {
    return this.agentOps.runSimulation(scenario, promptVersionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW SERVICE METHODS - Memory Management
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Store a memory entry
   */
  async storeMemory(
    entry: Omit<import("./services").MemoryEntry, "id" | "timestamp" | "accessCount" | "lastAccessed">
  ): Promise<import("./services").MemoryEntry> {
    return this.memoryManager.store(entry);
  }

  /**
   * Retrieve relevant memories
   */
  async retrieveMemories(
    query: import("./services").MemoryQuery
  ): Promise<import("./services").MemorySearchResult[]> {
    return this.memoryManager.retrieve(query);
  }

  /**
   * Get context window for a session
   */
  async getContextWindow(sessionId: string, maxTokens?: number): Promise<string> {
    return this.memoryManager.getContextWindow(sessionId, maxTokens);
  }

  /**
   * Create conversation summary
   */
  async createConversationSummary(sessionId: string): Promise<import("./services").ConversationSummary> {
    return this.memoryManager.createSummary(sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEW SERVICE METHODS - Cost Optimization
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get optimal model routing for a task
   */
  async routeTask(
    prompt: string,
    preferredModel?: string,
    forceModel?: boolean
  ): Promise<import("./services").RoutingDecision> {
    return this.costOptimizer.routeTask(prompt, preferredModel, forceModel);
  }

  /**
   * Check response cache
   */
  async checkCache(query: string): Promise<import("./services").CachedResponse | undefined> {
    return this.costOptimizer.checkCache(query);
  }

  /**
   * Get budget status
   */
  getBudgetStatus(): ReturnType<CostOptimizationService["getBudgetStatus"]> {
    return this.costOptimizer.getBudgetStatus();
  }

  /**
   * Get cost analytics
   */
  getCostAnalytics(days?: number): ReturnType<CostOptimizationService["getAnalytics"]> {
    return this.costOptimizer.getAnalytics(days);
  }

  /**
   * Record usage for budget tracking
   */
  recordUsage(cost: number, tokensIn: number, tokensOut: number): void {
    this.costOptimizer.recordUsage(cost, tokensIn, tokensOut);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // UTILITY METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get service statistics
   */
  getServiceStats(): {
    conflictResolution: { pendingChanges: number };
    humanInTheLoop: { pendingApprovals: number };
    memoryManager: { shortTermSize: number };
    costOptimizer: ReturnType<CostOptimizationService["getCacheStats"]> & { budget: ReturnType<CostOptimizationService["getBudgetStatus"]> };
  } {
    return {
      conflictResolution: {
        pendingChanges: this.conflictResolution.getAllChanges().size,
      },
      humanInTheLoop: {
        pendingApprovals: this.humanInTheLoop.getPendingApprovals().length,
      },
      memoryManager: {
        shortTermSize: 0, // Would need to expose this from MemoryManagerService
      },
      costOptimizer: {
        ...this.costOptimizer.getCacheStats(),
        budget: this.costOptimizer.getBudgetStatus(),
      },
    };
  }

  /**
   * Cleanup all resources
   */
  destroy(): void {
    this.cancel();
    this.conflictResolution.clearChanges();
    this.humanInTheLoop.destroy();
    this.memoryManager.destroy();
    koryLog.info("Manager destroyed and all resources cleaned up");
  }
}

// Re-export types for backward compatibility
export type { KoryTask } from "./agent-lifecycle-manager";
